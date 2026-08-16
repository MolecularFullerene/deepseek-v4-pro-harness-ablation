import { canonicalJson, seededShuffle, sha256 } from './core.mjs'

export const SCHEMA_BRIDGE_PROTOCOL = 'schema-bridge-live-v1'
export const SCHEMA_BRIDGE_ARMS = Object.freeze([
  'schema-bridge-pp',
  'schema-bridge-po',
  'schema-bridge-op',
  'schema-bridge-oo',
])
export const SCHEMA_BRIDGE_ARM_IDS = Object.freeze(['pp', 'po', 'op', 'oo'])
export const SCHEMA_BRIDGE_IDENTITIES = Object.freeze([
  'identity-1', 'identity-2', 'identity-3', 'identity-4',
])
export const SCHEMA_BRIDGE_CLASSIFIER_SHA256 = '0e6a7b575c3f658b537c75b5070645377b43649f26d154b51471e9cdf59a0b7a'
export const SCHEMA_BRIDGE_ORACLE_SHA256 = '02cd87c686ce4385d2413f0a0d3bba4bf4df7b3d6b4c0c0544a3e96fedd97821'
export const SCHEMA_BRIDGE_MAX_HTTP_ATTEMPTS = 164
export const SCHEMA_BRIDGE_PROTOCOL_CLOSURE_SHA256 = '139ca77386f782bd7368eccecadc31ca2937b40d6f6fe12e6e1aa4d328c5eacb'
export const SCHEMA_BRIDGE_FIXED_ROUTE = Object.freeze({
  provider: 'deepseek-official',
  model: 'deepseek-v4-pro',
  baseUrl: 'https://api.deepseek.com',
  harnessCommit: '47f943859bef60e4160492346772ded9b24f765a',
  platform: 'darwin-arm64',
})

const HEX_64 = /^[0-9a-f]{64}$/
const STOPPING_RULE = 'Run exactly four pilot cells. Main sampling starts only if all pilot protocol/surface/single-assistant/no-dispatch gates pass. Aborted units are never retried or replaced.'
const INTERNAL_PLAN_BUILD = Symbol('internal schema bridge plan build')

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

function exactKeys(value, expected, path) {
  if (!plainObject(value)) throw new Error(`${path} must be an object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new Error(`${path} keys must be exactly ${wanted.join(', ')}`)
  }
}

function nonEmptyString(value, path) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a non-empty string`)
}

function hexSha(value, path) {
  if (typeof value !== 'string' || !HEX_64.test(value)) throw new Error(`${path} must be a lowercase SHA-256`)
}

