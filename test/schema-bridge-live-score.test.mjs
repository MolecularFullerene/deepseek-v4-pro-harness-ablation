import assert from 'node:assert/strict'
import { copyFile, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { canonicalJson, sha256 } from '../src/core.mjs'
import {
  buildSchemaBridgePlan,
  SCHEMA_BRIDGE_ORACLE_SHA256,
  schemaBridgeArtifactIntegritySha256,
  schemaBridgePilotGate,
  validateSchemaBridgeObservation,
} from '../src/schema-bridge-live.mjs'
import { scoreSchemaBridgeArtifact } from '../experiments/schema-bridge-live/score-artifact.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const LIVE_ROOT = join(PACKAGE_ROOT, 'experiments', 'schema-bridge-live')
const ORACLE_PATH = join(LIVE_ROOT, 'oracle.json')
const PROMPTS_PATH = join(LIVE_ROOT, 'prompts.json')
const SCORER_PATH = join(LIVE_ROOT, 'score-artifact.mjs')
const RESEARCH_COMMIT = '1'.repeat(40)
const STRATEGY_DIGEST = '2'.repeat(64)
const PRIVATE_CANARY = 'PRIVATE-RAW-REASONING-CANARY-DO-NOT-PUBLISH'

function captured(text) {
  return { sha256: sha256(text), chars: text.length, text }
}

function promptFor(unit, prompts) {
  return unit.phase === 'pilot'
    ? prompts.pilot
    : prompts.tasks.find(prompt => prompt.id === unit.taskId)
}

function makeRecord(unit, prompt, oracle) {
  const binding = oracle.artifactBinding
  const armIndex = ['pp', 'po', 'op', 'oo'].indexOf(unit.arm)
  const reasoning = (unit.sequence + armIndex) % 3 === 0
    ? `We need inspect safely. ${PRIVATE_CANARY}`
    : (unit.sequence + armIndex) % 3 === 1
      ? `Let me inspect safely. ${PRIVATE_CANARY}`
      : `Inspect safely. ${PRIVATE_CANARY}`
  const argumentsText = JSON.stringify({
    command: "sed -n '1,20p' package.json",
    description: 'Inspect public package metadata',
  })
  const callId = `private-call-${unit.unitId}`
  const config = {
    mode: 'run',
    strategy: unit.strategy,
    repetition: 1,
    preset: unit.strategy,
    strategyStatus: 'diagnostic-only',
    experimentalFactors: null,
    expectedFirstSurface: oracle.surface.orderedToolNames,
    platformQualification: null,
    provider: binding.provider,
    model: binding.model,
    baseUrl: binding.baseUrl,
    reasoningEffort: binding.reasoningEffort,
    temperature: binding.temperature,
    maxTokens: binding.maxTokens,
    timeoutMs: binding.timeoutMs,
    capture: binding.capture,
    stopAfterFirstAssistant: true,
    llmRetry: false,
    credentialMode: 'stdin',
    networkGate: true,
    permissionMode: binding.permissionMode,
    task: { sha256: unit.promptSha256, chars: prompt.text.length },
    harnessCommit: binding.harnessCommit,
    strategyCommit: RESEARCH_COMMIT,
    strategyFilesSha256: STRATEGY_DIGEST,
    protocolClosureSha256: binding.protocolClosureSha256,
    environmentMode: binding.environmentMode,
    launcherMode: binding.launcherMode,
  }
  const toolHashes = oracle.surface.toolSchemaRawSha256[unit.strategy]
  const request = {
    config: {
      provider: binding.provider,
      model: binding.model,
      reasoningEffort: binding.reasoningEffort,
      maxTokens: binding.maxTokens,
    },
    system: { sha256: oracle.surface.systemRawSha256, chars: 46 },
    toolNames: oracle.surface.orderedToolNames,
    tools: oracle.surface.orderedToolNames.map((name, index) => ({
      name,
      schemaSha256: toolHashes[index],
      schemaRawSha256: toolHashes[index],
      schemaCanonicalSha256: '3'.repeat(64),
      schemaRawChars: 1,
      descriptionChars: 1,
    })),
  }
  const assistantCall = {
    type: 'tool-call',
    id: callId,
    name: 'bash',
    arguments: captured(argumentsText),
  }
  const toolCall = {
    callId,
    name: 'bash',
    arguments: captured(argumentsText),
  }
  const runtime = {
    mode: 'run',
    strategy: unit.strategy,
    platform: 'darwin',
    arch: 'arm64',
    sessionIdSha256: sha256(`private-session-${unit.unitId}`),
    requestHeaderCount: 1,
    assistantMessageCount: 1,
    retryCount: 0,
    requests: [request],
    assistantMessages: [{
      usage: { inputTokens: 100, cacheReadTokens: 10, reasoningTokens: 20, outputTokens: 30 },
      blocks: [{ type: 'reasoning', ...captured(reasoning) }, assistantCall],
    }],
    toolCalls: [toolCall],
    toolResults: [{
      callId,
      error: { code: 'ABORTED_BEFORE_DISPATCH', message: 'diagnostic stop' },
      blocks: [],
    }],
  }
  const bridgeChecks = {
    runtimeMode: true,
    fixedRunControls: true,
    exactlyOneRequestHeader: true,
    exactlyOneAssistant: true,
    noRetry: true,
    exactRequestConfig: true,
    exactSystem: true,
    exactToolOrder: true,
    exactRawToolSchemas: true,
    noDispatch: true,
  }
  return {
    schemaVersion: 1,
    run: {
      id: `private-run-${unit.unitId}`,
      anonymousUserIdSha256: sha256(`private-home-${unit.identity}`),
      configFingerprint: sha256(canonicalJson(config)),
      config,
    },
    process: { exitCode: 0, timedOut: false, outputOverflow: false },
    surfaceCheck: { matches: true, expected: oracle.surface.orderedToolNames, actual: oracle.surface.orderedToolNames },
    bridgeProtocolCheck: { matches: true, checks: bridgeChecks },
    runtime,
  }
}

function makeItem(unit, prompts, oracle) {
  const prompt = promptFor(unit, prompts)
  const record = makeRecord(unit, prompt, oracle)
  return {
    ...unit,
    prompt: { sha256: unit.promptSha256, chars: prompt.text.length },
    status: 'accepted',
    validation: validateSchemaBridgeObservation(record, unit, oracle),
    record,
  }
}

function makeCompletedArtifact(oracle, prompts) {
  const plan = buildSchemaBridgePlan(prompts, oracle)
  const pilot = plan.pilot.map(unit => makeItem(unit, prompts, oracle))
  const samples = plan.blocks.flatMap(block => block.allocation).map(unit => makeItem(unit, prompts, oracle))
  const checks = {
    process: true,
    mode: true,
    platform: true,
    harnessCommit: true,
    system: true,
    toolOrder: true,
    rawSchemas: true,
    environment: true,
    launcher: true,
    protocolClosure: true,
  }
  const realDshMounts = ['schema-bridge-pp', 'schema-bridge-po', 'schema-bridge-op', 'schema-bridge-oo']
    .map(strategy => ({
      strategy,
      accepted: true,
      checks: { ...checks },
      surface: {
        harnessCommit: oracle.artifactBinding.harnessCommit,
        launcherMode: oracle.artifactBinding.launcherMode,
        protocolClosureSha256: oracle.artifactBinding.protocolClosureSha256,
        platform: oracle.artifactBinding.platform,
        systemRawSha256: oracle.surface.systemRawSha256,
        orderedToolNames: oracle.surface.orderedToolNames,
        toolSchemaRawSha256: oracle.surface.toolSchemaRawSha256[strategy],
      },
    }))
  const value = {
    schemaVersion: 1,
    mode: 'schema-bridge-live',
    protocol: oracle.protocol,
    status: 'completed',
    createdAt: '2026-08-16T00:00:00.000Z',
    credentialMode: 'hidden TTY/readSecret to child stdin only; never argv/environment/artifact',
    rawArtifactPublication: 'forbidden; score with the publication-allowlisted scorer',
    privateRuntimeHomesRemoved: true,
    privateProtocolSnapshotRemoved: true,
    oracleSha256: SCHEMA_BRIDGE_ORACLE_SHA256,
    promptSetSha256: oracle.prompts.setCanonicalSha256,
    researchCommit: RESEARCH_COMMIT,
    classifier: { ...oracle.classifier },
    route: { ...oracle.artifactBinding },
    design: { ...oracle.design },
    plan,
    preflight: { completedBeforeCredentialRead: true, realDshMounts },
    progress: {
      plannedUnits: 164,
      attemptedUnits: 164,
      observedRequestHeaders: 164,
      acceptedUnits: 164,
      abortedUnits: 0,
    },
    pilotGate: schemaBridgePilotGate(pilot),
    pilot,
    samples,
    stopReason: 'Fixed pilot and all 160 main units completed; no retry or replacement was used.',
    finishedAt: '2026-08-16T01:00:00.000Z',
  }
  return { ...value, integritySha256: schemaBridgeArtifactIntegritySha256(value) }
}

function allKeys(value, output = []) {
  if (Array.isArray(value)) value.forEach(item => allKeys(item, output))
  else if (value !== null && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      output.push(key)
      allKeys(item, output)
    }
  }
  return output
}

