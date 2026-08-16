import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import {
  buildLiveReplayPlan, classifyProtocolPilot, publicLiveReplayPlan, scoreExpectedJson,
  validateLiveReplayFixture,
} from '../src/request2-live-replay.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const HARNESS_ROOT = join(PACKAGE_ROOT, '..', 'deepseek-harness')
const BUILT_ADAPTER = join(HARNESS_ROOT, 'packages', 'llm', 'llm-deepseek', 'lib', 'index.js')
const CLI = join(PACKAGE_ROOT, 'src', 'cli.mjs')
const FIXTURE = join(PACKAGE_ROOT, 'experiments', 'request2-live-replay', 'fixtures', 'request1.json')
const MOCK_SUCCESS = join(PACKAGE_ROOT, 'experiments', 'request2-live-replay', 'fixtures', 'mock-success.json')
const MOCK_400 = join(PACKAGE_ROOT, 'experiments', 'request2-live-replay', 'fixtures', 'mock-pilot-400.json')

test('live plan freezes blocked allocation and never reuses a source/new session', () => {
  let counter = 0
  const plan = buildLiveReplayPlan({
    repeat: 3,
    seed: 'blocked-plan-test',
    makeSessionId: label => `${label}-${++counter}`,
  })
  assert.equal(Object.isFrozen(plan), true)
  assert.equal(plan.blocks.length, 3)
  assert.deepEqual(new Set(plan.pilot.allocation.map(unit => unit.treatment.id)), new Set([
    'retain-same', 'retain-new', 'drop-same', 'drop-new',
  ]))
  const allSessions = plan.pilot.allocation.flatMap(unit => [unit.sourceSessionId, unit.newSessionId])
  for (const block of plan.blocks) {
    assert.deepEqual(new Set(block.allocation.map(unit => unit.treatment.id)), new Set([
      'retain-same', 'retain-new', 'drop-same', 'drop-new',
    ]))
    for (const unit of block.allocation) allSessions.push(unit.sourceSessionId, unit.newSessionId)
  }
  assert.equal(new Set(allSessions).size, allSessions.length)
  const publicPlan = publicLiveReplayPlan(plan)
  assert.equal(JSON.stringify(publicPlan).includes('pilot-source-1'), false)
  assert.equal(publicPlan.pilot.allocation.length, 4)
  assert.equal(publicPlan.blocks.flatMap(block => block.allocation).length, 12)
})

test('four-cell protocol pilot classifies drop rejection only behind successful retain controls', () => {
  const record = (id, success, status = success ? 200 : 500) => ({
    treatment: { id },
    eligible: true,
    request2: {
      protocol: { success },
      request: { httpStatus: status },
      response: { error: success ? null : { status } },
    },
  })
  const allPassed = ['retain-same', 'retain-new', 'drop-same', 'drop-new'].map(id => record(id, true))
  assert.equal(classifyProtocolPilot(allPassed).status, 'passed')
  const isolatedDrop400 = [
    record('retain-same', true), record('retain-new', true),
    record('drop-same', false, 400), record('drop-new', true),
  ]
  assert.equal(classifyProtocolPilot(isolatedDrop400).status, 'drop-protocol-rejected')
  const failedRetain = [
    record('retain-same', false, 400), record('retain-new', true),
    record('drop-same', false, 400), record('drop-new', true),
  ]
  assert.equal(classifyProtocolPilot(failedRetain).status, 'factorial-pilot-unidentifiable')
})

test('live fixture requires fixed results for every declared tool', async () => {
  const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'))
  assert.doesNotThrow(() => validateLiveReplayFixture(fixture))
  delete fixture.toolResultFixtures.bash
  assert.throws(() => validateLiveReplayFixture(fixture), /toolResultFixtures\.bash/)
  const changedSurface = JSON.parse(await readFile(FIXTURE, 'utf8'))
  changedSurface.tools[0].description += ' approximate'
  assert.throws(() => validateLiveReplayFixture(changedSurface), /frozen DSH surface proof/)
})