/** The external oracle is semantic JSON and must exactly match the frozen preregistration. */
export function validateSchemaBridgeOracle(input) {
  if (!plainObject(input)) throw new Error('schema bridge oracle must be an object')
  if (sha256(canonicalJson(input)) !== SCHEMA_BRIDGE_ORACLE_SHA256) {
    throw new Error('schema bridge oracle does not match the frozen canonical SHA-256')
  }
  const oracle = structuredClone(input)
  exactKeys(oracle, [
    'schemaVersion', 'protocol', 'primaryEndpoint', 'artifactBinding', 'design',
    'prompts', 'classifier', 'surface', 'safety', 'publication',
  ], 'oracle')
  if (oracle.schemaVersion !== 1 || oracle.protocol !== SCHEMA_BRIDGE_PROTOCOL) {
    throw new Error('schema bridge oracle version/protocol is not supported')
  }
  const binding = oracle.artifactBinding
  exactKeys(binding, [
    'provider', 'model', 'baseUrl', 'harnessCommit', 'platform', 'reasoningEffort',
    'temperature', 'maxTokens', 'timeoutMs', 'capture', 'permissionMode', 'environmentMode', 'launcherMode',
    'protocolClosureSha256',
    'stopAfterFirstAssistant', 'llmRetryDisabled',
  ], 'oracle.artifactBinding')
  if (binding.provider !== 'deepseek-official' || binding.model !== 'deepseek-v4-pro'
    || binding.baseUrl !== 'https://api.deepseek.com'
    || binding.reasoningEffort !== 'max' || binding.temperature !== null
    || binding.maxTokens !== 768 || binding.timeoutMs !== 900000 || binding.capture !== 'trajectory'
    || binding.permissionMode !== 'read-only' || binding.stopAfterFirstAssistant !== true
    || binding.llmRetryDisabled !== true || binding.environmentMode !== 'minimal-allowlist'
    || binding.launcherMode !== 'built-js') {
    throw new Error('schema bridge oracle model and guarded runtime binding drifted')
  }
  if (!/^[0-9a-f]{40}$/.test(binding.harnessCommit)) throw new Error('oracle harness commit is invalid')
  hexSha(binding.protocolClosureSha256, 'oracle.artifactBinding.protocolClosureSha256')
  if (!/^[a-z0-9]+-[a-z0-9]+$/.test(binding.platform)) throw new Error('oracle platform is invalid')
  const design = oracle.design
  exactKeys(design, [
    'seed', 'analysisSeed', 'identities', 'tasks', 'mainBlocks', 'pilotAttempts',
    'mainAttempts', 'maxHttpAttempts', 'permutationDraws', 'bootstrapDraws',
    'familywiseAlpha', 'bootstrapConfidence',
  ], 'oracle.design')
  if (design.identities !== 4 || design.tasks !== 10 || design.mainBlocks !== 40
    || design.pilotAttempts !== 4 || design.mainAttempts !== 160
    || design.maxHttpAttempts !== SCHEMA_BRIDGE_MAX_HTTP_ATTEMPTS
    || design.permutationDraws !== 100000 || design.bootstrapDraws !== 20000
    || design.familywiseAlpha !== 0.05 || design.bootstrapConfidence !== 0.95) {
    throw new Error('schema bridge oracle design constants drifted')
  }
  nonEmptyString(design.seed, 'oracle.design.seed')
  nonEmptyString(design.analysisSeed, 'oracle.design.analysisSeed')
  exactKeys(oracle.prompts, ['pilotSha256', 'taskSha256', 'setCanonicalSha256'], 'oracle.prompts')
  hexSha(oracle.prompts.pilotSha256, 'oracle.prompts.pilotSha256')
  hexSha(oracle.prompts.setCanonicalSha256, 'oracle.prompts.setCanonicalSha256')
  if (!Array.isArray(oracle.prompts.taskSha256) || oracle.prompts.taskSha256.length !== 10) {
    throw new Error('oracle must bind exactly ten task prompt hashes')
  }
  oracle.prompts.taskSha256.forEach((value, index) => hexSha(value, `oracle.prompts.taskSha256[${index}]`))
  if (oracle.classifier.sha256 !== SCHEMA_BRIDGE_CLASSIFIER_SHA256) {
    throw new Error('oracle classifier SHA-256 drifted')
  }
  return deepFreeze(oracle)
}

/** Validate the public, source-controlled prompt fixture against the oracle. */
export function validateSchemaBridgePrompts(input, oracleInput) {
  const oracle = validateSchemaBridgeOracle(oracleInput)
  if (!plainObject(input)) throw new Error('schema bridge prompts must be an object')
  const prompts = structuredClone(input)
  exactKeys(prompts, ['schemaVersion', 'pilot', 'tasks'], 'prompts')
  if (prompts.schemaVersion !== 1) throw new Error('prompts.schemaVersion must be 1')
  const validatePrompt = (prompt, path, allowedLanguages) => {
    exactKeys(prompt, ['id', 'language', 'text'], path)
    nonEmptyString(prompt.id, `${path}.id`)
    nonEmptyString(prompt.text, `${path}.text`)
    if (!allowedLanguages.includes(prompt.language)) throw new Error(`${path}.language is invalid`)
    if (/\b(?:we need|let me)\b/i.test(prompt.text)) {
      throw new Error(`${path} contains a forbidden classifier phrase`)
    }
  }
  validatePrompt(prompts.pilot, 'prompts.pilot', ['en'])
  if (!Array.isArray(prompts.tasks) || prompts.tasks.length !== 10) {
    throw new Error('prompts.tasks must contain exactly ten prompts')
  }
  prompts.tasks.forEach((prompt, index) => validatePrompt(prompt, `prompts.tasks[${index}]`, ['en', 'zh']))
  if (new Set(prompts.tasks.map(prompt => prompt.id)).size !== 10) throw new Error('task prompt ids must be unique')
  if (prompts.tasks.filter(prompt => prompt.language === 'en').length !== 5
    || prompts.tasks.filter(prompt => prompt.language === 'zh').length !== 5) {
    throw new Error('task prompts must contain exactly five English and five Chinese prompts')
  }
  if (sha256(prompts.pilot.text) !== oracle.prompts.pilotSha256) throw new Error('pilot prompt hash drifted')
  const taskHashes = prompts.tasks.map(prompt => sha256(prompt.text))
  if (canonicalJson(taskHashes) !== canonicalJson(oracle.prompts.taskSha256)) {
    throw new Error('task prompt hashes or order drifted')
  }
  if (sha256(canonicalJson(prompts)) !== oracle.prompts.setCanonicalSha256) {
    throw new Error('prompt fixture canonical hash drifted')
  }
  return deepFreeze(prompts)
}

