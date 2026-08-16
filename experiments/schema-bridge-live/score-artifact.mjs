#!/usr/bin/env node

import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { canonicalJson, sha256 } from '../../src/core.mjs'
import {
  buildSchemaBridgePlan,
  SCHEMA_BRIDGE_ARM_IDS,
  SCHEMA_BRIDGE_CLASSIFIER_SHA256,
  SCHEMA_BRIDGE_IDENTITIES,
  SCHEMA_BRIDGE_ORACLE_SHA256,
  schemaBridgeArtifactIntegritySha256,
  schemaBridgePilotGate,
  validateSchemaBridgeObservation,
  validateSchemaBridgeOracle,
  validateSchemaBridgePlan,
  validateSchemaBridgePrompts,
} from '../../src/schema-bridge-live.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const PROMPTS_PATH = join(PACKAGE_ROOT, 'experiments', 'schema-bridge-live', 'prompts.json')
const CLASSIFIER_PATH = fileURLToPath(new URL('./classifier.mjs', import.meta.url))
const LABELS = Object.freeze(['minimal-like', 'standard-like', 'ambiguous'])
const ARM_INDEX = Object.freeze({ pp: 0, po: 1, op: 2, oo: 3 })

if (createHash('sha256').update(readFileSync(CLASSIFIER_PATH)).digest('hex') !== SCHEMA_BRIDGE_CLASSIFIER_SHA256) {
  throw new Error('scorer classifier bytes do not match the frozen modeltest@04255b5 SHA-256')
}
const { classifyReasoning } = await import('./classifier.mjs')

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function exactKeys(value, expected, path) {
  if (!plainObject(value)) throw new Error(`${path} must be an object`)
  if (canonicalJson(Object.keys(value).sort()) !== canonicalJson([...expected].sort())) {
    throw new Error(`${path} contains missing or non-allowlisted fields`)
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message)
}

function mean(values) {
  const finite = values.filter(value => Number.isFinite(value))
  return finite.length === 0 ? null : finite.reduce((sum, value) => sum + value, 0) / finite.length
}

function total(values) {
  const finite = values.filter(value => Number.isFinite(value))
  return finite.length === 0 ? null : finite.reduce((sum, value) => sum + value, 0)
}

function quantile(sorted, probability) {
  const index = (sorted.length - 1) * probability
  const lower = Math.floor(index)
  const upper = Math.ceil(index)
  if (lower === upper) return sorted[lower]
  return sorted[lower] * (upper - index) + sorted[upper] * (index - lower)
}

function makeRandom(seed) {
  let state = createHash('sha256').update(seed).digest().readUInt32LE(0)
  return () => {
    state = (state + 0x6d2b79f5) >>> 0
    let value = state
    value = Math.imul(value ^ (value >>> 15), value | 1)
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61)
    return ((value ^ (value >>> 14)) >>> 0) / 0x1_0000_0000
  }
}

function shuffled(values, random) {
  const result = [...values]
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    ;[result[index], result[swap]] = [result[swap], result[index]]
  }
  return result
}

function shuffledFour(values, random) {
  assert(values.length === 4, 'internal four-cell shuffle received the wrong length')
  return shuffled(values, random)
}

function contrasts(means) {
  const [pp, po, op, oo] = means
  return {
    D: 0.5 * ((op + oo) - (pp + po)),
    Q: 0.5 * ((po + oo) - (pp + op)),
    I: oo - op - po + pp,
    OPminusPO: op - po,
  }
}

function rotate(values, count) {
  return [...values.slice(count), ...values.slice(0, count)]
}