test('strict scorer emits only the publication allowlist and rejects trajectory/preflight tampering', async () => {
  const [oracle, prompts] = await Promise.all([
    readFile(ORACLE_PATH, 'utf8').then(JSON.parse),
    readFile(PROMPTS_PATH, 'utf8').then(JSON.parse),
  ])
  const artifact = makeCompletedArtifact(oracle, prompts)
  const summary = scoreSchemaBridgeArtifact(artifact, oracle, prompts)
  const serialized = JSON.stringify(summary)
  assert.equal(serialized.includes(PRIVATE_CANARY), false)
  assert.equal(serialized.includes('private-run-'), false)
  assert.equal(serialized.includes('private-call-'), false)
  assert.equal(serialized.includes('private-session-'), false)
  assert.equal(serialized.includes('private-home-'), false)
  assert.equal(serialized.includes(PACKAGE_ROOT), false)
  assert.equal(summary.provenance.rawArtifactIntegritySha256, artifact.integritySha256)
  assert.match(summary.provenance.rawArtifactIntegrityInterpretation, /not a provider signature/)
  assert.match(summary.provenance.rawArtifactIntegrityInterpretation, /does not establish external authenticity/)
  assert.equal(summary.provenance.ignoredHarnessLibAndNodeModulesAttested, false)
  assert.match(summary.provenance.harnessRuntimeProvenanceLimitation, /not cryptographically attested/)
  assert.match(summary.publicationPolicy, /does not attest ignored generated lib\/ or node_modules bytes/)
  assert.match(summary.publicationPolicy, /not a provider signature or proof of external authenticity/)
  assert.equal(summary.primary.deidentifiedPrimaryLabelMatrix.length, 10)
  assert.equal(summary.primary.deidentifiedPrimaryLabelMatrix.every(cluster => cluster.rows.length === 4
    && cluster.rows.every(row => row.outcomesByPosition.length === 4)), true)
  assert.equal(allKeys(summary).some(key => /(?:identity|session|request|call)(?:id|hash)|(?:id|hash)(?:identity|session|request|call)/i.test(key)), false)

  const changedText = structuredClone(artifact)
  changedText.samples[0].record.runtime.assistantMessages[0].blocks[0].text += ' tampered'
  changedText.integritySha256 = schemaBridgeArtifactIntegritySha256(changedText)
  assert.throws(() => scoreSchemaBridgeArtifact(changedText, oracle, prompts), /text\/hash\/chars mismatch/)

  const missingText = structuredClone(artifact)
  delete missingText.samples[0].record.runtime.assistantMessages[0].blocks[0].text
  missingText.integritySha256 = schemaBridgeArtifactIntegritySha256(missingText)
  assert.throws(() => scoreSchemaBridgeArtifact(missingText, oracle, prompts), /must retain trajectory text/)

  const fakePreflight = structuredClone(artifact)
  fakePreflight.preflight.realDshMounts[0].surface.systemRawSha256 = '0'.repeat(64)
  fakePreflight.integritySha256 = schemaBridgeArtifactIntegritySha256(fakePreflight)
  assert.throws(() => scoreSchemaBridgeArtifact(fakePreflight, oracle, prompts), /surface facts drifted/)
})