function rotate(values, count) {
  return [...values.slice(count), ...values.slice(0, count)]
}

/** Build the complete immutable allocation before credential input. */
export function buildSchemaBridgePlan(promptInput, oracleInput) {
  const oracle = validateSchemaBridgeOracle(oracleInput)
  const prompts = validateSchemaBridgePrompts(promptInput, oracle)
  const pilotOrder = seededShuffle(SCHEMA_BRIDGE_ARM_IDS, `${oracle.design.seed}\0pilot`)
  const pilot = pilotOrder.map((arm, index) => ({
    unitId: `pilot-${String(index + 1).padStart(2, '0')}`,
    sequence: index + 1,
    phase: 'pilot',
    identity: SCHEMA_BRIDGE_IDENTITIES[index],
    promptId: prompts.pilot.id,
    promptSha256: oracle.prompts.pilotSha256,
    position: index + 1,
    arm,
    strategy: `schema-bridge-${arm}`,
  }))

  const unshuffledBlocks = []
  prompts.tasks.forEach((task) => {
    const taskLatinBase = seededShuffle(SCHEMA_BRIDGE_ARM_IDS, `${oracle.design.seed}\0latin:${task.id}`)
    SCHEMA_BRIDGE_IDENTITIES.forEach((identity, identityIndex) => {
      const order = rotate(taskLatinBase, identityIndex)
      unshuffledBlocks.push({
        blockId: `${identity}-${task.id}`,
        identity,
        taskId: task.id,
        language: task.language,
        promptSha256: sha256(task.text),
        order,
      })
    })
  })
  const shuffled = seededShuffle(unshuffledBlocks, `${oracle.design.seed}\0blocks`)
  let sequence = pilot.length
  const blocks = shuffled.map((block, blockIndex) => ({
    blockId: block.blockId,
    block: blockIndex + 1,
    identity: block.identity,
    taskId: block.taskId,
    language: block.language,
    promptSha256: block.promptSha256,
    allocation: block.order.map((arm, position) => ({
      unitId: `main-${String(++sequence).padStart(3, '0')}`,
      sequence,
      phase: 'main',
      blockId: block.blockId,
      block: blockIndex + 1,
      identity: block.identity,
      taskId: block.taskId,
      language: block.language,
      promptSha256: block.promptSha256,
      position: position + 1,
      arm,
      strategy: `schema-bridge-${arm}`,
    })),
  }))
  const value = {
    protocol: SCHEMA_BRIDGE_PROTOCOL,
    seed: oracle.design.seed,
    pilot,
    blocks,
    stoppingRule: STOPPING_RULE,
    httpAttemptCap: SCHEMA_BRIDGE_MAX_HTTP_ATTEMPTS,
  }
  validateSchemaBridgePlan(value, oracle, prompts, INTERNAL_PLAN_BUILD)
  return deepFreeze({ ...value, sha256: sha256(canonicalJson(value)) })
}