function latinWithinTaskPermutation(taskClusters, observed, draws, seed) {
  const random = makeRandom(`${seed}\0permutation`)
  const extreme = { D: 0, Q: 0, I: 0, OPminusPO: 0 }
  for (let draw = 0; draw < draws; draw += 1) {
    const sums = [0, 0, 0, 0]
    for (const cluster of taskClusters) {
      const base = shuffledFour(SCHEMA_BRIDGE_ARM_IDS, random)
      cluster.positional.forEach((outcomes, identityIndex) => {
        const assignment = rotate(base, identityIndex)
        for (let position = 0; position < 4; position += 1) {
          sums[ARM_INDEX[assignment[position]]] += outcomes[position]
        }
      })
    }
    const candidate = contrasts(sums.map(sum => sum / (taskClusters.length * 4)))
    for (const key of Object.keys(extreme)) {
      if (Math.abs(candidate[key]) >= Math.abs(observed[key]) - 1e-12) extreme[key] += 1
    }
  }
  return Object.fromEntries(Object.entries(extreme).map(([key, count]) => [key, (count + 1) / (draws + 1)]))
}

function taskClusterBootstrap(taskClusters, draws, seed) {
  const random = makeRandom(`${seed}\0bootstrap`)
  const samples = { D: [], Q: [], I: [], OPminusPO: [] }
  for (let draw = 0; draw < draws; draw += 1) {
    const sums = [0, 0, 0, 0]
    for (let index = 0; index < taskClusters.length; index += 1) {
      const selected = taskClusters[Math.floor(random() * taskClusters.length)]
      for (let arm = 0; arm < 4; arm += 1) sums[arm] += selected.armSums[arm]
    }
    const candidate = contrasts(sums.map(sum => sum / (taskClusters.length * 4)))
    for (const key of Object.keys(samples)) samples[key].push(candidate[key])
  }
  return Object.fromEntries(Object.entries(samples).map(([key, values]) => {
    values.sort((left, right) => left - right)
    return [key, { low: quantile(values, 0.025), high: quantile(values, 0.975) }]
  }))
}

function holm(raw, alpha = 0.05) {
  const ordered = Object.entries(raw).sort((left, right) => left[1] - right[1])
  const adjusted = {}
  const rejected = {}
  let running = 0
  let stillRejecting = true
  ordered.forEach(([key, value], index) => {
    running = Math.max(running, Math.min(1, value * (ordered.length - index)))
    adjusted[key] = running
    const passes = stillRejecting && value <= alpha / (ordered.length - index)
    rejected[key] = passes
    if (!passes) stillRejecting = false
  })
  return { adjusted, rejected }
}

function parsedArguments(block) {
  if (typeof block?.arguments?.text !== 'string') return { valid: false, value: null }
  try {
    const value = JSON.parse(block.arguments.text)
    return { valid: plainObject(value), value }
  } catch {
    return { valid: false, value: null }
  }
}

function validOptionalTypes(value, types) {
  return Object.entries(types).every(([key, type]) => value[key] === undefined
    || (type === 'integer' ? Number.isInteger(value[key]) : typeof value[key] === type))
}

function validBashArguments(value, parameterFactor) {
  if (!plainObject(value) || typeof value.command !== 'string') return false
  if (parameterFactor === 'p') return true
  if (typeof value.description !== 'string') return false
  if (!validOptionalTypes(value, {
    timeoutMs: 'number', workdir: 'string', run_in_background: 'boolean',
    sandbox_permissions: 'string', justification: 'string',
  })) return false
  return value.sandbox_permissions === undefined
    || ['workspace-write', 'danger-full-access'].includes(value.sandbox_permissions)
}

function validEditorArguments(value) {
  if (!plainObject(value) || !['view', 'create', 'str_replace', 'insert'].includes(value.command)
    || typeof value.path !== 'string') return false
  return validOptionalTypes(value, {
    file_text: 'string', insert_line: 'integer', new_str: 'string', old_str: 'string',
  }) && (value.view_range === undefined
    || (Array.isArray(value.view_range) && value.view_range.every(Number.isInteger)))
}

