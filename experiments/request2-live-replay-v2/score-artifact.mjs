import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const TREATMENTS = Object.freeze({
  'retain-same': { reasoning: 'retain', session: 'same' },
  'retain-new': { reasoning: 'retain', session: 'new' },
  'drop-same': { reasoning: 'drop', session: 'same' },
  'drop-new': { reasoning: 'drop', session: 'new' },
})
const PRIMARY_REQUIRES = Object.freeze([
  'eligible',
  'request1_anchor_pass',
  'request2_protocol_success',
  'request2_exact_tool_call_pass',
])
const ARTIFACT_MODE = 'official-adapter-request2-transport-replay'
const PILOT_RECEIPT_MODE = 'request2-live-replay-v2-pilot-gate-receipt'
const PILOT_PASSED_STOP_REASON = '--pilot-only requested; all four protocol cells passed and no main sample was sent.'
const NETWORK_STUDY_SEED = 'request2-v2-network-20260816-preregistered-v1'
const HEX_64 = /^[0-9a-f]{64}$/
const V2_FIXTURE_ID = 'request2-live-replay-v2-readonly-route'
const STOP_RULE = 'Run four independent-source protocol-pilot cells first. Main samples require all four to succeed. Only both retain cells succeeding plus a drop-cell HTTP 400 identifies drop protocol rejection; every other failure is factorial-pilot-unidentifiable.'
const CONFORMANCE_CHECK_KEYS = Object.freeze([
  'sameSessionChangeLeavesHeadersIdentical',
  'newSessionChangeLeavesHeadersIdentical',
  'retainBodyByteIdenticalAcrossSessionFactor',
  'dropBodyByteIdenticalAcrossSessionFactor',
  'retainHeadersDifferOnlyBySessionId',
  'dropHeadersDifferOnlyBySessionId',
  'retainVsDropDiffOnlyReasoningContentSameSession',
  'retainVsDropDiffOnlyReasoningContentNewSession',
  'sameUserIdAcrossAllVariants',
  'authorizationPresentButNeverExported',
])
const SURFACE_CHECK_KEYS = Object.freeze([
  'mountedOfficialMinimal',
  'harnessCommitMatchesLock',
  'platformMatchesLock',
  'exactCompleteSystem',
  'exactToolOrder',
  'exactCompleteToolSchemas',
  'individualToolHashesMatchLock',
  'completeSurfaceHashMatchesLock',
  'existingMountSurfaceCheckPassed',
])
const EXPECTED_BINDING = Object.freeze({
  fixtureSha256: 'f1003ff0c0597a3bc2e66e2dc487e22b568d93a35b410438a428312627b093f0',
  harnessCommit: '47f943859bef60e4160492346772ded9b24f765a',
  platform: 'darwin-arm64',
  surfaceSha256: '0fdd6bb5e6d5c44f5292f98bca22dc6a0313e2ce645743584849b73f5223133c',
  provider: 'deepseek-official',
  model: 'deepseek-v4-pro',
  reasoningEffort: 'max',
  temperature: null,
  maxTokens: 768,
  mockRepeat: 1,
  networkRepeat: 3,
  networkBaseUrl: 'https://api.deepseek.com',
  mockBaseUrl: 'http://127.0.0.1:9',
  mockScriptSha256: '553ab2097227bafb3c2b50163bd0a168a68939e945160db773c32485985904dc',
  anonymousUserIdSha256: '4b2f94c54b024d9e76f118916c7bb5c767eb0b09bec174745426be5cfe507123',
  systemSha256: '5fab6e32f283d71510531ce850df2690b8fb77437d36bfabbe8c4ac862f19df9',
  toolSchemaSha256: [
    'fd7afc1cf7fcddd6569f0382dfd9b1a06c0b2b1e2302bd37a3927bee6959b1b1',
    '0948b7082aad2c337f314df4c3e62a779d9a0fdd03f04f07811d7c13e2f2ef3b',
  ],
  toolSchemaChars: [849, 2380],
  headerNames: [
    'accept', 'content-type', 'user-agent',
    'x-deepseek-harness-session-id', 'x-deepseek-harness-user-id',
  ],
  headerValueSha256: {
    accept: '09222aae76e2df5ea422c02315134663eff3252e551091d3293f69f9b6130928',
    'content-type': 'bacb769b46f6d169fb227ea026550f411d46cbe66a9c2a6ba36449c8cf8e4dea',
    'user-agent': '249903d5d47492c24e6fcdd91e11a212e01e8166be43900a6a795a89634add93',
  },
  request1FixedResultSha256: '479ff6d02c04b34ef351da0e29449f7c8d20114267bfdac4204e4eee76b40619',
  request1FixedResultChars: 410,
  builtInExpectedJsonSha256: 'b86f64f3d1b75ec888861babc012e5a8afe4ad9159d060a866492693d719a3e0',
})
const PILOT_ARTIFACT_KEYS = Object.freeze([
  'schemaVersion', 'mode', 'status', 'createdAt', 'transport', 'credentialMode',
  'provider', 'model', 'baseUrl', 'reasoningEffort', 'temperature', 'maxTokens',
  'repeat', 'pilotOnly', 'seed', 'fixtureSha256', 'mockScriptSha256',
  'configFingerprint', 'anonymousUserIdSha256', 'exactMinimalSurface', 'scoring',
  'plan', 'harness', 'platform', 'limitation', 'planSha256', 'pilot', 'samples',
  'completedSamples', 'stopReason', 'transportFacts', 'design', 'finishedAt',
  'process', 'integritySha256',
])

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (plainObject(value)) {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function seededShuffle(values, seed) {
  const result = [...values]
  let counter = 0
  const random = () => {
    const digest = createHash('sha256').update(`${seed}\0${counter++}`).digest()
    return digest.readUInt32BE(0) / 0x1_0000_0000
  }
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    ;[result[index], result[swap]] = [result[swap], result[index]]
  }
  return result
}