/** Reject imbalance, non-consecutive blocks, or any mutation of the frozen allocation. */
export function validateSchemaBridgePlan(input, oracleInput, promptInput, internalToken) {
  const oracle = validateSchemaBridgeOracle(oracleInput)
  const prompts = promptInput === undefined ? undefined : validateSchemaBridgePrompts(promptInput, oracle)
  if (!plainObject(input)) throw new Error('schema bridge plan must be an object')
  const plan = structuredClone(input)
  const suppliedSha = plan.sha256
  delete plan.sha256
  exactKeys(plan, ['protocol', 'seed', 'pilot', 'blocks', 'stoppingRule', 'httpAttemptCap'], 'plan')
  if (plan.protocol !== SCHEMA_BRIDGE_PROTOCOL || plan.seed !== oracle.design.seed
    || plan.httpAttemptCap !== SCHEMA_BRIDGE_MAX_HTTP_ATTEMPTS
    || plan.stoppingRule !== STOPPING_RULE) throw new Error('plan protocol/seed/cap/stopping rule drifted')
  if (!Array.isArray(plan.pilot) || plan.pilot.length !== 4) throw new Error('plan pilot must contain four units')
  if (!Array.isArray(plan.blocks) || plan.blocks.length !== 40) throw new Error('plan must contain forty main blocks')
  if (new Set(plan.pilot.map(unit => unit.arm)).size !== 4) throw new Error('pilot must contain every arm once')
  if (new Set(plan.pilot.map(unit => unit.identity)).size !== 4) throw new Error('pilot must use all four fixed identities')
  plan.pilot.forEach((unit, index) => {
    exactKeys(unit, [
      'unitId', 'sequence', 'phase', 'identity', 'promptId', 'promptSha256',
      'position', 'arm', 'strategy',
    ], `plan.pilot[${index}]`)
    if (unit.unitId !== `pilot-${String(index + 1).padStart(2, '0')}`
      || unit.sequence !== index + 1 || unit.phase !== 'pilot' || unit.position !== index + 1
      || !SCHEMA_BRIDGE_IDENTITIES.includes(unit.identity)
      || !SCHEMA_BRIDGE_ARM_IDS.includes(unit.arm)
      || unit.strategy !== `schema-bridge-${unit.arm}`
      || unit.promptSha256 !== oracle.prompts.pilotSha256) {
      throw new Error(`plan.pilot[${index}] metadata drifted`)
    }
  })
  const flat = plan.blocks.flatMap(block => block.allocation)
  if (flat.length !== 160) throw new Error('plan must contain 160 main units')
  const all = [...plan.pilot, ...flat]
  if (new Set(all.map(unit => unit.unitId)).size !== 164) throw new Error('plan unit ids must be unique')
  if (all.some((unit, index) => unit.sequence !== index + 1)) throw new Error('plan sequences must be consecutive')
  if (new Set(plan.blocks.map(block => block.blockId)).size !== 40) throw new Error('main block ids must be unique')
  let expectedSequence = 5
  for (let blockIndex = 0; blockIndex < plan.blocks.length; blockIndex += 1) {
    const block = plan.blocks[blockIndex]
    exactKeys(block, [
      'blockId', 'block', 'identity', 'taskId', 'language', 'promptSha256', 'allocation',
    ], `plan.blocks[${blockIndex}]`)
    if (!Array.isArray(block.allocation) || block.allocation.length !== 4) throw new Error('every main block must have four units')
    if (new Set(block.allocation.map(unit => unit.arm)).size !== 4) throw new Error('every main block must contain each arm once')
    if (block.block !== blockIndex + 1 || !SCHEMA_BRIDGE_IDENTITIES.includes(block.identity)
      || !['en', 'zh'].includes(block.language) || block.blockId !== `${block.identity}-${block.taskId}`) {
      throw new Error(`plan.blocks[${blockIndex}] metadata drifted`)
    }
    for (let index = 0; index < block.allocation.length; index += 1) {
      const unit = block.allocation[index]
      exactKeys(unit, [
        'unitId', 'sequence', 'phase', 'blockId', 'block', 'identity', 'taskId',
        'language', 'promptSha256', 'position', 'arm', 'strategy',
      ], `plan.blocks[${blockIndex}].allocation[${index}]`)
      if (unit.unitId !== `main-${String(expectedSequence).padStart(3, '0')}`
        || unit.sequence !== expectedSequence++ || unit.phase !== 'main'
        || unit.position !== index + 1 || unit.blockId !== block.blockId
        || unit.block !== block.block || unit.identity !== block.identity
        || unit.taskId !== block.taskId || unit.language !== block.language
        || unit.promptSha256 !== block.promptSha256
        || !SCHEMA_BRIDGE_ARM_IDS.includes(unit.arm)
        || unit.strategy !== `schema-bridge-${unit.arm}`) {
        throw new Error(`plan.blocks[${blockIndex}].allocation[${index}] metadata drifted`)
      }
    }
  }
  const taskIds = [...new Set(plan.blocks.map(block => block.taskId))]
  if (taskIds.length !== 10) throw new Error('plan must cover exactly ten tasks')
  for (const taskId of taskIds) {
    const taskBlocks = plan.blocks.filter(block => block.taskId === taskId)
    if (taskBlocks.length !== 4 || new Set(taskBlocks.map(block => block.identity)).size !== 4) {
      throw new Error(`task ${taskId} must have one block for each identity`)
    }
    for (const arm of SCHEMA_BRIDGE_ARM_IDS) {
      const positions = taskBlocks.map(block => block.allocation.find(unit => unit.arm === arm)?.position).sort()
      if (canonicalJson(positions) !== '[1,2,3,4]') throw new Error(`task ${taskId} is not Latin-square balanced for ${arm}`)
    }
  }
  if (prompts !== undefined) {
    if (plan.pilot.some(unit => unit.promptId !== prompts.pilot.id
      || unit.promptSha256 !== sha256(prompts.pilot.text))) {
      throw new Error('pilot prompt binding drifted')
    }
    const byId = new Map(prompts.tasks.map(prompt => [prompt.id, prompt]))
    for (const block of plan.blocks) {
      const prompt = byId.get(block.taskId)
      if (prompt === undefined || block.promptSha256 !== sha256(prompt.text) || block.language !== prompt.language) {
        throw new Error(`plan prompt binding drifted for ${block.taskId}`)
      }
    }
    if (internalToken !== INTERNAL_PLAN_BUILD) {
      const expected = buildSchemaBridgePlan(prompts, oracle)
      const actualWithSha = suppliedSha === undefined ? { ...plan, sha256: expected.sha256 } : { ...plan, sha256: suppliedSha }
      if (canonicalJson(actualWithSha) !== canonicalJson(expected)) {
        throw new Error('plan allocation does not exactly match the frozen seed-derived plan')
      }
    }
  }
  if (suppliedSha !== undefined) {
    hexSha(suppliedSha, 'plan.sha256')
    if (suppliedSha !== sha256(canonicalJson(plan))) throw new Error('plan SHA-256 does not match its contents')
  }
  return true
}