function trajectory(item) {
  const assistant = item.record.runtime.assistantMessages[0]
  const blocks = assistant.blocks
  const firstToolIndex = blocks.findIndex(block => block.type === 'tool-call')
  const reasoning = blocks.filter(block => block.type === 'reasoning').map(block => block.text).join('')
  const visibleBeforeTool = blocks.slice(0, firstToolIndex < 0 ? blocks.length : firstToolIndex)
    .some(block => block.type === 'text' && block.text.trim() !== '')
  const classification = classifyReasoning(reasoning, visibleBeforeTool)
  const toolBlocks = blocks.filter(block => block.type === 'tool-call')
  const toolFacts = toolBlocks.map(block => {
    const parsed = parsedArguments(block)
    const nameValid = ['bash', 'str_replace_editor'].includes(block.name)
    const argumentsValid = parsed.valid && (block.name === 'bash'
      ? validBashArguments(parsed.value, item.arm[1])
      : block.name === 'str_replace_editor' ? validEditorArguments(parsed.value) : false)
    return { nameValid, argumentsValid }
  })
  const usage = assistant.usage ?? {}
  const promptTokens = Number.isFinite(usage.inputTokens) && Number.isFinite(usage.cacheReadTokens)
    ? usage.inputTokens + usage.cacheReadTokens
    : Number.isFinite(usage.inputTokens) ? usage.inputTokens : null
  return {
    block: item.block,
    taskId: item.taskId,
    identity: item.identity,
    position: item.position,
    arm: item.arm,
    minimal: classification.label === 'minimal-like' ? 1 : 0,
    label: classification.label,
    startsWeNeed: /^we need\b/i.test(reasoning.trim()),
    startsLetMe: /^let me\b/i.test(reasoning.trim()),
    toolCount: toolBlocks.length,
    toolNamesValid: toolFacts.every(fact => fact.nameValid),
    argumentsValid: toolFacts.every(fact => fact.argumentsValid),
    promptTokens,
    reasoningTokens: Number.isFinite(usage.reasoningTokens) ? usage.reasoningTokens : null,
    outputTokens: Number.isFinite(usage.outputTokens) ? usage.outputTokens : null,
  }
}

function validateCapturedText(capture, path, requireText = false) {
  assert(plainObject(capture) && typeof capture.sha256 === 'string'
    && Number.isInteger(capture.chars) && capture.chars >= 0, `${path} capture metadata is invalid`)
  if (requireText) assert(typeof capture.text === 'string', `${path} must retain trajectory text`)
  if (capture.text !== undefined) {
    assert(typeof capture.text === 'string' && capture.chars === capture.text.length
      && capture.sha256 === sha256(capture.text), `${path} text/hash/chars mismatch`)
  }
}

function validateItem(item, unit, oracle, expectedPromptChars) {
  const unitKeys = unit.phase === 'pilot'
    ? ['unitId', 'sequence', 'phase', 'identity', 'promptId', 'promptSha256', 'position', 'arm', 'strategy']
    : ['unitId', 'sequence', 'phase', 'blockId', 'block', 'identity', 'taskId', 'language', 'promptSha256', 'position', 'arm', 'strategy']
  exactKeys(item, [...unitKeys, 'prompt', 'status', 'validation', 'record'], `artifact item ${unit.unitId}`)
  for (const key of unitKeys) {
    assert(canonicalJson(item[key]) === canonicalJson(unit[key]), `artifact item ${unit.unitId}.${key} drifted from plan`)
  }
  exactKeys(item.prompt, ['sha256', 'chars'], `artifact item ${unit.unitId}.prompt`)
  assert(item.prompt.sha256 === unit.promptSha256 && item.prompt.chars === expectedPromptChars,
    `artifact item ${unit.unitId} prompt binding is invalid`)
  const recomputed = validateSchemaBridgeObservation(item.record, unit, oracle)
  assert(recomputed.accepted === true && item.status === 'accepted', `artifact item ${unit.unitId} is not accepted`)
  assert(canonicalJson(item.validation) === canonicalJson(recomputed), `artifact item ${unit.unitId} validation drifted`)
  const assistantCalls = item.record.runtime.assistantMessages[0].blocks.filter(block => block.type === 'tool-call')
  const eventCalls = item.record.runtime.toolCalls
  item.record.runtime.assistantMessages[0].blocks.forEach((block, index) => {
    if (block.type === 'text' || block.type === 'reasoning') {
      validateCapturedText(block, `artifact item ${unit.unitId} assistant block ${index}`, true)
    } else if (block.type === 'tool-call') {
      validateCapturedText(block.arguments, `artifact item ${unit.unitId} assistant tool arguments ${index}`, true)
    }
  })
  eventCalls.forEach((call, index) => validateCapturedText(
    call.arguments, `artifact item ${unit.unitId} tool/call arguments ${index}`, true,
  ))
  assert(assistantCalls.length === eventCalls.length, `artifact item ${unit.unitId} tool-call event count drifted`)
  assistantCalls.forEach((block, index) => {
    assert(block.id === eventCalls[index].callId && block.name === eventCalls[index].name
      && block.arguments?.sha256 === eventCalls[index].arguments?.sha256,
    `artifact item ${unit.unitId} tool-call event binding drifted`)
  })
  const results = item.record.runtime.toolResults
  assert(results.length === eventCalls.length, `artifact item ${unit.unitId} tool/result count drifted`)
  results.forEach((result, index) => {
    assert(result.callId === eventCalls[index].callId
      && result.error?.code === 'ABORTED_BEFORE_DISPATCH', `artifact item ${unit.unitId} tool/result binding drifted`)
    result.blocks.forEach((block, blockIndex) => {
      if (block.type === 'text' || block.type === 'reasoning') {
        validateCapturedText(block, `artifact item ${unit.unitId} tool/result block ${blockIndex}`)
      }
    })
  })
  return item
}