test('mechanical scorer separates protocol success from exact JSON correctness', () => {
  const expected = { answer: 7, nested: { ok: true } }
  assert.equal(scoreExpectedJson('{"nested":{"ok":true},"answer":7}', expected, true).answerCorrect, true)
  assert.equal(scoreExpectedJson('prefix {"answer":7,"nested":{"ok":true}} suffix', expected, true).answerCorrect, true)
  assert.equal(scoreExpectedJson('{"answer":8,"nested":{"ok":true}}', expected, true).answerCorrect, false)
  const failed = scoreExpectedJson('{"answer":7,"nested":{"ok":true}}', expected, false)
  assert.equal(failed.protocolSuccess, false)
  assert.equal(failed.answerCorrect, false)
})

test('official adapter live path passes mock E2E without exporting key, ids, bodies, or auth header', {
  skip: !existsSync(BUILT_ADAPTER),
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-live-replay-test-'))
  const output = join(directory, 'result.json')
  const key = 'CANARY-STDIN-LIVE-KEY-MUST-STAY-IN-MEMORY-9917'
  const ambient = 'CANARY-AMBIENT-KEY-MUST-NOT-BE-READ-2241'
  try {
    const run = spawnSync(process.execPath, [
      CLI,
      'request2-live-replay',
      '--fixture', FIXTURE,
      '--mock-script', MOCK_SUCCESS,
      '--repeat', '1',
      '--seed', 'live-mock-test-v1',
      '--out', output,
      '--api-key-stdin',
      '--harness-root', HARNESS_ROOT,
      '--timeout-ms', '30000',
    ], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      input: key,
      env: { ...process.env, DEEPSEEK_API_KEY: ambient },
      timeout: 30_000,
    })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    const raw = await readFile(output, 'utf8')
    for (const forbidden of [key, ambient, '10000000-0000-4000-8000-000000000001', '"rawBody"']) {
      assert.equal(raw.includes(forbidden), false, `artifact leaked ${forbidden}`)
    }
    assert.doesNotMatch(raw, /"authorization"\s*:/i)
    assert.equal(run.stdout.includes(key), false)
    assert.equal(run.stderr.includes(key), false)
    assert.equal((await stat(output)).mode & 0o777, 0o600)

    const artifact = JSON.parse(raw)
    assert.equal(artifact.status, 'completed')
    assert.equal(artifact.transport, 'in-process-mock')
    assert.equal(artifact.plan.repeat, 1)
    assert.equal(artifact.samples.length, 4)
    assert.equal(artifact.completedSamples, 4)
    assert.equal(artifact.design.liveTreatmentsPerSource, 1)
    assert.equal(artifact.scoring.preregistered, true)
    assert.equal(Object.values(artifact.exactMinimalSurface.checks).every(Boolean), true)
    assert.equal(artifact.exactMinimalSurface.surfaceSha256, '0fdd6bb5e6d5c44f5292f98bca22dc6a0313e2ce645743584849b73f5223133c')
    assert.equal(artifact.pilot.outcome.status, 'passed')
    assert.equal(artifact.pilot.units.length, 4)
    assert.equal(artifact.pilot.units.every(unit => unit.request1.response.reasoning.startsWith('We need')), true)
    assert.equal(artifact.pilot.units.every(unit => unit.request1.response.toolCalls[0].name === 'bash'), true)
    assert.equal(artifact.pilot.units.every(unit => unit.request1.request.identityHeadersMatch === true), true)
    assert.equal(artifact.pilot.units.every(unit => unit.request2.toolResultPairing.passed), true)
    for (const sample of artifact.samples) {
      assert.equal(sample.eligible, true)
      assert.equal(sample.request1.request.identityHeadersMatch, true)
      assert.equal(sample.request2.request.exactPreflightMatch, true)
      assert.equal(sample.request2.protocol.success, true)
      assert.equal(sample.request2.score.answerCorrect, true)
      assert.equal(sample.request2.response.reasoningDiagnostic.labelRole.includes('diagnostic-only'), true)
      assert.equal(Object.values(sample.conformance.checks).every(Boolean), true)
      assert.equal(sample.conformance.toolResultPairing.every(item => item.passed), true)
      assert.equal(sample.request2.request.headers.names.includes('authorization'), false)
      const planUnit = artifact.plan.blocks[0].allocation.find(unit => unit.unitId === sample.unitId)
      assert.equal(sample.sourceSessionIdSha256, planUnit.sourceSessionIdSha256)
      assert.equal(sample.request2SessionIdSha256, planUnit.request2SessionIdSha256)
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('controlled drop HTTP 400 pilot stops before every main sample', {
  skip: !existsSync(BUILT_ADAPTER),
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-live-replay-400-'))
  const output = join(directory, 'result.json')
  const key = 'CANARY-PILOT-400-KEY-7712'
  try {
    const run = spawnSync(process.execPath, [
      CLI,
      'request2-live-replay',
      '--fixture', FIXTURE,
      '--mock-script', MOCK_400,
      '--repeat', '1',
      '--seed', 'live-pilot-400-v1',
      '--out', output,
      '--api-key-stdin',
      '--harness-root', HARNESS_ROOT,
      '--timeout-ms', '30000',
    ], { cwd: PACKAGE_ROOT, encoding: 'utf8', input: key, timeout: 30_000 })
    assert.equal(run.status, 1, `${run.stdout}\n${run.stderr}`)
    const raw = await readFile(output, 'utf8')
    assert.equal(raw.includes(key), false)
    const artifact = JSON.parse(raw)
    assert.equal(artifact.status, 'drop-protocol-rejected')
    assert.equal(artifact.pilot.outcome.retainCellsSucceeded, true)
    assert.deepEqual(new Set(artifact.pilot.outcome.dropHttp400Cells), new Set(['drop-same', 'drop-new']))
    assert.equal(artifact.samples.length, 0)
    assert.equal(artifact.completedSamples, 0)
    assert.match(artifact.stopReason, /no main sample was sent/i)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('--pilot-only stops after four successful independent protocol cells', {
  skip: !existsSync(BUILT_ADAPTER),
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-live-replay-pilot-only-'))
  const output = join(directory, 'result.json')
  const key = 'CANARY-PILOT-ONLY-KEY-8813'
  try {
    const run = spawnSync(process.execPath, [
      CLI,
      'request2-live-replay',
      '--fixture', FIXTURE,
      '--mock-script', MOCK_SUCCESS,
      '--repeat', '1',
      '--seed', 'live-pilot-only-v1',
      '--out', output,
      '--api-key-stdin',
      '--pilot-only',
      '--harness-root', HARNESS_ROOT,
      '--timeout-ms', '30000',
    ], { cwd: PACKAGE_ROOT, encoding: 'utf8', input: key, timeout: 30_000 })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    const raw = await readFile(output, 'utf8')
    assert.equal(raw.includes(key), false)
    const artifact = JSON.parse(raw)
    assert.equal(artifact.status, 'pilot-passed')
    assert.equal(artifact.pilot.outcome.allProtocolSuccess, true)
    assert.equal(artifact.pilot.units.length, 4)
    assert.equal(artifact.samples.length, 0)
    assert.equal(artifact.completedSamples, 0)
    assert.match(artifact.stopReason, /pilot-only/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('live worker has no environment or credential-file lookup', async () => {
  const worker = await readFile(new URL('../runtime/request2-live-replay-worker.mjs', import.meta.url), 'utf8')
  assert.equal(worker.includes('process.env'), false)
  assert.equal(worker.includes('readFile'), false)
  assert.equal(worker.includes('writeFile'), false)
  assert.equal(worker.includes('DEEPSEEK_API_KEY'), false)
  assert.match(worker, /process\.stdin/)
})