export function schemaBridgeArtifactIntegritySha256(input) {
  if (!plainObject(input)) throw new Error('artifact must be an object')
  const value = structuredClone(input)
  delete value.integritySha256
  return sha256(canonicalJson(value))
}

function resultToolHashes(request) {
  if (!Array.isArray(request?.tools)) return null
  return request.tools.map(tool => tool.schemaRawSha256 ?? tool.schemaSha256 ?? null)
}

/** Validate one live DSH result without considering any lexical classifier label. */
export function validateSchemaBridgeObservation(record, unit, oracleInput) {
  const oracle = validateSchemaBridgeOracle(oracleInput)
  const binding = oracle.artifactBinding
  const failures = []
  const check = (accepted, label) => { if (!accepted) failures.push(label) }
  const config = record?.run?.config
  const runtime = record?.runtime
  const request = runtime?.requests?.[0]
  const expectedSchemas = oracle.surface.toolSchemaRawSha256[unit.strategy]
  check(record?.process?.exitCode === 0 && record?.process?.timedOut === false
    && record?.process?.outputOverflow === false && record?.error === undefined, 'process')
  check(config?.strategy === unit.strategy && config?.provider === binding.provider
    && config?.model === binding.model && config?.baseUrl === binding.baseUrl, 'route')
  check(config?.reasoningEffort === binding.reasoningEffort && config?.temperature === binding.temperature
    && config?.maxTokens === binding.maxTokens && config?.timeoutMs === binding.timeoutMs
    && config?.capture === binding.capture
    && config?.stopAfterFirstAssistant === true && config?.permissionMode === binding.permissionMode
    && config?.llmRetry === false && config?.credentialMode === 'stdin'
    && config?.networkGate === true && config?.environmentMode === binding.environmentMode
    && config?.launcherMode === binding.launcherMode, 'fixed-controls')
  check(record?.run?.configFingerprint === sha256(canonicalJson(config)), 'config-fingerprint')
  check(config?.harnessCommit === binding.harnessCommit, 'harness-commit')
  check(config?.protocolClosureSha256 === binding.protocolClosureSha256, 'protocol-closure')
  check(config?.task?.sha256 === unit.promptSha256, 'prompt-hash')
  check(runtime?.mode === 'run' && runtime?.strategy === unit.strategy, 'runtime-mode')
  check(`${runtime?.platform}-${runtime?.arch}` === binding.platform, 'platform')
  check(runtime?.requestHeaderCount === 1 && runtime?.requests?.length === 1, 'one-request-header')
  check(runtime?.assistantMessageCount === 1 && runtime?.assistantMessages?.length === 1, 'one-assistant')
  check(runtime?.retryCount === 0, 'no-retry')
  check(canonicalJson(request?.config) === canonicalJson({
    provider: binding.provider,
    model: binding.model,
    reasoningEffort: binding.reasoningEffort,
    maxTokens: binding.maxTokens,
  }), 'request-config')
  check(request?.system?.sha256 === oracle.surface.systemRawSha256, 'system-surface')
  check(canonicalJson(request?.toolNames) === canonicalJson(oracle.surface.orderedToolNames), 'tool-order')
  check(canonicalJson(resultToolHashes(request)) === canonicalJson(expectedSchemas), 'tool-schema-raw-hashes')
  const toolCalls = runtime?.toolCalls ?? []
  const toolResults = runtime?.toolResults ?? []
  check(toolResults.length === toolCalls.length
    && toolResults.every(result => result.error?.code === oracle.safety.abortedToolResultCode), 'zero-dispatch')
  check(record?.surfaceCheck?.matches === true, 'launcher-surface-check')
  const bridgeChecks = record?.bridgeProtocolCheck?.checks
  check(record?.bridgeProtocolCheck?.matches === true && plainObject(bridgeChecks)
    && canonicalJson(Object.keys(bridgeChecks).sort()) === canonicalJson([
      'runtimeMode', 'fixedRunControls', 'exactlyOneRequestHeader', 'exactlyOneAssistant',
      'noRetry', 'exactRequestConfig', 'exactSystem', 'exactToolOrder', 'exactRawToolSchemas', 'noDispatch',
    ].sort()) && Object.values(bridgeChecks).every(value => value === true), 'launcher-bridge-check')
  check(typeof record?.run?.anonymousUserIdSha256 === 'string'
    && HEX_64.test(record.run.anonymousUserIdSha256), 'anonymous-identity')
  check(typeof runtime?.sessionIdSha256 === 'string' && HEX_64.test(runtime.sessionIdSha256), 'session')
  return { accepted: failures.length === 0, failures }
}