function validateCompletedArtifact(artifact, oracle, prompts) {
  exactKeys(artifact, [
    'schemaVersion', 'mode', 'protocol', 'status', 'createdAt', 'credentialMode',
    'rawArtifactPublication', 'privateRuntimeHomesRemoved', 'privateProtocolSnapshotRemoved',
    'oracleSha256', 'promptSetSha256',
    'researchCommit', 'classifier',
    'route', 'design', 'plan', 'preflight', 'progress', 'pilotGate', 'pilot',
    'samples', 'stopReason', 'finishedAt', 'integritySha256',
  ], 'artifact')
  assert(artifact.schemaVersion === 1 && artifact.mode === 'schema-bridge-live'
    && artifact.protocol === oracle.protocol && artifact.status === 'completed', 'artifact is not a completed schema bridge run')
  assert(artifact.privateRuntimeHomesRemoved === true, 'artifact does not prove removal of private runtime homes')
  assert(artifact.privateProtocolSnapshotRemoved === true, 'artifact does not prove removal of the private protocol snapshot')
  assert(artifact.credentialMode === 'hidden TTY/readSecret to child stdin only; never argv/environment/artifact'
    && artifact.rawArtifactPublication === 'forbidden; score with the publication-allowlisted scorer'
    && artifact.stopReason === 'Fixed pilot and all 160 main units completed; no retry or replacement was used.',
  'artifact terminal protocol declarations drifted')
  const createdAt = Date.parse(artifact.createdAt)
  const finishedAt = Date.parse(artifact.finishedAt)
  assert(Number.isFinite(createdAt) && Number.isFinite(finishedAt) && finishedAt >= createdAt,
    'artifact lifecycle timestamps are invalid')
  assert(artifact.integritySha256 === schemaBridgeArtifactIntegritySha256(artifact), 'artifact canonical integrity SHA-256 mismatch')
  assert(artifact.oracleSha256 === SCHEMA_BRIDGE_ORACLE_SHA256
    && artifact.promptSetSha256 === oracle.prompts.setCanonicalSha256, 'artifact oracle/prompt binding drifted')
  assert(typeof artifact.researchCommit === 'string' && /^[0-9a-f]{40}$/.test(artifact.researchCommit),
    'artifact research commit is invalid')
  assert(canonicalJson(artifact.classifier) === canonicalJson(oracle.classifier)
    && artifact.classifier.sha256 === SCHEMA_BRIDGE_CLASSIFIER_SHA256, 'artifact classifier binding drifted')
  assert(canonicalJson(artifact.route) === canonicalJson(oracle.artifactBinding), 'artifact route binding drifted')
  assert(canonicalJson(artifact.design) === canonicalJson(oracle.design), 'artifact design binding drifted')
  validateSchemaBridgePlan(artifact.plan, oracle, prompts)
  const expectedPlan = buildSchemaBridgePlan(prompts, oracle)
  assert(canonicalJson(artifact.plan) === canonicalJson(expectedPlan), 'artifact plan differs from the frozen seed-derived plan')
  exactKeys(artifact.preflight, ['completedBeforeCredentialRead', 'realDshMounts'], 'artifact.preflight')
  assert(artifact.preflight.completedBeforeCredentialRead === true
    && Array.isArray(artifact.preflight.realDshMounts) && artifact.preflight.realDshMounts.length === 4,
  'artifact keyless mount preflight is incomplete')
  const mountStrategies = []
  for (let index = 0; index < artifact.preflight.realDshMounts.length; index += 1) {
    const mount = artifact.preflight.realDshMounts[index]
    exactKeys(mount, ['strategy', 'accepted', 'checks', 'surface'], `artifact.preflight.realDshMounts[${index}]`)
    exactKeys(mount.checks, [
      'process', 'mode', 'platform', 'harnessCommit', 'system', 'toolOrder', 'rawSchemas', 'environment', 'launcher',
      'protocolClosure',
    ], `artifact.preflight.realDshMounts[${index}].checks`)
    assert(mount.accepted === true && Object.values(mount.checks).every(value => value === true),
      `artifact preflight mount ${index} did not pass every fixed check`)
    exactKeys(mount.surface, [
      'harnessCommit', 'launcherMode', 'protocolClosureSha256', 'platform', 'systemRawSha256',
      'orderedToolNames', 'toolSchemaRawSha256',
    ], `artifact.preflight.realDshMounts[${index}].surface`)
    assert(mount.surface.harnessCommit === oracle.artifactBinding.harnessCommit
      && mount.surface.launcherMode === oracle.artifactBinding.launcherMode
      && mount.surface.protocolClosureSha256 === oracle.artifactBinding.protocolClosureSha256
      && mount.surface.platform === oracle.artifactBinding.platform
      && mount.surface.systemRawSha256 === oracle.surface.systemRawSha256
      && canonicalJson(mount.surface.orderedToolNames) === canonicalJson(oracle.surface.orderedToolNames)
      && canonicalJson(mount.surface.toolSchemaRawSha256) === canonicalJson(oracle.surface.toolSchemaRawSha256[mount.strategy]),
    `artifact preflight mount ${index} surface facts drifted`)
    mountStrategies.push(mount.strategy)
  }
  assert(canonicalJson(mountStrategies) === canonicalJson([
    'schema-bridge-pp', 'schema-bridge-po', 'schema-bridge-op', 'schema-bridge-oo',
  ]), 'artifact preflight mounts do not cover the frozen arm order')
  assert(Array.isArray(artifact.pilot) && artifact.pilot.length === 4, 'artifact pilot count must be four')
  assert(Array.isArray(artifact.samples) && artifact.samples.length === 160, 'artifact main count must be 160')
  const pilot = artifact.pilot.map((item, index) => validateItem(
    item, expectedPlan.pilot[index], oracle, prompts.pilot.text.length,
  ))
  const expectedMain = expectedPlan.blocks.flatMap(block => block.allocation)
  const promptChars = new Map(prompts.tasks.map(prompt => [prompt.id, prompt.text.length]))
  const samples = artifact.samples.map((item, index) => validateItem(
    item, expectedMain[index], oracle, promptChars.get(expectedMain[index].taskId),
  ))
  const gate = schemaBridgePilotGate(pilot)
  assert(gate.passed === true && canonicalJson(artifact.pilotGate) === canonicalJson(gate), 'artifact pilot gate drifted')

  exactKeys(artifact.progress, [
    'plannedUnits', 'attemptedUnits', 'observedRequestHeaders', 'acceptedUnits', 'abortedUnits',
  ], 'artifact.progress')
  assert(canonicalJson(artifact.progress) === canonicalJson({
    plannedUnits: 164, attemptedUnits: 164, observedRequestHeaders: 164,
    acceptedUnits: 164, abortedUnits: 0,
  }), 'artifact progress totals drifted')

  const all = [...pilot, ...samples]
  const identityMap = new Map()
  const distinctHomes = new Set()
  const sessions = new Set()
  const runIds = new Set()
  const strategyDigests = new Set()
  for (const item of all) {
    assert(item.record.run.config.strategyCommit === artifact.researchCommit,
      'artifact item strategy commit differs from the frozen research commit')
    const homeHash = item.record.run.anonymousUserIdSha256
    const previous = identityMap.get(item.identity)
    if (previous === undefined) identityMap.set(item.identity, homeHash)
    else assert(previous === homeHash, `anonymous runtime home drifted for ${item.identity}`)
    distinctHomes.add(homeHash)
    const session = item.record.runtime.sessionIdSha256
    assert(!sessions.has(session), 'artifact contains a duplicate session')
    sessions.add(session)
    const runId = item.record.run.id
    assert(typeof runId === 'string' && !runIds.has(runId), 'artifact contains a duplicate or invalid run id')
    runIds.add(runId)
    const strategyDigest = item.record.run.config.strategyFilesSha256
    assert(typeof strategyDigest === 'string' && /^[0-9a-f]{64}$/.test(strategyDigest),
      'artifact item strategy source digest is invalid')
    strategyDigests.add(strategyDigest)
  }
  assert(identityMap.size === SCHEMA_BRIDGE_IDENTITIES.length && distinctHomes.size === 4,
    'artifact must prove four distinct fixed anonymous runtime homes')
  assert([...identityMap.keys()].every(identity => all.filter(item => item.identity === identity).length === 41),
    'each fixed runtime home must contribute one pilot and forty main units')
  assert(sessions.size === 164 && runIds.size === 164, 'artifact session/run uniqueness is incomplete')
  assert(strategyDigests.size === 1, 'artifact strategy source digest drifted between units')
  return samples
}

