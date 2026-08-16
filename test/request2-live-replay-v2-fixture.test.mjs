import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { validateLiveReplayFixture } from '../src/request2-live-replay.mjs'
import {
  scoreV2Artifact, scoreV2Record, validateV2Oracle, v2ArtifactIntegritySha256,
} from '../experiments/request2-live-replay-v2/score-artifact.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const EXPERIMENT_ROOT = join(PACKAGE_ROOT, 'experiments', 'request2-live-replay-v2')
const FIXTURE_PATH = join(EXPERIMENT_ROOT, 'fixtures', 'request1.json')
const MOCK_PATH = join(EXPERIMENT_ROOT, 'fixtures', 'mock-discriminating.json')
const WRONG_MOCK_PATH = join(PACKAGE_ROOT, 'experiments', 'request2-live-replay', 'fixtures', 'mock-success.json')
const ORACLE_PATH = join(EXPERIMENT_ROOT, 'oracle.json')
const SCORER_PATH = join(EXPERIMENT_ROOT, 'score-artifact.mjs')
const HARNESS_ROOT = join(PACKAGE_ROOT, '..', 'deepseek-harness')
const BUILT_ADAPTER = join(HARNESS_ROOT, 'packages', 'llm', 'llm-deepseek', 'lib', 'index.js')
const CLI = join(PACKAGE_ROOT, 'src', 'cli.mjs')

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function hashCanonical(value) {
  return createHash('sha256').update(canonicalJson(value)).digest('hex')
}

function reseal(value) {
  delete value.integritySha256
  value.integritySha256 = hashCanonical(value)
  return value
}

function rehashPlanAndConfig(value) {
  const { sha256: _oldPlanHash, ...planPayload } = value.plan
  value.plan.sha256 = hashCanonical(planPayload)
  value.planSha256 = value.plan.sha256
  value.configFingerprint = hashCanonical({
    provider: value.provider,
    model: value.model,
    baseUrl: value.baseUrl,
    reasoningEffort: value.reasoningEffort,
    temperature: value.temperature ?? null,
    maxTokens: value.maxTokens ?? null,
    repeat: value.repeat,
    pilotOnly: value.pilotOnly,
    seed: value.seed,
    fixtureSha256: value.fixtureSha256,
    mockScriptSha256: value.mockScriptSha256,
    surfaceSha256: value.exactMinimalSurface.surfaceSha256,
    planSha256: value.plan.sha256,
    externalOracleSha256: value.scoring.externalOracleSha256,
  })
}

async function inputs() {
  const [fixtureText, oracleText] = await Promise.all([
    readFile(FIXTURE_PATH, 'utf8'),
    readFile(ORACLE_PATH, 'utf8'),
  ])
  return { fixture: JSON.parse(fixtureText), oracle: JSON.parse(oracleText) }
}

function toolResponse(name, argumentsValue, reasoning = 'We need follow the trusted route.') {
  return {
    reasoning,
    text: '',
    toolCalls: [{ id: 'call_synthetic', name, arguments: JSON.stringify(argumentsValue) }],
    finish: { kind: 'tool-calls' },
    error: null,
  }
}

function syntheticRecord(oracle, request2Response) {
  return {
    unitId: 'synthetic-unit',
    treatment: { id: 'retain-same', reasoning: 'retain', session: 'same' },
    eligible: true,
    request1: {
      response: toolResponse(
        oracle.request1.toolCall.name,
        oracle.request1.toolCall.arguments,
        'Let me establish the exact read-only anchor.',
      ),
    },
    request2: {
      protocol: { success: true },
      response: request2Response,
    },
  }
}

