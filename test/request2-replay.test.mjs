import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { buildReplayMatrix, diffJson } from '../src/request2-replay.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const HARNESS_ROOT = join(PACKAGE_ROOT, '..', 'deepseek-harness')
const BUILT_ADAPTER = join(HARNESS_ROOT, 'packages', 'llm', 'llm-deepseek', 'lib', 'index.js')
const FIXTURE = join(PACKAGE_ROOT, 'experiments', 'request2-replay', 'fixtures', 'tool-call.json')
const CLI = join(PACKAGE_ROOT, 'src', 'cli.mjs')

test('matrix forks one frozen response without mutating the fixture', async () => {
  const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'))
  const before = JSON.stringify(fixture)
  const matrix = buildReplayMatrix(fixture)
  assert.equal(JSON.stringify(fixture), before)
  assert.equal(matrix.variants.length, 4)
  assert.ok(Object.isFrozen(matrix))

  const byId = Object.fromEntries(matrix.variants.map(variant => [variant.id, variant]))
  assert.equal(byId['retain-same'].options.sessionId, fixture.originalSessionId)
  assert.equal(byId['retain-new'].options.sessionId, fixture.newSessionId)
  assert.equal(byId['drop-same'].options.sessionId, fixture.originalSessionId)
  assert.equal(byId['drop-new'].options.sessionId, fixture.newSessionId)
  assert.equal(byId['retain-same'].options.messages[1].content.some(block => block.type === 'reasoning'), true)
  assert.equal(byId['drop-same'].options.messages[1].content.some(block => block.type === 'reasoning'), false)
  assert.deepEqual(
    byId['retain-same'].options.messages[1].content.filter(block => block.type !== 'reasoning'),
    byId['drop-same'].options.messages[1].content,
  )
})

test('fixture rejects ambiguous or non-tool-call response histories', async () => {
  const fixture = JSON.parse(await readFile(FIXTURE, 'utf8'))
  const second = structuredClone(fixture.messages[1])
  fixture.messages.push(second)
  assert.throws(() => buildReplayMatrix(fixture), /exactly one assistant message/)
  fixture.messages.pop()
  fixture.messages[1].content = fixture.messages[1].content.filter(block => block.type !== 'tool-call')
  assert.throws(() => buildReplayMatrix(fixture), /found 0/)
})

test('official adapter mock proves exact request2 body and header diffs without reading a key', {
  skip: !existsSync(BUILT_ADAPTER),
  timeout: 30_000,
}, async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'dsh-request2-replay-'))
  const output = join(outputDir, 'replay.json')
  const canary = 'CANARY-ENV-KEY-REQUEST2-MUST-NOT-BE-READ-8871'
  try {
    const run = spawnSync(process.execPath, [
      CLI,
      'request2-replay',
      '--fixture', FIXTURE,
      '--out', output,
      '--harness-root', HARNESS_ROOT,
    ], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      env: { ...process.env, DEEPSEEK_API_KEY: canary },
      timeout: 30_000,
    })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    const rawArtifact = await readFile(output, 'utf8')
    assert.equal(rawArtifact.includes(canary), false)
    assert.equal(rawArtifact.includes('offline-mock-bearer-not-a-credential'), false)
    assert.equal(run.stdout.includes(canary), false)
    assert.equal(run.stderr.includes(canary), false)
    assert.equal((await stat(output)).mode & 0o777, 0o600)

    const artifact = JSON.parse(rawArtifact)
    assert.equal(artifact.mode, 'raw-official-adapter-replay')
    assert.match(artifact.limitation, /not a forked live DSH Agent/)
    assert.equal(Object.values(artifact.checks).every(Boolean), true)
    const byId = Object.fromEntries(artifact.variants.map(variant => [variant.id, variant]))
    assert.equal(byId['retain-same'].rawBody, byId['retain-new'].rawBody)
    assert.equal(byId['drop-same'].rawBody, byId['drop-new'].rawBody)
    assert.equal(Object.hasOwn(byId['retain-same'].headers, 'authorization'), false)
    assert.equal(Object.hasOwn(byId['drop-new'].headers, 'authorization'), false)

    const retain = JSON.parse(byId['retain-same'].rawBody)
    const drop = JSON.parse(byId['drop-same'].rawBody)
    assert.deepEqual(diffJson(retain, drop).map(item => item.path), ['/messages/2/reasoning_content'])
    delete retain.messages[2].reasoning_content
    assert.equal(JSON.stringify(retain), byId['drop-same'].rawBody)
    assert.deepEqual(artifact.comparisons.retainSessionFactor.headerDiffPaths, ['/x-deepseek-harness-session-id'])
    assert.deepEqual(artifact.comparisons.dropSessionFactor.headerDiffPaths, ['/x-deepseek-harness-session-id'])
  } finally {
    await rm(outputDir, { recursive: true, force: true })
  }
})

test('offline worker has no environment or file credential lookup', async () => {
  const source = await readFile(new URL('../runtime/request2-replay-worker.mjs', import.meta.url), 'utf8')
  assert.equal(source.includes('process.env'), false)
  assert.equal(source.includes('readFile'), false)
  assert.equal(source.includes('DEEPSEEK_API_KEY'), false)
})