function aggregate(rows) {
  const labels = Object.fromEntries(LABELS.map(label => [label, rows.filter(row => row.label === label).length]))
  const minimal = labels['minimal-like']
  const withTools = rows.filter(row => row.toolCount > 0)
  return {
    n: rows.length,
    labels,
    minimalLikeRate: minimal / rows.length,
    startsWeNeed: rows.filter(row => row.startsWeNeed).length,
    startsLetMe: rows.filter(row => row.startsLetMe).length,
    tools: {
      total: rows.reduce((sum, row) => sum + row.toolCount, 0),
      trajectoriesWithAny: withTools.length,
      namesValidAmongTrajectoriesWithAny: withTools.filter(row => row.toolNamesValid).length,
      argumentsValidAmongTrajectoriesWithAny: withTools.filter(row => row.argumentsValid).length,
    },
    tokens: {
      prompt: { reported: rows.filter(row => row.promptTokens !== null).length, total: total(rows.map(row => row.promptTokens)), mean: mean(rows.map(row => row.promptTokens)) },
      reasoning: { reported: rows.filter(row => row.reasoningTokens !== null).length, total: total(rows.map(row => row.reasoningTokens)), mean: mean(rows.map(row => row.reasoningTokens)) },
      output: { reported: rows.filter(row => row.outputTokens !== null).length, total: total(rows.map(row => row.outputTokens)), mean: mean(rows.map(row => row.outputTokens)) },
    },
  }
}