/** The pilot gate intentionally has no reasoning/classifier input. */
export function schemaBridgePilotGate(items) {
  if (!Array.isArray(items) || items.length !== 4) throw new Error('schema bridge pilot gate requires four items')
  const arms = items.map(item => item.arm)
  if (new Set(arms).size !== 4 || arms.some(arm => !SCHEMA_BRIDGE_ARM_IDS.includes(arm))) {
    throw new Error('schema bridge pilot gate requires every arm exactly once')
  }
  const passed = items.every(item => item.status === 'accepted' && item.validation?.accepted === true)
  return {
    passed,
    rule: 'protocol/surface/exactly-one-assistant/zero-dispatch only; lexical labels are excluded',
    failedArms: items.filter(item => item.status !== 'accepted' || item.validation?.accepted !== true).map(item => item.arm),
  }
}

/** Guard the generic `run` path before manifest writes or credential access. */
export function validateGenericSchemaBridgeRun(options, strategies) {
  const selected = strategies.filter(strategy => strategy.startsWith('schema-bridge-'))
  if (selected.length === 0 || options.command !== 'run') return
  if (Object.hasOwn(process.env, 'NODE_OPTIONS') || Object.hasOwn(process.env, 'NODE_PATH')) {
    throw new Error('schema bridge run refuses ambient NODE_OPTIONS/NODE_PATH before credential access')
  }
  if (selected.length !== strategies.length) throw new Error('schema bridge live runs may not be mixed with non-bridge strategies')
  const required = [
    [options.stopAfterFirstAssistant === true, '--stop-after-first-assistant'],
    [options.apiKeyStdin === true, '--api-key-stdin'],
    [options.allowNetwork === true, '--allow-network'],
    [options.maxTokens === 768, '--max-tokens 768'],
    [options.capture === 'trajectory', '--capture trajectory'],
    [options.permissionMode === 'read-only', '--permission-mode read-only'],
    [options.reasoningEffort === 'max', '--reasoning-effort max'],
    [options.temperature === undefined, 'temperature null (omit --temperature)'],
    [options.identity === 'fixed', '--identity fixed'],
    [options.timeoutMs === 900_000, '--timeout-ms 900000'],
    [options.provider === SCHEMA_BRIDGE_FIXED_ROUTE.provider, '--provider deepseek-official'],
    [options.model === SCHEMA_BRIDGE_FIXED_ROUTE.model, '--model deepseek-v4-pro'],
    [options.baseUrl === SCHEMA_BRIDGE_FIXED_ROUTE.baseUrl, '--base-url https://api.deepseek.com'],
    [`${process.platform}-${process.arch}` === SCHEMA_BRIDGE_FIXED_ROUTE.platform, `platform ${SCHEMA_BRIDGE_FIXED_ROUTE.platform}`],
  ]
  const missing = required.filter(([accepted]) => !accepted).map(([, label]) => label)
  if (missing.length > 0) throw new Error(`schema bridge live runs are guarded; required fixed controls: ${missing.join(', ')}`)
}
