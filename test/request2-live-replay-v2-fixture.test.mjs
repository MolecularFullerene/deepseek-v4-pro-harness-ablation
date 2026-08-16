import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { validateLiveReplayFixture } from '../src/request2-live-replay.mjs'
import {
  createV2PilotGateReceipt, scoreV2Artifact, scoreV2Record, validateV2Oracle,
  validateV2Preflight, v2ArtifactIntegritySha256,
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

function replaceRequest1WithEditor(records) {
  for (const record of records) {
    const call = record.request1.response.toolCalls[0]
    call.name = 'str_replace_editor'
    call.arguments = JSON.stringify({ command: 'view', path: '/safe/mock/workspace/ROUTE.txt' })
    record.fixedToolResults[0] = {
      callId: call.id,
      toolName: 'str_replace_editor',
      resultSha256: '5ecbd0a8e4ddc9ec263d9a930d3a2f585877d7ac192c5b790e5e278bdfeecc25',
      resultChars: 103,
      isError: true,
    }
  }
}

function addSecondRequest1Call(records) {
  for (const record of records) {
    const callId = `${record.request1.response.toolCalls[0].id}-second`
    const callIdSha256 = createHash('sha256').update(callId).digest('hex')
    record.request1.response.toolCalls.push({
      id: callId,
      name: 'str_replace_editor',
      arguments: JSON.stringify({ command: 'view', path: '/safe/mock/workspace/ROUTE.txt' }),
    })
    record.fixedToolResults.push({
      callId,
      toolName: 'str_replace_editor',
      resultSha256: '5ecbd0a8e4ddc9ec263d9a930d3a2f585877d7ac192c5b790e5e278bdfeecc25',
      resultChars: 103,
      isError: true,
    })
    for (const pairing of record.conformance.toolResultPairing) {
      pairing.toolCallIdSha256.push(callIdSha256)
      pairing.toolResultIdSha256.push(callIdSha256)
    }
    record.request2.toolResultPairing.toolCallIdSha256.push(callIdSha256)
    record.request2.toolResultPairing.toolResultIdSha256.push(callIdSha256)
  }
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

test('live replay refuses an existing output before preflight and preserves its contents and mode', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-r2-live-v2-existing-out-'))
  const output = join(directory, 'existing.json')
  const canary = 'EXISTING-WIDE-MODE-CANARY\n'
  try {
    await writeFile(output, canary, { mode: 0o600 })
    await chmod(output, 0o666)
    const before = await stat(output)
    assert.equal(before.mode & 0o777, 0o666)

    const run = spawnSync(process.execPath, [
      CLI,
      'request2-live-replay',
      '--fixture', join(directory, 'fixture-must-not-be-read.json'),
      '--mock-script', join(directory, 'mock-must-not-be-read.json'),
      '--out', output,
      '--api-key-stdin',
      '--harness-root', join(directory, 'harness-must-not-be-mounted'),
      '--timeout-ms', '30000',
    ], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      input: '',
      env: Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot']
        .filter(key => process.env[key] !== undefined)
        .map(key => [key, process.env[key]])),
      timeout: 5_000,
    })
    assert.notEqual(run.status, 0)
    assert.match(run.stderr, /refusing to overwrite an existing --out file/)
    assert.doesNotMatch(run.stderr, /ENOENT|API key is empty|official DeepSeek adapter/)
    assert.equal(await readFile(output, 'utf8'), canary)
    assert.equal((await stat(output)).mode & 0o777, 0o666)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('pilot-only mock E2E emits one strict, non-sensitive GO receipt and rejects tampering', {
  skip: !existsSync(BUILT_ADAPTER),
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-r2-live-v2-pilot-gate-'))
  const output = join(directory, 'pilot-artifact.json')
  const tamperedOutput = join(directory, 'tampered-pilot-artifact.json')
  const publicSentinel = 'OFFLINE-V2-PILOT-PUBLIC-NONCREDENTIAL-SENTINEL'
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
      '--seed', 'request2-live-replay-v2-offline-pilot-gate-test',
      '--pilot-only',
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
    assert.equal(artifact.status, 'pilot-passed')
    assert.equal(artifact.pilotOnly, true)
    assert.deepEqual(artifact.samples, [])
    assert.equal(artifact.completedSamples, 0)
    assert.equal(artifact.process.exitCode, 0)
    assert.equal(artifact.integritySha256, v2ArtifactIntegritySha256(artifact))
    assert.equal((await stat(output)).mode & 0o777, 0o600)
    assert.throws(() => scoreV2Artifact(artifact, oracle), /completed/)

    const receipt = createV2PilotGateReceipt(artifact, oracle)
    assert.deepEqual(Object.keys(receipt), ['schemaVersion', 'mode', 'decision', 'artifact', 'binding', 'controls', 'pilot'])
    assert.deepEqual(Object.keys(receipt.artifact), ['integritySha256', 'status', 'createdAt', 'finishedAt'])
    assert.deepEqual(Object.keys(receipt.binding), ['fixtureId', 'oracleSha256', 'fixtureSha256', 'harnessCommit', 'platform'])
    assert.deepEqual(Object.keys(receipt.controls), [
      'transport', 'provider', 'model', 'baseUrl', 'reasoningEffort',
      'temperature', 'maxTokens', 'repeat', 'pilotOnly', 'seed',
    ])
    assert.deepEqual(Object.keys(receipt.pilot), ['status', 'allProtocolSuccess', 'protocolSuccessByTreatment'])
    assert.deepEqual(Object.keys(receipt.pilot.protocolSuccessByTreatment), [
      'retain-same', 'retain-new', 'drop-same', 'drop-new',
    ])
    assert.equal(receipt.decision, 'GO')
    assert.equal(receipt.artifact.status, 'pilot-passed')
    assert.equal(receipt.pilot.allProtocolSuccess, true)
    assert.equal(Object.values(receipt.pilot.protocolSuccessByTreatment).every(Boolean), true)

    const nonAnchorPilot = structuredClone(artifact)
    replaceRequest1WithEditor(nonAnchorPilot.pilot.units)
    reseal(nonAnchorPilot)
    assert.equal(createV2PilotGateReceipt(nonAnchorPilot, oracle).decision, 'GO')
    assert.equal(scoreV2Record(nonAnchorPilot.pilot.units[0], oracle).gates.request1AnchorPass, false)

    const multiCallPilot = structuredClone(artifact)
    addSecondRequest1Call(multiCallPilot.pilot.units)
    reseal(multiCallPilot)
    assert.equal(createV2PilotGateReceipt(multiCallPilot, oracle).decision, 'GO')
    assert.equal(scoreV2Record(multiCallPilot.pilot.units[0], oracle).request1.checks.exactlyOneToolCall, false)

    const networkPreflight = {
      oracleInput: oracle,
      fixtureSha256: artifact.fixtureSha256,
      harnessCommit: artifact.harness.commit,
      exactMinimalSurface: artifact.exactMinimalSurface,
      transport: 'explicit-network',
      provider: artifact.provider,
      model: artifact.model,
      baseUrl: oracle.artifactBinding.networkBaseUrl,
      mockScriptSha256: null,
      reasoningEffort: artifact.reasoningEffort,
      temperature: artifact.temperature,
      maxTokens: artifact.maxTokens,
      repeat: oracle.artifactBinding.networkRepeat,
      seed: 'request2-v2-network-20260816-preregistered-v1',
    }
    assert.doesNotThrow(() => validateV2Preflight(networkPreflight))
    assert.throws(() => validateV2Preflight({
      ...networkPreflight,
      seed: 'different-but-internally-consistent-network-seed',
    }), /preregistered study seed/)

    const receiptText = JSON.stringify(receipt)
    const receiptKeys = []
    const collectKeys = value => {
      if (Array.isArray(value)) return value.forEach(collectKeys)
      if (value === null || typeof value !== 'object') return
      for (const [key, child] of Object.entries(value)) {
        receiptKeys.push(key)
        collectKeys(child)
      }
    }
    collectKeys(receipt)
    for (const forbidden of ['configFingerprint', 'planSha256', 'anonymousUserIdSha256']) {
      assert.equal(receiptKeys.includes(forbidden), false)
    }
    assert.equal(receiptKeys.some(key => /(?:anonymous|session|request|body|tool.?call)/i.test(key)), false)
    assert.equal(receiptKeys.some(key => /(?:reasoning.*(?:sha|hash)|(?:sha|hash).*reasoning)/i.test(key)), false)
    const rawPilotValues = [
      publicSentinel,
      artifact.configFingerprint,
      artifact.planSha256,
      artifact.anonymousUserIdSha256,
      ...artifact.plan.pilot.allocation.flatMap(unit => [
        unit.sourceSessionIdSha256, unit.newSessionIdSha256, unit.request2SessionIdSha256,
      ]),
      ...artifact.pilot.units.flatMap(unit => [
        unit.request1.request.bodySha256,
        unit.request2.request.bodySha256,
        unit.request1.response.reasoning,
        ...unit.request1.response.toolCalls.flatMap(call => [call.id, call.arguments]),
        ...unit.request2.response.toolCalls.flatMap(call => [call.id, call.arguments]),
        unit.conformance.firstToolCallResponseSha256,
        ...unit.conformance.variants.map(variant => variant.bodySha256),
        ...unit.conformance.toolResultPairing.flatMap(pairing => [
          ...pairing.toolCallIdSha256, ...pairing.toolResultIdSha256,
        ]),
      ]),
    ]
    for (const value of rawPilotValues) {
      if (typeof value === 'string' && value.length > 0) assert.equal(receiptText.includes(value), false)
    }

    const cliGate = spawnSync(process.execPath, [SCORER_PATH, '--pilot-gate', output], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      env: {},
      timeout: 5_000,
    })
    assert.equal(cliGate.status, 0, cliGate.stderr)
    assert.deepEqual(JSON.parse(cliGate.stdout), receipt)

    const unsealed = structuredClone(artifact)
    unsealed.pilot.outcome.allProtocolSuccess = false
    assert.throws(() => createV2PilotGateReceipt(unsealed, oracle), /integrity/)

    const invalidArtifacts = [
      ['worker-failed status', value => { value.status = 'worker-failed' }],
      ['wrong fixture binding', value => { value.fixtureSha256 = '0'.repeat(64) }],
      ['wrong oracle binding', value => { value.scoring.externalOracleSha256 = '0'.repeat(64) }],
      ['wrong model with recomputed config', value => {
        value.model = 'deepseek-v4-flash'
        value.transportFacts.model = value.model
        rehashPlanAndConfig(value)
      }],
      ['wrong transport', value => { value.transport = 'explicit-network' }],
      ['wrong config fingerprint', value => { value.configFingerprint = '0'.repeat(64) }],
      ['seed/order contradiction with recomputed plan and config', value => {
        value.seed = 'tampered-pilot-seed'
        value.plan.seed = value.seed
        rehashPlanAndConfig(value)
      }],
      ['wrong repeat', value => { value.repeat = 2 }],
      ['pilotOnly false with recomputed config', value => {
        value.pilotOnly = false
        rehashPlanAndConfig(value)
      }],
      ['failed process', value => { value.process.exitCode = 1 }],
      ['reordered pilot plan with recomputed plan and config', value => {
        ;[value.plan.pilot.allocation[0], value.plan.pilot.allocation[1]] = [
          value.plan.pilot.allocation[1], value.plan.pilot.allocation[0],
        ]
        rehashPlanAndConfig(value)
      }],
      ['reordered pilot records', value => {
        ;[value.pilot.units[0], value.pilot.units[1]] = [value.pilot.units[1], value.pilot.units[0]]
      }],
      ['duplicate pilot record', value => { value.pilot.units[1] = structuredClone(value.pilot.units[0]) }],
      ['outcome contradiction', value => {
        value.pilot.outcome.protocolSuccessByTreatment['retain-same'] = false
      }],
      ['nonempty main samples', value => { value.samples = [structuredClone(value.pilot.units[0])] }],
      ['nonzero completed samples', value => { value.completedSamples = 1 }],
      ['wrong pilot stop reason', value => { value.stopReason = 'continue sampling' }],
      ['extra top-level field', value => { value.unvalidatedExtra = true }],
      ['raw diagnostic contradiction', value => {
        value.pilot.units[0].request1.response.reasoningDiagnostic.startsWithWeNeed = false
      }],
      ['reversed timestamps', value => {
        value.createdAt = '2030-01-01T00:00:00.000Z'
        value.finishedAt = '2029-01-01T00:00:00.000Z'
      }],
    ]
    for (const [label, mutate] of invalidArtifacts) {
      const invalid = structuredClone(artifact)
      mutate(invalid)
      reseal(invalid)
      assert.throws(() => createV2PilotGateReceipt(invalid, oracle), undefined, label)
    }

    const workerFailed = structuredClone(artifact)
    workerFailed.status = 'worker-failed'
    reseal(workerFailed)
    await writeFile(tamperedOutput, `${JSON.stringify(workerFailed)}\n`, { mode: 0o600 })
    const rejectedGate = spawnSync(process.execPath, [SCORER_PATH, '--pilot-gate', tamperedOutput], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      env: {},
      timeout: 5_000,
    })
    assert.equal(rejectedGate.status, 2)
    assert.equal(rejectedGate.stdout, '')
    assert.match(rejectedGate.stderr, /pilot-passed/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
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

    const nonAnchorMain = structuredClone(artifact)
    replaceRequest1WithEditor(nonAnchorMain.samples)
    reseal(nonAnchorMain)
    const nonAnchorScore = scoreV2Artifact(nonAnchorMain, oracle)
    assert.equal(nonAnchorScore.main.stageCounts.request1AnchorPassed, 0)
    assert.equal(nonAnchorScore.main.overall.correct, 0)

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