/** Strictly validate and score a raw artifact, returning only publication-safe aggregates. */
export function scoreSchemaBridgeArtifact(artifactInput, oracleInput, promptInput) {
  const oracle = validateSchemaBridgeOracle(oracleInput)
  const prompts = validateSchemaBridgePrompts(promptInput, oracle)
  const samples = validateCompletedArtifact(artifactInput, oracle, prompts)
  const rows = samples.map(trajectory)
  const taskClusters = prompts.tasks.map(prompt => {
    const taskRows = rows.filter(row => row.taskId === prompt.id)
    assert(taskRows.length === 16, `task ${prompt.id} does not contain sixteen observations`)
    const positional = SCHEMA_BRIDGE_IDENTITIES.map(identity => {
      const scoped = taskRows.filter(row => row.identity === identity).sort((left, right) => left.position - right.position)
      assert(scoped.length === 4 && scoped.every((row, index) => row.position === index + 1),
        `task ${prompt.id} runtime-home block is incomplete`)
      return scoped.map(row => row.minimal)
    })
    const armSums = SCHEMA_BRIDGE_ARM_IDS.map(arm => taskRows.filter(row => row.arm === arm)
      .reduce((sum, row) => sum + row.minimal, 0))
    return { positional, armSums }
  })
  const armMeans = SCHEMA_BRIDGE_ARM_IDS.map(arm => {
    const scoped = rows.filter(row => row.arm === arm)
    return scoped.reduce((sum, row) => sum + row.minimal, 0) / scoped.length
  })
  const observed = contrasts(armMeans)
  const permutation = latinWithinTaskPermutation(taskClusters, observed, oracle.design.permutationDraws, oracle.design.analysisSeed)
  const bootstrap = taskClusterBootstrap(taskClusters, oracle.design.bootstrapDraws, oracle.design.analysisSeed)
  const familyRaw = { D: permutation.D, Q: permutation.Q, I: permutation.I }
  const family = holm(familyRaw, oracle.design.familywiseAlpha)
  const definitions = {
    D: '0.5*((OP+OO)-(PP+PO)); description one-shot minus persistent',
    Q: '0.5*((PO+OO)-(PP+OP)); parameter-schema one-shot minus persistent',
    I: 'OO-OP-PO+PP; factorial interaction',
  }
  const primaryContrasts = Object.fromEntries(['D', 'Q', 'I'].map(key => [key, {
    estimate: observed[key],
    definition: definitions[key],
    permutationTwoSidedP: permutation[key],
    holmAdjustedP: family.adjusted[key],
    rejectAtFamilywise05: family.rejected[key],
    descriptiveTaskClusterBootstrap95: bootstrap[key],
  }]))
  const byArm = Object.fromEntries(SCHEMA_BRIDGE_ARM_IDS.map(arm => [arm, aggregate(rows.filter(row => row.arm === arm))]))
  let deidentifiedBlockOrdinal = 0
  const deidentifiedPromptOrder = shuffled(prompts.tasks, makeRandom(`${oracle.design.analysisSeed}\0publication-clusters`))
  const primaryLabelMatrix = deidentifiedPromptOrder.map((prompt, clusterIndex) => ({
    taskClusterOrdinal: clusterIndex + 1,
    rows: shuffled(SCHEMA_BRIDGE_IDENTITIES, makeRandom(`${oracle.design.analysisSeed}\0publication-rows:${prompt.id}`))
      .map((identity, rowIndex) => ({
      rowOrdinal: rowIndex + 1,
      blockOrdinal: ++deidentifiedBlockOrdinal,
      outcomesByPosition: rows.filter(row => row.taskId === prompt.id && row.identity === identity)
        .sort((left, right) => left.position - right.position)
        .map(row => ({ position: row.position, arm: row.arm, label: row.label })),
      })),
  }))
  const summary = {
    schemaVersion: 1,
    status: 'publication-allowlisted-summary',
    study: 'schema-bridge-live-v1',
    endpoint: {
      name: 'minimal-like trajectory label',
      interpretation: 'lexical trajectory style only; not task ability, quality, or model-internal mechanism',
    },
    provenance: {
      oracleSha256: SCHEMA_BRIDGE_ORACLE_SHA256,
      rawArtifactIntegritySha256: artifactInput.integritySha256,
      rawArtifactIntegrityInterpretation: 'Internal consistency and result reconciliation only; this digest is not a provider signature and does not establish external authenticity.',
      researchCommit: artifactInput.researchCommit,
      promptSetSha256: oracle.prompts.setCanonicalSha256,
      classifierSha256: SCHEMA_BRIDGE_CLASSIFIER_SHA256,
      classifierSourceCommit: oracle.classifier.sourceCommit,
      harnessCommit: oracle.artifactBinding.harnessCommit,
      platform: oracle.artifactBinding.platform,
      ignoredHarnessLibAndNodeModulesAttested: false,
      harnessRuntimeProvenanceLimitation: 'Ignored generated Harness lib/ and node_modules bytes are not cryptographically attested to the reported commit.',
    },
    design: {
      pilotN: 4,
      mainN: 160,
      blocks: 40,
      tasks: 10,
      fixedRuntimeHomes: 4,
      providerAttemptBound: 164,
      permutationDraws: oracle.design.permutationDraws,
      bootstrapDraws: oracle.design.bootstrapDraws,
      familywiseAlpha: oracle.design.familywiseAlpha,
    },
    protocolIntegrity: {
      accepted: 164,
      logicalModelHeaders: 164,
      assistants: 164,
      retries: 0,
      executorDispatches: 0,
      failedUnitsReplaced: 0,
    },
    primary: {
      armMinimalLikeRates: Object.fromEntries(SCHEMA_BRIDGE_ARM_IDS.map((arm, index) => [arm, armMeans[index]])),
      contrasts: primaryContrasts,
      deidentifiedPrimaryLabelMatrix: primaryLabelMatrix,
      multiplicity: 'Holm familywise error control across D, Q, and I at alpha 0.05',
      uncertainty: '95% task/prompt-cluster bootstrap intervals are descriptive',
    },
    secondary: {
      opMinusPo: {
        estimate: observed.OPminusPO,
        permutationTwoSidedP: permutation.OPminusPO,
        descriptiveTaskClusterBootstrap95: bootstrap.OPminusPO,
        multiplicityRole: 'secondary; outside the D/Q/I Holm family',
      },
      byArm,
      overall: aggregate(rows),
    },
    publicationPolicy: 'Allowlisted statistics plus a deidentified primary-label matrix only. Its design ordinals are reproducible from the public analysis seed; they are not anonymization. Raw trajectories, text, real runtime identifiers/hashes, paths, and per-unit times are excluded. The raw artifact digest is not a provider signature or proof of external authenticity. The reported Harness commit does not attest ignored generated lib/ or node_modules bytes.',
  }
  assert(!containsAbsolutePath(summary), 'publication summary unexpectedly contains an absolute path')
  return summary
}