test('scorer CLI creates a 0600 summary exclusively and refuses overwrite', async () => {
  const [oracle, prompts] = await Promise.all([
    readFile(ORACLE_PATH, 'utf8').then(JSON.parse),
    readFile(PROMPTS_PATH, 'utf8').then(JSON.parse),
  ])
  const directory = await mkdtemp(join(tmpdir(), 'schema-bridge-score-cli-'))
  const raw = join(directory, 'private-raw.json')
  const out = join(directory, 'summary.json')
  try {
    await writeFile(raw, `${JSON.stringify(makeCompletedArtifact(oracle, prompts))}\n`, { mode: 0o600 })
    const first = spawnSync(process.execPath, [
      SCORER_PATH, '--artifact', raw, '--oracle', ORACLE_PATH, '--out', out,
    ], { cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 60_000 })
    assert.equal(first.status, 0, `${first.stdout}\n${first.stderr}`)
    assert.equal((await stat(out)).mode & 0o777, 0o600)
    const original = await readFile(out, 'utf8')
    assert.equal(original.includes(PRIVATE_CANARY), false)
    const second = spawnSync(process.execPath, [
      SCORER_PATH, '--artifact', raw, '--oracle', ORACLE_PATH, '--out', out,
    ], { cwd: PACKAGE_ROOT, encoding: 'utf8', timeout: 10_000 })
    assert.equal(second.status, 2)
    assert.match(second.stderr, /refusing to overwrite/)
    assert.equal(await readFile(out, 'utf8'), original)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('scorer rejects tampered classifier bytes before executing its CLI', async () => {
  const root = await mkdtemp(join(tmpdir(), 'schema-bridge-classifier-drift-'))
  const copiedLive = join(root, 'experiments', 'schema-bridge-live')
  try {
    await mkdir(copiedLive, { recursive: true })
    await symlink(join(PACKAGE_ROOT, 'src'), join(root, 'src'), 'dir')
    await copyFile(SCORER_PATH, join(copiedLive, 'score-artifact.mjs'))
    await copyFile(PROMPTS_PATH, join(copiedLive, 'prompts.json'))
    await writeFile(join(copiedLive, 'classifier.mjs'), 'export function classifyReasoning() { return { label: "minimal-like" } }\n')
    const result = spawnSync(process.execPath, [join(copiedLive, 'score-artifact.mjs')], {
      cwd: root, encoding: 'utf8', timeout: 10_000,
    })
    assert.notEqual(result.status, 0)
    assert.match(result.stderr, /classifier bytes do not match/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})