test('v2 fixture is the exact official Minimal surface with a frozen read-only route', async () => {
  const { fixture, oracle } = await inputs()
  assert.doesNotThrow(() => validateLiveReplayFixture(fixture))
  assert.doesNotThrow(() => validateV2Oracle(oracle))
  assert.equal(fixture.tools.length, 2)
  assert.deepEqual(fixture.tools.map(tool => tool.name), ['bash', 'str_replace_editor'])
  assert.match(fixture.toolResultFixtures.bash.text, /\[TRUSTED_ROUTE\]/)
  assert.match(fixture.toolResultFixtures.bash.text, /\[UNTRUSTED_DECOYS\]/)
  assert.match(fixture.toolResultFixtures.bash.text, /command=cat \/safe\/mock\/workspace\/decoy\.txt/)
  assert.equal(oracle.safety.toolCallsAreCapturedButNeverExecutedByRunner, true)
  assert.equal(oracle.request1.toolCall.arguments.command, "sed -n '1,120p' /safe/mock/workspace/ROUTE.txt")
  assert.deepEqual(oracle.request2.toolCall, {
    name: 'str_replace_editor',
    arguments: {
      command: 'view',
      path: '/safe/mock/workspace/ledger.txt',
      view_range: [4, 7],
    },
  })
  assert.doesNotMatch(oracle.request1.toolCall.arguments.command, /[;&|><`]/)
  assert.equal(oracle.request2.toolCall.arguments.command, 'view')
})

test('v2 scorer requires the exact second tool and parameters but ignores reasoning prefixes', async () => {
  const { oracle } = await inputs()
  const correctResponse = toolResponse(
    oracle.request2.toolCall.name,
    oracle.request2.toolCall.arguments,
    'Let me use only the trusted route.',
  )
  assert.equal(scoreV2Record(syntheticRecord(oracle, correctResponse), oracle).correct, true)

  const wrongTool = toolResponse('bash', { command: 'cat /safe/mock/workspace/decoy.txt' })
  const wrongToolScore = scoreV2Record(syntheticRecord(oracle, wrongTool), oracle)
  assert.equal(wrongToolScore.correct, false)
  assert.equal(wrongToolScore.request2.checks.toolNameExact, false)

  const wrongArguments = toolResponse('str_replace_editor', {
    command: 'view', path: '/safe/mock/workspace/decoy.txt', view_range: [1, -1],
  })
  const wrongArgumentScore = scoreV2Record(syntheticRecord(oracle, wrongArguments), oracle)
  assert.equal(wrongArgumentScore.correct, false)
  assert.equal(wrongArgumentScore.request2.checks.toolNameExact, true)
  assert.equal(wrongArgumentScore.request2.checks.argumentsExact, false)

  const extraArgument = toolResponse('str_replace_editor', {
    ...oracle.request2.toolCall.arguments, extra: 'not allowed',
  })
  assert.equal(scoreV2Record(syntheticRecord(oracle, extraArgument), oracle).correct, false)
})

test('v2 scorer is a read-only artifact transformer with no environment or network access', async () => {
  const source = await readFile(SCORER_PATH, 'utf8')
  assert.equal(source.includes('process.env'), false)
  assert.equal(source.includes('fetch('), false)
  assert.equal(source.includes('writeFile'), false)
  assert.equal(source.includes('node:child_process'), false)
  assert.equal(source.includes('execFile'), false)
  assert.equal(source.includes('spawn('), false)
})

test('existing runner plus discriminating mock yields the preregistered 2/4 matrix', {
  skip: !existsSync(BUILT_ADAPTER),
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-r2-live-v2-'))
  const output = join(directory, 'artifact.json')
  const publicSentinel = 'OFFLINE-V2-PUBLIC-NONCREDENTIAL-SENTINEL'
  try {
    const run = spawnSync(process.execPath, [
      CLI,
      'request2-live-replay',
      '--fixture', FIXTURE_PATH,
      '--mock-script', MOCK_PATH,
      '--oracle', ORACLE_PATH,
      '--base-url', 'http://127.0.0.1:9',
      '--max-tokens', '768',
      '--repeat', '1',
      '--seed', 'request2-live-replay-v2-offline-test',
      '--out', output,
      '--api-key-stdin',
      '--harness-root', HARNESS_ROOT,
      '--timeout-ms', '30000',
    ], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      input: publicSentinel,
      env: Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot']
        .filter(key => process.env[key] !== undefined)
        .map(key => [key, process.env[key]])),
      timeout: 30_000,
    })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    const artifactText = await readFile(output, 'utf8')
    assert.equal(artifactText.includes(publicSentinel), false)
    const artifact = JSON.parse(artifactText)
    const { oracle } = await inputs()
    const score = scoreV2Artifact(artifact, oracle)
    assert.equal(artifact.integritySha256, v2ArtifactIntegritySha256(artifact))

    assert.equal(artifact.transport, 'in-process-mock')
    assert.equal(artifact.pilot.outcome.status, 'passed')
    assert.equal(score.pilot.overall.correct, 4)
    assert.deepEqual(score.main.overall, { total: 4, correct: 2, incorrect: 2, correctRate: 0.5 })
    assert.equal(score.main.byTreatment['retain-same'].correct, 1)
    assert.equal(score.main.byTreatment['retain-new'].correct, 0)
    assert.equal(score.main.byTreatment['drop-same'].correct, 0)
    assert.equal(score.main.byTreatment['drop-new'].correct, 1)
    assert.equal(score.main.byTreatment['retain-new'].total, 1)
    assert.equal(score.main.units.find(unit => unit.treatmentId === 'retain-new').request2.checks.toolNameExact, false)
    assert.equal(score.main.units.find(unit => unit.treatmentId === 'drop-same').request2.checks.argumentsExact, false)
    assert.equal(artifact.samples.every(sample => sample.request2.score.answerCorrect === false), true)

    const unsealedResponseEdit = structuredClone(artifact)
    unsealedResponseEdit.samples[0].request2.response.toolCalls[0].name = 'tampered-tool'
    assert.throws(() => scoreV2Artifact(unsealedResponseEdit, oracle), /integrity/)

    const invalidArtifacts = [
      ['worker status', value => { value.status = 'worker-failed' }],
      ['fixture provenance', value => { value.fixtureSha256 = '0'.repeat(64) }],
      ['oracle binding', value => { value.scoring.externalOracleSha256 = '0'.repeat(64) }],
      ['duplicate main unit', value => { value.samples[1] = structuredClone(value.samples[0]) }],
      ['failed conformance', value => {
        const key = Object.keys(value.samples[0].conformance.checks)[0]
        value.samples[0].conformance.checks[key] = false
      }],
      ['fabricated conformance keys', value => { value.samples[0].conformance.checks = { fabricated: true } }],
      ['HTTP/protocol contradiction', value => {
        value.samples[0].request2.request.httpStatus = 500
        value.samples[0].request2.protocol.httpStatus = 500
      }],
      ['tool execution claim', value => { value.transportFacts.toolExecution = 'executed unrestricted shell' }],
      ['fabricated surface checks', value => { value.exactMinimalSurface.checks = { fabricated: true } }],
      ['missing fixed tool result', value => { value.samples[0].fixedToolResults = [] }],
      ['wrong mock script', value => {
        value.mockScriptSha256 = '0'.repeat(64)
        rehashPlanAndConfig(value)
      }],
      ['seed/order contradiction', value => {
        value.seed = 'different-seed-with-stale-order'
        value.plan.seed = value.seed
        rehashPlanAndConfig(value)
      }],
      ['changed stop rule', value => {
        value.plan.stopRule = 'sample until a preferred answer appears'
        rehashPlanAndConfig(value)
      }],
      ['reused global new session', value => {
        value.plan.pilot.allocation[0].newSessionIdSha256 = value.plan.pilot.allocation[1].sourceSessionIdSha256
        rehashPlanAndConfig(value)
      }],
      ['anonymous identity drift', value => {
        const forged = '0'.repeat(64)
        value.anonymousUserIdSha256 = forged
        for (const record of [...value.pilot.units, ...value.samples]) {
          record.request1.request.headers.userIdSha256 = forged
          if (record.request2 !== undefined) record.request2.request.headers.userIdSha256 = forged
          for (const variant of record.conformance?.variants ?? []) variant.headers.userIdSha256 = forged
        }
      }],
      ['retain/drop byte contradiction', value => {
        for (const record of [...value.pilot.units, ...value.samples]) {
          for (const variant of record.conformance.variants) {
            variant.bodyBytes = variant.id.startsWith('retain-') ? 100 : 200
          }
          record.request2.request.bodyBytes = record.treatment.reasoning === 'retain' ? 100 : 200
        }
      }],
      ['different pairing ids across cells', value => {
        const record = value.samples[0]
        const assigned = record.treatment.id
        record.conformance.toolResultPairing.forEach((pairing, index) => {
          if (pairing.id === assigned) return
          const forged = String(index + 1).repeat(64)
          pairing.toolCallIdSha256 = [forged]
          pairing.toolResultIdSha256 = [forged]
        })
      }],
      ['forged built-in score', value => { value.samples[0].request2.score.answerCorrect = true }],
      ['credential mode drift', value => { value.credentialMode = 'environment plaintext credential' }],
      ['reversed timestamps', value => {
        value.createdAt = '2030-01-01T00:00:00.000Z'
        value.finishedAt = '2029-01-01T00:00:00.000Z'
      }],
      ['unfrozen temperature', value => { value.temperature = 1 }],
      ['inconsistent aggregate', value => { value.completedSamples += 1 }],
    ]
    for (const [label, mutate] of invalidArtifacts) {
      const invalid = structuredClone(artifact)
      mutate(invalid)
      reseal(invalid)
      assert.throws(() => scoreV2Artifact(invalid, oracle), undefined, label)
    }

    const weakenedOracle = structuredClone(oracle)
    weakenedOracle.primaryOutcomeRequires = ['eligible']
    assert.throws(() => scoreV2Artifact(artifact, weakenedOracle), /primaryOutcomeRequires/)
    const noReasoningOracle = structuredClone(oracle)
    noReasoningOracle.request1.reasoningRequired = false
    assert.throws(() => validateV2Oracle(noReasoningOracle), /reasoningRequired/)
    const extraArgumentOracle = structuredClone(oracle)
    extraArgumentOracle.request2.toolCall.arguments.extra = 'not frozen'
    assert.throws(() => validateV2Oracle(extraArgumentOracle), /routed view call/)
    const canaryIdOracle = structuredClone(oracle)
    canaryIdOracle.fixtureId = 'PRIVATE-CANARY-MUST-NOT-BE-EMITTED'
    assert.throws(() => validateV2Oracle(canaryIdOracle), /fixtureId/)

    const scored = spawnSync(process.execPath, [SCORER_PATH, output], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      env: {},
      timeout: 5_000,
    })
    assert.equal(scored.status, 0, scored.stderr)
    assert.equal(JSON.parse(scored.stdout).main.overall.correct, 2)

    const rejectedOutput = join(directory, 'must-not-be-created.json')
    const rejectedBeforeCredential = spawnSync(process.execPath, [
      CLI,
      'request2-live-replay',
      '--fixture', FIXTURE_PATH,
      '--mock-script', MOCK_PATH,
      '--oracle', ORACLE_PATH,
      '--base-url', 'http://127.0.0.1:9',
      '--temperature', '1',
      '--max-tokens', '768',
      '--repeat', '1',
      '--out', rejectedOutput,
      '--api-key-stdin',
      '--harness-root', HARNESS_ROOT,
      '--timeout-ms', '30000',
    ], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      input: '',
      env: Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot']
        .filter(key => process.env[key] !== undefined)
        .map(key => [key, process.env[key]])),
      timeout: 30_000,
    })
    assert.notEqual(rejectedBeforeCredential.status, 0)
    assert.match(rejectedBeforeCredential.stderr, /v2 preflight model, transport, or sampling controls/)
    assert.doesNotMatch(rejectedBeforeCredential.stderr, /API key is empty/)
    assert.equal(existsSync(rejectedOutput), false)

    const wrongMockOutput = join(directory, 'wrong-mock-must-not-be-created.json')
    const wrongMock = spawnSync(process.execPath, [
      CLI,
      'request2-live-replay',
      '--fixture', FIXTURE_PATH,
      '--mock-script', WRONG_MOCK_PATH,
      '--oracle', ORACLE_PATH,
      '--base-url', 'http://127.0.0.1:9',
      '--max-tokens', '768',
      '--repeat', '1',
      '--out', wrongMockOutput,
      '--api-key-stdin',
      '--harness-root', HARNESS_ROOT,
      '--timeout-ms', '30000',
    ], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      input: '',
      env: Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot']
        .filter(key => process.env[key] !== undefined)
        .map(key => [key, process.env[key]])),
      timeout: 30_000,
    })
    assert.notEqual(wrongMock.status, 0)
    assert.match(wrongMock.stderr, /v2 preflight model, transport, or sampling controls/)
    assert.doesNotMatch(wrongMock.stderr, /API key is empty/)
    assert.equal(existsSync(wrongMockOutput), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