function containsAbsolutePath(value) {
  if (typeof value === 'string') return value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)
  if (Array.isArray(value)) return value.some(containsAbsolutePath)
  if (plainObject(value)) return Object.values(value).some(containsAbsolutePath)
  return false
}

async function requireFresh(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error('refusing to overwrite an existing scorer --out file')
}

async function cli(argv) {
  let artifactPath
  let oraclePath
  let outPath
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index]
    const value = argv[index + 1]
    if (!['--artifact', '--oracle', '--out'].includes(flag) || value === undefined || value.startsWith('--')) {
      throw new Error('usage: score-artifact --artifact RAW.json --oracle ORACLE.json --out SUMMARY.json')
    }
    if (flag === '--artifact') artifactPath = resolve(value)
    if (flag === '--oracle') oraclePath = resolve(value)
    if (flag === '--out') outPath = resolve(value)
    index += 1
  }
  if (artifactPath === undefined || oraclePath === undefined || outPath === undefined) {
    throw new Error('usage: score-artifact --artifact RAW.json --oracle ORACLE.json --out SUMMARY.json')
  }
  await requireFresh(outPath)
  const [artifact, oracle, prompts] = await Promise.all([
    readFile(artifactPath, 'utf8').then(JSON.parse),
    readFile(oraclePath, 'utf8').then(JSON.parse),
    readFile(PROMPTS_PATH, 'utf8').then(JSON.parse),
  ])
  const summary = scoreSchemaBridgeArtifact(artifact, oracle, prompts)
  await mkdir(dirname(outPath), { recursive: true })
  try {
    await writeFile(outPath, `${JSON.stringify(summary, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('refusing to overwrite an existing scorer --out file')
    throw error
  }
  process.stdout.write(`schema bridge publication summary: ${outPath}\n`)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  cli(process.argv.slice(2)).catch(error => {
    process.stderr.write(`score-artifact: ${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  })
}