function nonEmptyString(value, path) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a non-empty string`)
}

function hexSha256(value, path) {
  if (typeof value !== 'string' || !HEX_64.test(value)) throw new Error(`${path} must be a lowercase SHA-256`)
}

/** Validate the source-controlled, preregistered scoring oracle. */
export function validateV2Oracle(input) {
  if (!plainObject(input)) throw new Error('oracle must be an object')
  const oracle = structuredClone(input)
  exactKeys(oracle, [
    'schemaVersion', 'fixtureId', 'primaryEndpoint', 'treatments',
    'request1', 'request2', 'primaryOutcomeRequires', 'artifactBinding', 'safety',
  ], 'oracle')
  if (oracle.schemaVersion !== 1) throw new Error('oracle.schemaVersion must be 1')
  if (oracle.fixtureId !== V2_FIXTURE_ID) throw new Error(`oracle.fixtureId must be ${V2_FIXTURE_ID}`)
  if (oracle.primaryEndpoint !== 'request2_exact_tool_call') {
    throw new Error('oracle.primaryEndpoint must be request2_exact_tool_call')
  }
  if (canonicalJson(oracle.treatments) !== canonicalJson(Object.keys(TREATMENTS))) {
    throw new Error('oracle.treatments must contain the frozen four-cell order')
  }
  if (canonicalJson(oracle.primaryOutcomeRequires) !== canonicalJson(PRIMARY_REQUIRES)) {
    throw new Error('oracle.primaryOutcomeRequires must contain the frozen gate order')
  }
  for (const phase of ['request1', 'request2']) {
    const spec = oracle[phase]
    if (!plainObject(spec)) throw new Error(`oracle.${phase} must be an object`)
    exactKeys(spec, [
      'reasoningRequired', 'visibleTextMustBeEmpty', 'finishKind',
      'exactlyOneToolCall', 'toolCall',
    ], `oracle.${phase}`)
    if (spec.reasoningRequired !== (phase === 'request1')) {
      throw new Error(`oracle.${phase}.reasoningRequired does not match the frozen endpoint`)
    }
    if (spec.visibleTextMustBeEmpty !== true) throw new Error(`oracle.${phase} must require empty visible text`)
    if (spec.finishKind !== 'tool-calls') throw new Error(`oracle.${phase}.finishKind must be tool-calls`)
    if (spec.exactlyOneToolCall !== true) throw new Error(`oracle.${phase} must require exactly one tool call`)
    exactKeys(spec.toolCall, ['name', 'arguments'], `oracle.${phase}.toolCall`)
    nonEmptyString(spec.toolCall?.name, `oracle.${phase}.toolCall.name`)
    if (!plainObject(spec.toolCall?.arguments)) throw new Error(`oracle.${phase}.toolCall.arguments must be an object`)
  }
  if (canonicalJson(oracle.request1.toolCall) !== canonicalJson({
    name: 'bash',
    arguments: { command: "sed -n '1,120p' /safe/mock/workspace/ROUTE.txt" },
  })) {
    throw new Error('oracle.request1 must freeze the read-only bash anchor')
  }
  if (canonicalJson(oracle.request2.toolCall) !== canonicalJson({
    name: 'str_replace_editor',
    arguments: { command: 'view', path: '/safe/mock/workspace/ledger.txt', view_range: [4, 7] },
  })) {
    throw new Error('oracle.request2 must freeze the read-only routed view call')
  }
  const binding = oracle.artifactBinding
  if (!plainObject(binding)) throw new Error('oracle.artifactBinding must be an object')
  exactKeys(binding, [
    'fixtureSha256', 'harnessCommit', 'platform', 'surfaceSha256', 'provider',
    'model', 'reasoningEffort', 'temperature', 'maxTokens', 'mockRepeat',
    'networkRepeat', 'networkBaseUrl', 'mockBaseUrl', 'systemSha256',
    'mockScriptSha256', 'anonymousUserIdSha256',
    'toolSchemaSha256', 'toolSchemaChars', 'headerNames', 'headerValueSha256',
    'request1FixedResultSha256', 'request1FixedResultChars',
    'builtInExpectedJsonSha256',
  ], 'oracle.artifactBinding')
  if (canonicalJson(binding) !== canonicalJson(EXPECTED_BINDING)) {
    throw new Error('oracle.artifactBinding does not match the frozen v2 binding')
  }
  for (const key of ['fixtureSha256', 'surfaceSha256']) hexSha256(binding[key], `oracle.artifactBinding.${key}`)
  if (typeof binding.harnessCommit !== 'string' || !/^[0-9a-f]{40}$/.test(binding.harnessCommit)) {
    throw new Error('oracle.artifactBinding.harnessCommit must be a lowercase Git commit id')
  }
  if (binding.platform !== 'darwin-arm64') throw new Error('oracle.artifactBinding.platform must be darwin-arm64')
  if (binding.provider !== 'deepseek-official' || binding.model !== 'deepseek-v4-pro') {
    throw new Error('oracle.artifactBinding must freeze the official V4 Pro route')
  }
  if (binding.reasoningEffort !== 'max' || binding.temperature !== null || binding.maxTokens !== 768
    || binding.mockRepeat !== 1 || binding.networkRepeat !== 3) {
    throw new Error('oracle.artifactBinding must freeze reasoning, temperature, maxTokens, and transport repeats')
  }
  if (binding.networkBaseUrl !== 'https://api.deepseek.com' || binding.mockBaseUrl !== 'http://127.0.0.1:9') {
    throw new Error('oracle.artifactBinding base URLs do not match the frozen network/mock routes')
  }
  for (const key of [
    'mockScriptSha256', 'anonymousUserIdSha256', 'systemSha256',
    'request1FixedResultSha256', 'builtInExpectedJsonSha256',
  ]) hexSha256(binding[key], `oracle.artifactBinding.${key}`)
  if (!Array.isArray(binding.toolSchemaSha256) || binding.toolSchemaSha256.length !== 2) {
    throw new Error('oracle.artifactBinding.toolSchemaSha256 must freeze two tools')
  }
  binding.toolSchemaSha256.forEach((value, index) => hexSha256(value, `oracle.artifactBinding.toolSchemaSha256[${index}]`))
  if (canonicalJson(binding.toolSchemaChars) !== '[849,2380]') {
    throw new Error('oracle.artifactBinding.toolSchemaChars does not match the frozen surface')
  }
  if (!Array.isArray(binding.headerNames) || binding.headerNames.length !== 5
    || !plainObject(binding.headerValueSha256)) {
    throw new Error('oracle.artifactBinding must freeze the adapter header surface')
  }
  exactKeys(binding.headerValueSha256, ['accept', 'content-type', 'user-agent'], 'oracle.artifactBinding.headerValueSha256')
  Object.entries(binding.headerValueSha256).forEach(([key, value]) => hexSha256(value, `oracle.artifactBinding.headerValueSha256.${key}`))
  if (binding.request1FixedResultChars !== 410) throw new Error('oracle.artifactBinding.request1FixedResultChars must be 410')
  exactKeys(oracle.safety, [
    'toolCallsAreCapturedButNeverExecutedByRunner', 'request1OperationClass',
    'request2OperationClass', 'networkOperationRequested', 'mutationOperationRequested',
  ], 'oracle.safety')
  if (oracle.safety?.toolCallsAreCapturedButNeverExecutedByRunner !== true
    || oracle.safety?.networkOperationRequested !== false
    || oracle.safety?.mutationOperationRequested !== false
    || oracle.safety?.request1OperationClass !== 'read-only sed print'
    || oracle.safety?.request2OperationClass !== 'str_replace_editor view') {
    throw new Error('oracle.safety does not assert the non-executing, read-only design')
  }
  return Object.freeze(oracle)
}

/** Hash every exported artifact field except the hash field itself. This is a
 * corruption/easy-tamper check, not a signature against a deliberate forger. */
export function v2ArtifactIntegritySha256(input) {
  if (!plainObject(input)) throw new Error('artifact must be an object')
  const value = structuredClone(input)
  delete value.integritySha256
  return sha256(canonicalJson(value))
}

/** Reject a mismatched v2 run before credential read or transport sampling. */
export function validateV2Preflight({
  oracleInput, fixtureSha256, harnessCommit, exactMinimalSurface, transport,
  provider, model, baseUrl, mockScriptSha256, reasoningEffort, temperature, maxTokens, repeat, seed,
}) {
  const oracle = validateV2Oracle(oracleInput)
  const binding = oracle.artifactBinding
  if (fixtureSha256 !== binding.fixtureSha256 || harnessCommit !== binding.harnessCommit) {
    throw new Error('v2 preflight fixture or harness commit does not match the oracle')
  }
  validateExactMinimalSurface(exactMinimalSurface, binding, 'v2 preflight exactMinimalSurface')
  if (!['explicit-network', 'in-process-mock'].includes(transport)) throw new Error('v2 preflight transport is invalid')
  const expectedBaseUrl = transport === 'explicit-network' ? binding.networkBaseUrl : binding.mockBaseUrl
  const expectedRepeat = transport === 'explicit-network' ? binding.networkRepeat : binding.mockRepeat
  const expectedMockScriptSha256 = transport === 'explicit-network' ? null : binding.mockScriptSha256
  if (provider !== binding.provider || model !== binding.model || baseUrl !== expectedBaseUrl
    || mockScriptSha256 !== expectedMockScriptSha256
    || reasoningEffort !== binding.reasoningEffort || (temperature ?? null) !== binding.temperature
    || maxTokens !== binding.maxTokens || repeat !== expectedRepeat) {
    throw new Error('v2 preflight model, transport, or sampling controls do not match the oracle')
  }
  if (transport === 'explicit-network' && seed !== NETWORK_STUDY_SEED) {
    throw new Error('v2 preflight network seed does not match the preregistered study seed')
  }
  return oracle
}

function parsedArguments(value) {
  if (typeof value !== 'string') return { valid: false, value: null }
  try {
    const parsed = JSON.parse(value)
    return { valid: plainObject(parsed), value: parsed }
  } catch {
    return { valid: false, value: null }
  }
}

function jsonObjectCandidates(text) {
  const candidates = []
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue
    let depth = 0
    let quoted = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const character = text[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') quoted = false
        continue
      }
      if (character === '"') quoted = true
      else if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) {
          const raw = text.slice(start, index + 1)
          try {
            const value = JSON.parse(raw)
            if (plainObject(value)) {
              candidates.push({ raw, value })
              start = index
            }
          } catch { /* not a JSON object */ }
          break
        }
      }
    }
  }
  return candidates
}

function recomputeBuiltInScore(text, expectedJson, protocolSuccess) {
  const candidates = jsonObjectCandidates(String(text))
  const unique = candidates.length === 1 ? candidates[0] : undefined
  return {
    method: 'extract exactly one JSON object; canonical deep equality against preregistered expectedJson',
    protocolSuccess,
    scorable: protocolSuccess && unique !== undefined,
    answerCorrect: protocolSuccess && unique !== undefined
      && canonicalJson(unique.value) === canonicalJson(expectedJson),
    jsonObjectCount: candidates.length,
    visibleTextIsOnlyJson: unique === undefined ? false : String(text).trim() === unique.raw,
    expectedJsonSha256: sha256(canonicalJson(expectedJson)),
    actualJsonSha256: unique === undefined ? null : sha256(canonicalJson(unique.value)),
  }
}

function scoreToolResponse(response, spec, phase) {
  const calls = Array.isArray(response?.toolCalls) ? response.toolCalls : []
  const call = calls.length === 1 ? calls[0] : undefined
  const parsed = parsedArguments(call?.arguments)
  const checks = {
    responsePresent: plainObject(response),
    noResponseError: response?.error === null,
    reasoningRequirementMet: spec.reasoningRequired !== true
      || (typeof response?.reasoning === 'string' && response.reasoning.trim().length > 0),
    visibleTextEmpty: typeof response?.text === 'string' && response.text.trim().length === 0,
    finishKindExact: response?.finish?.kind === spec.finishKind,
    exactlyOneToolCall: calls.length === 1,
    toolNameExact: call?.name === spec.toolCall.name,
    argumentsAreJsonObject: parsed.valid,
    argumentsExact: parsed.valid && canonicalJson(parsed.value) === canonicalJson(spec.toolCall.arguments),
  }
  const failures = Object.entries(checks).filter(([, passed]) => !passed).map(([name]) => `${phase}:${name}`)
  return { passed: failures.length === 0, checks, failures }
}

/** Score one public runner record without exporting reasoning or call arguments. */
export function scoreV2Record(record, oracleInput) {
  const oracle = validateV2Oracle(oracleInput)
  const treatmentId = record?.treatment?.id
  const expectedFactors = TREATMENTS[treatmentId]
  const treatmentKnown = expectedFactors !== undefined
  const treatmentFactorsExact = treatmentKnown
    && record.treatment.reasoning === expectedFactors.reasoning
    && record.treatment.session === expectedFactors.session
  const request1 = scoreToolResponse(record?.request1?.response, oracle.request1, 'request1')
  const request2 = scoreToolResponse(record?.request2?.response, oracle.request2, 'request2')
  const gates = {
    treatmentKnown,
    treatmentFactorsExact,
    eligible: record?.eligible === true,
    request1AnchorPass: request1.passed,
    request2ProtocolSuccess: record?.request2?.protocol?.success === true,
    request2ExactToolCallPass: request2.passed,
  }
  const failures = [
    ...Object.entries(gates).filter(([, passed]) => !passed).map(([name]) => `gate:${name}`),
    ...request1.failures,
    ...request2.failures,
  ]
  return {
    unitId: typeof record?.unitId === 'string' ? record.unitId : null,
    treatmentId: treatmentKnown ? treatmentId : null,
    factors: expectedFactors ?? null,
    correct: Object.values(gates).every(Boolean),
    gates,
    request1: { passed: request1.passed, checks: request1.checks },
    request2: { passed: request2.passed, checks: request2.checks },
    failures: [...new Set(failures)],
  }
}

function rate(correct, total) {
  return total === 0 ? null : correct / total
}

function bucket(units) {
  const total = units.length
  const correct = units.filter(unit => unit.correct).length
  return { total, correct, incorrect: total - correct, correctRate: rate(correct, total) }
}

function scoreCollection(records, oracle) {
  const units = records.map(record => scoreV2Record(record, oracle))
  const overall = bucket(units)
  const byTreatment = Object.fromEntries(Object.keys(TREATMENTS).map(id => [
    id,
    bucket(units.filter(unit => unit.treatmentId === id)),
  ]))
  const byReasoning = Object.fromEntries(['retain', 'drop'].map(level => [
    level,
    bucket(units.filter(unit => unit.factors?.reasoning === level)),
  ]))
  const bySession = Object.fromEntries(['same', 'new'].map(level => [
    level,
    bucket(units.filter(unit => unit.factors?.session === level)),
  ]))
  const retainRate = byReasoning.retain.correctRate
  const dropRate = byReasoning.drop.correctRate
  const sameRate = bySession.same.correctRate
  const newRate = bySession.new.correctRate
  const cellRates = Object.fromEntries(Object.entries(byTreatment).map(([id, value]) => [id, value.correctRate]))
  const interaction = Object.values(cellRates).some(value => value === null)
    ? null
    : (cellRates['retain-same'] - cellRates['retain-new'])
      - (cellRates['drop-same'] - cellRates['drop-new'])
  return {
    overall,
    stageCounts: {
      request1AnchorPassed: units.filter(unit => unit.gates.request1AnchorPass).length,
      request2ProtocolSucceeded: units.filter(unit => unit.gates.request2ProtocolSuccess).length,
      request2ExactToolCallPassed: units.filter(unit => unit.gates.request2ExactToolCallPass).length,
    },
    stageCountsByTreatment: Object.fromEntries(Object.keys(TREATMENTS).map(id => {
      const cell = units.filter(unit => unit.treatmentId === id)
      const anchored = cell.filter(unit => unit.gates.request1AnchorPass)
      const exactAfterAnchor = anchored.filter(unit => unit.gates.request2ProtocolSuccess && unit.gates.request2ExactToolCallPass)
      return [id, {
        planned: cell.length,
        eligible: cell.filter(unit => unit.gates.eligible).length,
        request1AnchorPassed: anchored.length,
        request2ProtocolSucceeded: cell.filter(unit => unit.gates.request2ProtocolSuccess).length,
        request2ExactToolCallPassed: cell.filter(unit => unit.gates.request2ExactToolCallPass).length,
        compositeCorrect: cell.filter(unit => unit.correct).length,
        exactAfterAnchor: { correct: exactAfterAnchor.length, total: anchored.length, rate: rate(exactAfterAnchor.length, anchored.length) },
      }]
    })),
    byTreatment,
    marginalContrasts: {
      retainMinusDrop: retainRate === null || dropRate === null ? null : retainRate - dropRate,
      sameMinusNew: sameRate === null || newRate === null ? null : sameRate - newRate,
    },
    differenceInDifferences: interaction,
    units,
  }
}

function exactKeys(value, expected, path) {
  if (!plainObject(value)) throw new Error(`${path} must be an object`)
  const actual = Object.keys(value).sort()
  const wanted = [...expected].sort()
  if (canonicalJson(actual) !== canonicalJson(wanted)) {
    throw new Error(`${path} keys must be exactly ${wanted.join(', ')}`)
  }
}

function validateTreatment(value, path) {
  exactKeys(value, ['id', 'reasoning', 'session'], path)
  const expected = TREATMENTS[value.id]
  if (expected === undefined
    || value.reasoning !== expected.reasoning
    || value.session !== expected.session) {
    throw new Error(`${path} is not one frozen treatment`)
  }
  return expected
}

function validatePlanUnit(unit, path, block) {
  const keys = [
    'unitId', 'treatment', 'sourceSessionIdSha256', 'newSessionIdSha256',
    'request2SessionIdSha256', 'sessionRelationCheck',
  ]
  if (block !== undefined) keys.push('block', 'position')
  exactKeys(unit, keys, path)
  nonEmptyString(unit.unitId, `${path}.unitId`)
  const factors = validateTreatment(unit.treatment, `${path}.treatment`)
  hexSha256(unit.sourceSessionIdSha256, `${path}.sourceSessionIdSha256`)
  hexSha256(unit.newSessionIdSha256, `${path}.newSessionIdSha256`)
  hexSha256(unit.request2SessionIdSha256, `${path}.request2SessionIdSha256`)
  if (unit.sessionRelationCheck !== true) throw new Error(`${path}.sessionRelationCheck must be true`)
  if (unit.sourceSessionIdSha256 === unit.newSessionIdSha256) throw new Error(`${path} source/new session hashes must differ`)
  const expectedRequest2 = factors.session === 'same' ? unit.sourceSessionIdSha256 : unit.newSessionIdSha256
  if (unit.request2SessionIdSha256 !== expectedRequest2) throw new Error(`${path} session hashes contradict treatment`)
  if (block === undefined) {
    if (!/^pilot-unit-\d{2}$/.test(unit.unitId)) throw new Error(`${path}.unitId is not a pilot unit id`)
  } else {
    if (unit.block !== block || !Number.isInteger(unit.position) || unit.position < 1 || unit.position > 4) {
      throw new Error(`${path} block/position does not match its plan block`)
    }
    if (!/^block-\d{3}-unit-\d{2}$/.test(unit.unitId)) throw new Error(`${path}.unitId is not a block unit id`)
  }
}

function validatePublicPlan(plan) {
  exactKeys(plan, ['seed', 'repeat', 'pilot', 'blocks', 'stopRule', 'sha256'], 'artifact.plan')
  nonEmptyString(plan.seed, 'artifact.plan.seed')
  if (!Number.isInteger(plan.repeat) || plan.repeat < 1 || plan.repeat > 100) throw new Error('artifact.plan.repeat is invalid')
  if (plan.stopRule !== STOP_RULE) throw new Error('artifact.plan.stopRule does not match the frozen stopping rule')
  hexSha256(plan.sha256, 'artifact.plan.sha256')
  const { sha256: declared, ...payload } = plan
  if (sha256(canonicalJson(payload)) !== declared) throw new Error('artifact.plan.sha256 does not match the plan')
  exactKeys(plan.pilot, ['allocation'], 'artifact.plan.pilot')
  if (!Array.isArray(plan.pilot.allocation) || plan.pilot.allocation.length !== 4) {
    throw new Error('artifact.plan.pilot must contain four units')
  }
  if (!Array.isArray(plan.blocks) || plan.blocks.length !== plan.repeat) {
    throw new Error('artifact.plan.blocks must match repeat')
  }
  const unitIds = new Set()
  const sessionHashes = new Set()
  const checkAllocation = (allocation, path, block) => {
    if (!Array.isArray(allocation) || allocation.length !== 4) throw new Error(`${path} must contain four units`)
    const shuffleSeed = block === undefined ? `${plan.seed}\0pilot` : `${plan.seed}\0block:${block}`
    const expectedTreatmentOrder = seededShuffle(Object.keys(TREATMENTS), shuffleSeed)
    if (canonicalJson(allocation.map(unit => unit?.treatment?.id)) !== canonicalJson(expectedTreatmentOrder)) {
      throw new Error(`${path} treatment order does not match the recorded seed`)
    }
    const treatmentIds = new Set()
    const positions = new Set()
    allocation.forEach((unit, index) => {
      validatePlanUnit(unit, `${path}[${index}]`, block)
      if (unitIds.has(unit.unitId)) throw new Error(`artifact.plan has duplicate unitId ${unit.unitId}`)
      const expectedUnitId = block === undefined
        ? `pilot-unit-${String(index + 1).padStart(2, '0')}`
        : `block-${String(block).padStart(3, '0')}-unit-${String(index + 1).padStart(2, '0')}`
      if (unit.unitId !== expectedUnitId || (block !== undefined && unit.position !== index + 1)) {
        throw new Error(`${path}[${index}] unit id/position is not canonical`)
      }
      if (sessionHashes.has(unit.sourceSessionIdSha256)) throw new Error('artifact.plan reuses a source session hash')
      sessionHashes.add(unit.sourceSessionIdSha256)
      if (sessionHashes.has(unit.newSessionIdSha256)) throw new Error('artifact.plan reuses a new-session hash')
      sessionHashes.add(unit.newSessionIdSha256)
      unitIds.add(unit.unitId)
      treatmentIds.add(unit.treatment.id)
      if (block !== undefined) positions.add(unit.position)
    })
    if (treatmentIds.size !== 4) throw new Error(`${path} must contain every treatment exactly once`)
    if (block !== undefined && positions.size !== 4) throw new Error(`${path} must contain positions 1..4 exactly once`)
  }
  checkAllocation(plan.pilot.allocation, 'artifact.plan.pilot.allocation')
  plan.blocks.forEach((entry, index) => {
    exactKeys(entry, ['block', 'allocation'], `artifact.plan.blocks[${index}]`)
    if (entry.block !== index + 1) throw new Error(`artifact.plan.blocks[${index}].block is not sequential`)
    checkAllocation(entry.allocation, `artifact.plan.blocks[${index}].allocation`, entry.block)
  })
  return plan
}

function validateBooleanChecks(checks, keys, path) {
  exactKeys(checks, keys, path)
  if (!keys.every(key => checks[key] === true)) throw new Error(`${path} must contain only passing frozen checks`)
}

function validateExactMinimalSurface(surface, binding, path) {
  exactKeys(surface, [
    'source', 'harnessCommit', 'platform', 'system', 'tools', 'surfaceSha256', 'checks',
  ], path)
  if (surface.source !== 'fresh keyless real DSH mount before credential read'
    || surface.harnessCommit !== binding.harnessCommit || surface.platform !== binding.platform
    || surface.surfaceSha256 !== binding.surfaceSha256) {
    throw new Error(`${path} provenance does not match the frozen binding`)
  }
  exactKeys(surface.system, ['sha256', 'chars'], `${path}.system`)
  if (surface.system.sha256 !== binding.systemSha256 || surface.system.chars !== 46) {
    throw new Error(`${path}.system does not match exact Minimal`)
  }
  if (!Array.isArray(surface.tools) || surface.tools.length !== 2) throw new Error(`${path}.tools must contain two tools`)
  const names = ['bash', 'str_replace_editor']
  surface.tools.forEach((tool, index) => {
    exactKeys(tool, ['name', 'schemaSha256', 'schemaChars'], `${path}.tools[${index}]`)
    if (tool.name !== names[index] || tool.schemaSha256 !== binding.toolSchemaSha256[index]
      || tool.schemaChars !== binding.toolSchemaChars[index]) {
      throw new Error(`${path}.tools[${index}] does not match the frozen schema`)
    }
  })
  validateBooleanChecks(surface.checks, SURFACE_CHECK_KEYS, `${path}.checks`)
}

function validateHeaderSummary(headers, binding, path, anonymousUserIdSha256, sessionIdSha256) {
  exactKeys(headers, ['names', 'userIdSha256', 'sessionIdSha256', 'valuesSha256'], path)
  if (canonicalJson(headers.names) !== canonicalJson(binding.headerNames)
    || canonicalJson(headers.valuesSha256) !== canonicalJson(binding.headerValueSha256)) {
    throw new Error(`${path} does not match the frozen adapter header surface`)
  }
  if (headers.userIdSha256 !== anonymousUserIdSha256 || headers.sessionIdSha256 !== sessionIdSha256) {
    throw new Error(`${path} identity hashes do not match the planned request`)
  }
}

function validateRequestSummary(request, binding, path, anonymousUserIdSha256, sessionIdSha256, phase) {
  exactKeys(request, [
    'bodySha256', 'bodyBytes', 'headers', 'httpStatus', 'dispatched',
    'exactPreflightMatch', 'identityHeadersMatch',
  ], path)
  hexSha256(request.bodySha256, `${path}.bodySha256`)
  const validHttpStatus = request.httpStatus === null
    || (Number.isInteger(request.httpStatus) && request.httpStatus >= 100 && request.httpStatus <= 599)
  if (!Number.isSafeInteger(request.bodyBytes) || request.bodyBytes < 1
    || !validHttpStatus || request.dispatched !== true) {
    throw new Error(`${path} has invalid body/HTTP/dispatch facts`)
  }
  if (phase === 'request1') {
    if (request.exactPreflightMatch !== null || request.identityHeadersMatch !== true) {
      throw new Error(`${path} request1 conformance markers are invalid`)
    }
  } else if (request.exactPreflightMatch !== true || request.identityHeadersMatch !== null) {
    throw new Error(`${path} request2 conformance markers are invalid`)
  }
  validateHeaderSummary(request.headers, binding, `${path}.headers`, anonymousUserIdSha256, sessionIdSha256)
}

function recomputeProtocol(request, response) {
  const finishKind = response?.finish?.kind ?? null
  const errorCode = response?.error?.code ?? null
  return {
    success: request.httpStatus >= 200 && request.httpStatus < 300
      && response?.error === null && response?.finish !== null
      && finishKind !== 'error' && finishKind !== 'aborted',
    httpStatus: request.httpStatus,
    finishKind,
    errorCode,
  }
}

function validateProtocol(record, path) {
  exactKeys(record.request2.protocol, ['success', 'httpStatus', 'finishKind', 'errorCode'], `${path}.request2.protocol`)
  const recomputed = recomputeProtocol(record.request2.request, record.request2.response)
  if (canonicalJson(record.request2.protocol) !== canonicalJson(recomputed)) {
    throw new Error(`${path}.request2.protocol is inconsistent with HTTP/response facts`)
  }
}

function validateConformance(record, path, binding, anonymousUserIdSha256, planned) {
  const conformance = record.conformance
  exactKeys(conformance, [
    'schemaVersion', 'fixtureSha256', 'firstToolCallResponseSha256',
    'assistantMessageIndex', 'variants', 'comparisons', 'checks', 'toolResultPairing',
  ], `${path}.conformance`)
  if (conformance.schemaVersion !== 1 || conformance.assistantMessageIndex !== 1) {
    throw new Error(`${path}.conformance has the wrong schema/index`)
  }
  hexSha256(conformance.fixtureSha256, `${path}.conformance.fixtureSha256`)
  hexSha256(conformance.firstToolCallResponseSha256, `${path}.conformance.firstToolCallResponseSha256`)
  validateBooleanChecks(conformance.checks, CONFORMANCE_CHECK_KEYS, `${path}.conformance.checks`)

  const expectedComparisons = {
    retainSessionFactor: { bodyByteIdentical: true, headerDiffPaths: ['/x-deepseek-harness-session-id'] },
    dropSessionFactor: { bodyByteIdentical: true, headerDiffPaths: ['/x-deepseek-harness-session-id'] },
    reasoningFactorSameSession: {
      passed: true, diffPaths: ['/messages/2/reasoning_content'], normalizedBytesEqual: true,
    },
    reasoningFactorNewSession: {
      passed: true, diffPaths: ['/messages/2/reasoning_content'], normalizedBytesEqual: true,
    },
  }
  if (canonicalJson(conformance.comparisons) !== canonicalJson(expectedComparisons)) {
    throw new Error(`${path}.conformance.comparisons does not match the frozen serializer proof`)
  }

  if (!Array.isArray(conformance.variants) || conformance.variants.length !== 4) {
    throw new Error(`${path}.conformance.variants must contain four cells`)
  }
  const byId = {}
  Object.entries(TREATMENTS).forEach(([id, factors], index) => {
    const variant = conformance.variants[index]
    exactKeys(variant, ['id', 'factors', 'bodySha256', 'bodyBytes', 'headers'], `${path}.conformance.variants[${index}]`)
    if (variant.id !== id || canonicalJson(variant.factors) !== canonicalJson({
      reasoning: factors.reasoning, sessionId: factors.session,
    })) throw new Error(`${path}.conformance.variants[${index}] has the wrong treatment`)
    hexSha256(variant.bodySha256, `${path}.conformance.variants[${index}].bodySha256`)
    if (!Number.isSafeInteger(variant.bodyBytes) || variant.bodyBytes < 1) {
      throw new Error(`${path}.conformance.variants[${index}].bodyBytes is invalid`)
    }
    const expectedSession = factors.session === 'same'
      ? planned.sourceSessionIdSha256 : planned.newSessionIdSha256
    validateHeaderSummary(variant.headers, binding, `${path}.conformance.variants[${index}].headers`, anonymousUserIdSha256, expectedSession)
    byId[id] = variant
  })
  if (byId['retain-same'].bodySha256 !== byId['retain-new'].bodySha256
    || byId['drop-same'].bodySha256 !== byId['drop-new'].bodySha256
    || byId['retain-same'].bodySha256 === byId['drop-same'].bodySha256
    || byId['retain-same'].bodyBytes !== byId['retain-new'].bodyBytes
    || byId['drop-same'].bodyBytes !== byId['drop-new'].bodyBytes
    || byId['retain-same'].bodyBytes <= byId['drop-same'].bodyBytes) {
    throw new Error(`${path}.conformance variant body relations are invalid`)
  }
  const assigned = byId[record.treatment.id]
  if (record.request2.request.bodySha256 !== assigned.bodySha256
    || record.request2.request.bodyBytes !== assigned.bodyBytes
    || canonicalJson(record.request2.request.headers) !== canonicalJson(assigned.headers)) {
    throw new Error(`${path}.request2 request does not equal its assigned preflight variant`)
  }

  if (!Array.isArray(conformance.toolResultPairing) || conformance.toolResultPairing.length !== 4) {
    throw new Error(`${path}.conformance.toolResultPairing must contain four cells`)
  }
  const pairingById = {}
  Object.keys(TREATMENTS).forEach((id, index) => {
    const pairing = conformance.toolResultPairing[index]
    exactKeys(pairing, ['id', 'passed', 'toolCallIdSha256', 'toolResultIdSha256'], `${path}.conformance.toolResultPairing[${index}]`)
    if (pairing.id !== id || pairing.passed !== true
      || !Array.isArray(pairing.toolCallIdSha256) || pairing.toolCallIdSha256.length !== 1
      || canonicalJson(pairing.toolCallIdSha256) !== canonicalJson(pairing.toolResultIdSha256)) {
      throw new Error(`${path}.conformance.toolResultPairing[${index}] is invalid`)
    }
    hexSha256(pairing.toolCallIdSha256[0], `${path}.conformance.toolResultPairing[${index}].toolCallIdSha256[0]`)
    pairingById[id] = pairing
  })
  if (new Set(Object.values(pairingById).map(pairing => pairing.toolCallIdSha256[0])).size !== 1) {
    throw new Error(`${path}.conformance pairing cells do not share one request1 call id`)
  }
  const assignedPairing = pairingById[record.treatment.id]
  exactKeys(record.request2.toolResultPairing, ['passed', 'toolCallIdSha256', 'toolResultIdSha256'], `${path}.request2.toolResultPairing`)
  if (record.request2.toolResultPairing.passed !== true
    || canonicalJson(record.request2.toolResultPairing.toolCallIdSha256) !== canonicalJson(assignedPairing.toolCallIdSha256)
    || canonicalJson(record.request2.toolResultPairing.toolResultIdSha256) !== canonicalJson(assignedPairing.toolResultIdSha256)) {
    throw new Error(`${path}.request2.toolResultPairing does not match the assigned preflight`)
  }

  const calls = record.request1?.response?.toolCalls
  if (!Array.isArray(calls) || calls.length !== 1 || !Array.isArray(record.fixedToolResults)
    || record.fixedToolResults.length !== 1) {
    throw new Error(`${path} must contain one request1 call and one fixed result`)
  }
  const fixed = record.fixedToolResults[0]
  exactKeys(fixed, ['callId', 'toolName', 'resultSha256', 'resultChars', 'isError'], `${path}.fixedToolResults[0]`)
  if (fixed.callId !== calls[0].id || fixed.toolName !== calls[0].name || fixed.toolName !== 'bash'
    || fixed.resultSha256 !== binding.request1FixedResultSha256
    || fixed.resultChars !== binding.request1FixedResultChars || fixed.isError !== false
    || sha256(fixed.callId) !== assignedPairing.toolCallIdSha256[0]) {
    throw new Error(`${path}.fixedToolResults[0] does not match the frozen request1 result`)
  }
}

function validatePilotResponseShape(response, path, request1) {
  exactKeys(response, [
    'reasoning', 'text', 'toolCalls', 'usage', 'finish', 'error', 'reasoningDiagnostic',
  ], path)
  if (typeof response.reasoning !== 'string' || typeof response.text !== 'string'
    || !Array.isArray(response.toolCalls) || !plainObject(response.reasoningDiagnostic)) {
    throw new Error(`${path} is not a runner response summary`)
  }
  response.toolCalls.forEach((call, index) => {
    exactKeys(call, ['id', 'name', 'arguments'], `${path}.toolCalls[${index}]`)
    nonEmptyString(call.id, `${path}.toolCalls[${index}].id`)
    nonEmptyString(call.name, `${path}.toolCalls[${index}].name`)
    if (typeof call.arguments !== 'string') throw new Error(`${path}.toolCalls[${index}].arguments must be a string`)
  })
  const trimmed = response.reasoning.trimStart()
  const expectedDiagnostic = {
    startsWithWeNeed: /^we need\b/i.test(trimmed),
    startsWithLetMe: /^let me\b/i.test(trimmed),
    labelRole: 'diagnostic-only; never used as protocol success or answer correctness',
  }
  if (canonicalJson(response.reasoningDiagnostic) !== canonicalJson(expectedDiagnostic)) {
    throw new Error(`${path}.reasoningDiagnostic is inconsistent with its raw reasoning`)
  }
  if (request1 && (response.reasoning.length === 0 || response.toolCalls.length === 0
    || response.finish?.kind !== 'tool-calls' || response.error !== null)) {
    throw new Error(`${path} does not satisfy the runner source-eligibility shape`)
  }
}

function validatePilotRecordShape(record, path) {
  exactKeys(record, [
    'unitId', 'treatment', 'sourceSessionIdSha256', 'request2SessionIdSha256',
    'request1', 'eligible', 'fixedToolResults', 'conformance', 'request2',
  ], path)
  exactKeys(record.request1, ['request', 'response'], `${path}.request1`)
  exactKeys(record.request2, [
    'request', 'response', 'protocol', 'score', 'toolResultPairing',
  ], `${path}.request2`)
  validatePilotResponseShape(record.request1.response, `${path}.request1.response`, true)
  validatePilotResponseShape(record.request2.response, `${path}.request2.response`, false)
}

function validateRecordAgainstPlan(record, planned, path, anonymousUserIdSha256, binding) {
  if (!plainObject(record)) throw new Error(`${path} must be an object`)
  if (record.unitId !== planned.unitId
    || canonicalJson(record.treatment) !== canonicalJson(planned.treatment)
    || record.sourceSessionIdSha256 !== planned.sourceSessionIdSha256
    || record.request2SessionIdSha256 !== planned.request2SessionIdSha256) {
    throw new Error(`${path} does not match its pre-frozen plan unit`)
  }
  if (planned.block !== undefined && (record.block !== planned.block || record.position !== planned.position)) {
    throw new Error(`${path} block/position does not match its pre-frozen plan unit`)
  }
  validateRequestSummary(
    record.request1?.request, binding, `${path}.request1.request`,
    anonymousUserIdSha256, planned.sourceSessionIdSha256, 'request1',
  )
  if (record.eligible === true) {
    validateRequestSummary(
      record.request2?.request, binding, `${path}.request2.request`,
      anonymousUserIdSha256, planned.request2SessionIdSha256, 'request2',
    )
    validateProtocol(record, path)
    const expectedBuiltInScore = recomputeBuiltInScore(
      record.request2.response?.text,
      { scoring_endpoint: 'request2_exact_tool_call_v2' },
      record.request2.protocol.success,
    )
    if (canonicalJson(record.request2.score) !== canonicalJson(expectedBuiltInScore)) {
      throw new Error(`${path}.request2.score is inconsistent with visible text and protocol facts`)
    }
    validateConformance(record, path, binding, anonymousUserIdSha256, planned)
  } else if (record.eligible !== false || record.request2 !== undefined || record.conformance !== undefined) {
    throw new Error(`${path} has an invalid ineligible-source shape`)
  }
}

function validatePassedPilot(pilot) {
  exactKeys(pilot, ['units', 'outcome'], 'artifact.pilot')
  const byTreatment = Object.fromEntries(pilot.units.map(unit => [unit.treatment.id, unit]))
  if (Object.keys(byTreatment).length !== 4) throw new Error('artifact pilot treatments are incomplete')
  const protocolSuccessByTreatment = Object.fromEntries(Object.keys(TREATMENTS).map(id => [
    id, byTreatment[id].request2.protocol.success,
  ]))
  const httpStatusByTreatment = Object.fromEntries(Object.keys(TREATMENTS).map(id => [
    id, byTreatment[id].request2.request.httpStatus,
  ]))
  const expected = {
    status: 'passed',
    allProtocolSuccess: true,
    retainCellsSucceeded: true,
    dropHttp400Cells: [],
    protocolSuccessByTreatment,
    httpStatusByTreatment,
    rule: 'drop rejection requires both retain cells protocol-successful and at least one drop cell HTTP 400',
  }
  if (!Object.values(protocolSuccessByTreatment).every(Boolean)
    || canonicalJson(pilot.outcome) !== canonicalJson(expected)) {
    throw new Error('artifact pilot outcome is inconsistent with its four protocol records')
  }
}

function validateArtifact(artifact, oracle, expectedRun = 'main') {
  const pilotGate = expectedRun === 'pilot-gate'
  if (!pilotGate && expectedRun !== 'main') throw new Error('internal artifact validation mode is invalid')
  if (pilotGate) exactKeys(artifact, PILOT_ARTIFACT_KEYS, 'artifact')
  hexSha256(artifact.integritySha256, 'artifact.integritySha256')
  if (v2ArtifactIntegritySha256(artifact) !== artifact.integritySha256) {
    throw new Error('artifact integrity SHA-256 does not match its exported contents')
  }
  const expectedStatus = pilotGate ? 'pilot-passed' : 'completed'
  if (artifact.schemaVersion !== 1 || artifact.mode !== ARTIFACT_MODE || artifact.status !== expectedStatus) {
    throw new Error(`artifact must be one ${expectedStatus} request2 live replay`)
  }
  const createdAt = Date.parse(artifact.createdAt)
  const finishedAt = Date.parse(artifact.finishedAt)
  if (!Number.isFinite(createdAt) || !Number.isFinite(finishedAt) || createdAt > finishedAt) {
    throw new Error('artifact timestamps are invalid or reversed')
  }
  const binding = oracle.artifactBinding
  if (artifact.fixtureSha256 !== binding.fixtureSha256) throw new Error('artifact fixture hash does not match oracle binding')
  const oracleHash = sha256(canonicalJson(oracle))
  exactKeys(artifact.scoring, [
    'preregistered', 'method', 'expectedJson', 'expectedJsonSha256',
    'protocolSuccessIsSeparate', 'reasoningPrefixLabelsAreDiagnosticOnly',
    'externalOracleSha256',
  ], 'artifact.scoring')
  const expectedBuiltInJson = { scoring_endpoint: 'request2_exact_tool_call_v2' }
  if (artifact.scoring.preregistered !== true
    || artifact.scoring.method !== 'extract exactly one JSON object; canonical deep equality against expectedJson'
    || canonicalJson(artifact.scoring.expectedJson) !== canonicalJson(expectedBuiltInJson)
    || artifact.scoring.expectedJsonSha256 !== binding.builtInExpectedJsonSha256
    || artifact.scoring.protocolSuccessIsSeparate !== true
    || artifact.scoring.reasoningPrefixLabelsAreDiagnosticOnly !== true
    || artifact.scoring.externalOracleSha256 !== oracleHash) {
    throw new Error('artifact scoring manifest does not match the preregistered v2 endpoint')
  }
  exactKeys(artifact.harness, ['commit'], 'artifact.harness')
  if (artifact.harness.commit !== binding.harnessCommit) throw new Error('artifact harness commit does not match oracle binding')
  validateExactMinimalSurface(artifact.exactMinimalSurface, binding, 'artifact.exactMinimalSurface')
  exactKeys(artifact.platform, ['os', 'arch', 'node'], 'artifact.platform')
  if (`${artifact.platform?.os}-${artifact.platform?.arch}` !== binding.platform) {
    throw new Error('artifact platform does not match oracle binding')
  }
  if (typeof artifact.platform.node !== 'string' || !/^v\d+\.\d+\.\d+$/.test(artifact.platform.node)) {
    throw new Error('artifact Node version is invalid')
  }
  const expectedRepeat = artifact.transport === 'explicit-network' ? binding.networkRepeat : binding.mockRepeat
  if (artifact.provider !== binding.provider || artifact.model !== binding.model
    || artifact.reasoningEffort !== binding.reasoningEffort || artifact.temperature !== binding.temperature
    || artifact.maxTokens !== binding.maxTokens || artifact.repeat !== expectedRepeat) {
    throw new Error('artifact model controls do not match oracle binding')
  }
  if (!['explicit-network', 'in-process-mock'].includes(artifact.transport)
    || artifact.transportFacts?.mode !== artifact.transport) {
    throw new Error('artifact transport mode is invalid or inconsistent')
  }
  const expectedBaseUrl = artifact.transport === 'explicit-network' ? binding.networkBaseUrl : binding.mockBaseUrl
  const expectedMockScriptSha256 = artifact.transport === 'explicit-network' ? null : binding.mockScriptSha256
  exactKeys(artifact.transportFacts, [
    'baseUrl', 'provider', 'model', 'mode', 'apiKeySource', 'toolExecution',
  ], 'artifact.transportFacts')
  if (artifact.baseUrl !== expectedBaseUrl || artifact.mockScriptSha256 !== expectedMockScriptSha256
    || artifact.transportFacts.baseUrl !== expectedBaseUrl
    || artifact.transportFacts.provider !== binding.provider || artifact.transportFacts.model !== binding.model
    || artifact.transportFacts.apiKeySource !== 'worker stdin protocol only'
    || artifact.transportFacts.toolExecution !== 'none; fixed fixture results only') {
    throw new Error('artifact base URL does not match its frozen transport route')
  }
  exactKeys(artifact.process, ['exitCode', 'signal', 'timedOut', 'outputOverflow'], 'artifact.process')
  if (artifact.pilotOnly !== pilotGate || artifact.process.exitCode !== 0 || artifact.process.signal !== null
    || artifact.process.timedOut !== false || artifact.process.outputOverflow !== false) {
    throw new Error(`artifact process/pilot controls are not a valid ${pilotGate ? 'pilot gate' : 'completed main run'}`)
  }
  const plan = validatePublicPlan(artifact.plan)
  if (artifact.planSha256 !== plan.sha256 || artifact.repeat !== plan.repeat || artifact.seed !== plan.seed) {
    throw new Error('artifact top-level plan controls do not match the frozen plan')
  }
  if (artifact.transport === 'explicit-network' && artifact.seed !== NETWORK_STUDY_SEED) {
    throw new Error('artifact network seed does not match the preregistered study seed')
  }
  const recomputedConfig = sha256(canonicalJson({
    provider: artifact.provider,
    model: artifact.model,
    baseUrl: artifact.baseUrl,
    reasoningEffort: artifact.reasoningEffort,
    temperature: artifact.temperature ?? null,
    maxTokens: artifact.maxTokens ?? null,
    repeat: artifact.repeat,
    pilotOnly: artifact.pilotOnly,
    seed: artifact.seed,
    fixtureSha256: artifact.fixtureSha256,
    mockScriptSha256: artifact.mockScriptSha256,
    surfaceSha256: artifact.exactMinimalSurface.surfaceSha256,
    planSha256: plan.sha256,
    externalOracleSha256: oracleHash,
  }))
  if (artifact.configFingerprint !== recomputedConfig) throw new Error('artifact config fingerprint is invalid')
  if (artifact.anonymousUserIdSha256 !== binding.anonymousUserIdSha256) {
    throw new Error('artifact anonymous user does not match the frozen fixture identity')
  }
  if (artifact.credentialMode !== 'api-key-stdin only; process memory only; never argv/environment/artifact') {
    throw new Error('artifact credential mode does not match the guarded runner')
  }
  exactKeys(artifact.design, [
    'kind', 'repeat', 'order', 'mainRequestsPerSource',
    'liveTreatmentsPerSource', 'offlinePreflightTreatmentsPerSource',
  ], 'artifact.design')
  const expectedOrder = plan.blocks.map(block => block.allocation.map(unit => unit.treatment.id))
  if (artifact.design.kind !== 'blocked randomized independent-source experiment'
    || artifact.design.repeat !== plan.repeat || canonicalJson(artifact.design.order) !== canonicalJson(expectedOrder)
    || artifact.design.mainRequestsPerSource !== 2 || artifact.design.liveTreatmentsPerSource !== 1
    || artifact.design.offlinePreflightTreatmentsPerSource !== 4
    || artifact.limitation !== 'Transport-level DeepSeekAdapter replay, not a full Agent/Session fork. Each live treatment has an independent request1 source session to avoid stateful branch-order contamination.') {
    throw new Error('artifact design facts do not match the frozen independent-source experiment')
  }
  if (!Array.isArray(artifact.pilot?.units) || artifact.pilot.units.length !== 4
    || artifact.pilot?.outcome?.status !== 'passed'
    || artifact.pilot.outcome.allProtocolSuccess !== true) {
    throw new Error('artifact protocol pilot did not pass as a complete four-cell block')
  }
  const pilotPlan = Object.fromEntries(plan.pilot.allocation.map(unit => [unit.unitId, unit]))
  const pilotIds = new Set()
  artifact.pilot.units.forEach((record, index) => {
    if (pilotIds.has(record?.unitId) || pilotPlan[record?.unitId] === undefined) throw new Error('artifact pilot has a duplicate or unplanned unit')
    if (pilotGate && record.unitId !== plan.pilot.allocation[index].unitId) {
      throw new Error('artifact pilot record order does not match the frozen plan')
    }
    pilotIds.add(record.unitId)
    if (pilotGate) validatePilotRecordShape(record, `artifact.pilot.units[${index}]`)
    validateRecordAgainstPlan(
      record, pilotPlan[record.unitId], `artifact.pilot.units[${index}]`,
      artifact.anonymousUserIdSha256, binding,
    )
    if (record.eligible !== true || record.request2?.protocol?.success !== true) {
      throw new Error('artifact contains a non-successful protocol pilot unit')
    }
  })
  validatePassedPilot(artifact.pilot)
  const plannedSamples = plan.blocks.flatMap(block => block.allocation)
  if (pilotGate) {
    if (!Array.isArray(artifact.samples) || artifact.samples.length !== 0
      || artifact.completedSamples !== 0 || artifact.stopReason !== PILOT_PASSED_STOP_REASON) {
      throw new Error('artifact pilot gate must contain no main samples and the exact pilot-only stop reason')
    }
    return { oracleHash, plan, plannedSamples: plannedSamples.length }
  }
  if (!Array.isArray(artifact.samples) || artifact.samples.length !== plannedSamples.length) {
    throw new Error('artifact.samples does not cover every planned main unit')
  }
  const samplePlan = Object.fromEntries(plannedSamples.map(unit => [unit.unitId, unit]))
  const sampleIds = new Set()
  artifact.samples.forEach((record, index) => {
    if (sampleIds.has(record?.unitId) || samplePlan[record?.unitId] === undefined) throw new Error('artifact samples has a duplicate or unplanned unit')
    sampleIds.add(record.unitId)
    validateRecordAgainstPlan(
      record, samplePlan[record.unitId], `artifact.samples[${index}]`,
      artifact.anonymousUserIdSha256, binding,
    )
  })
  const completed = artifact.samples.filter(sample => sample.eligible && sample.request2 !== undefined).length
  const ineligible = artifact.samples.filter(sample => !sample.eligible).length
  const responseErrors = artifact.samples.filter(sample => sample.request2 !== undefined && sample.request2.response.error !== null).length
  const protocolSuccesses = artifact.samples.filter(sample => sample.request2?.protocol?.success === true).length
  const builtInCorrect = artifact.samples.filter(sample => sample.request2?.score?.answerCorrect === true).length
  if (artifact.completedSamples !== completed || artifact.ineligibleSources !== ineligible
    || artifact.responseErrors !== responseErrors || artifact.protocolSuccesses !== protocolSuccesses
    || artifact.answerCorrect !== builtInCorrect) {
    throw new Error('artifact top-level outcome counts are inconsistent with samples')
  }
  return { oracleHash, plan, plannedSamples: plannedSamples.length }
}

/** Score a completed request2-live-replay artifact using the v2 endpoint. */
export function scoreV2Artifact(artifact, oracleInput) {
  if (!plainObject(artifact)) throw new Error('artifact must be an object')
  const oracle = validateV2Oracle(oracleInput)
  const validated = validateArtifact(artifact, oracle)
  const pilotRecords = artifact.pilot.units
  return {
    schemaVersion: 1,
    mode: 'request2-live-replay-v2-mechanical-score',
    fixtureId: oracle.fixtureId,
    oracleSha256: validated.oracleHash,
    source: {
      validated: true,
      artifactStatus: 'completed',
      transport: artifact.transport,
      plannedMainUnits: validated.plannedSamples,
    },
    endpoint: {
      primary: 'eligible AND exact request1 anchor AND request2 protocol success AND exact request2 tool call',
      builtInExpectedJsonScoreIsPrimary: false,
      reasoningPrefixesAreScoringInputs: false,
    },
    pilot: {
      role: 'protocol gate and scorer diagnostic; excluded from main factorial estimates',
      ...scoreCollection(pilotRecords, oracle),
    },
    main: scoreCollection(artifact.samples, oracle),
  }
}

/** Validate a pilot-only artifact and emit a deliberately minimal public GO receipt. */
export function createV2PilotGateReceipt(artifact, oracleInput) {
  if (!plainObject(artifact)) throw new Error('artifact must be an object')
  const oracle = validateV2Oracle(oracleInput)
  const validated = validateArtifact(artifact, oracle, 'pilot-gate')
  return {
    schemaVersion: 1,
    mode: PILOT_RECEIPT_MODE,
    decision: 'GO',
    artifact: {
      integritySha256: artifact.integritySha256,
      status: 'pilot-passed',
      createdAt: artifact.createdAt,
      finishedAt: artifact.finishedAt,
    },
    binding: {
      fixtureId: oracle.fixtureId,
      oracleSha256: validated.oracleHash,
      fixtureSha256: oracle.artifactBinding.fixtureSha256,
      harnessCommit: oracle.artifactBinding.harnessCommit,
      platform: oracle.artifactBinding.platform,
    },
    controls: {
      transport: artifact.transport,
      provider: artifact.provider,
      model: artifact.model,
      baseUrl: artifact.baseUrl,
      reasoningEffort: artifact.reasoningEffort,
      temperature: artifact.temperature,
      maxTokens: artifact.maxTokens,
      repeat: artifact.repeat,
      pilotOnly: true,
      seed: artifact.seed,
    },
    pilot: {
      status: 'passed',
      allProtocolSuccess: true,
      protocolSuccessByTreatment: structuredClone(artifact.pilot.outcome.protocolSuccessByTreatment),
    },
  }
}

async function cli() {
  const pilotGate = process.argv[2] === '--pilot-gate'
  const offset = pilotGate ? 3 : 2
  const artifactPath = process.argv[offset]
  const oraclePath = process.argv[offset + 1] ?? fileURLToPath(new URL('./oracle.json', import.meta.url))
  if (artifactPath === undefined || process.argv.length > offset + 2) {
    throw new Error('usage: node score-artifact.mjs [--pilot-gate] ARTIFACT.json [ORACLE.json]')
  }
  const [artifactText, oracleText] = await Promise.all([
    readFile(resolve(artifactPath), 'utf8'),
    readFile(resolve(oraclePath), 'utf8'),
  ])
  const artifact = JSON.parse(artifactText)
  const oracle = JSON.parse(oracleText)
  const output = pilotGate
    ? createV2PilotGateReceipt(artifact, oracle)
    : scoreV2Artifact(artifact, oracle)
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`)
}

const invokedPath = process.argv[1] === undefined ? null : pathToFileURL(resolve(process.argv[1])).href
if (invokedPath === import.meta.url) {
  cli().catch(error => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 2
  })
}
