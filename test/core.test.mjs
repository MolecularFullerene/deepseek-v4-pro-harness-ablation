import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import {
  buildJobs, childEnvironment, configFingerprint, normalizeBaseUrl, redactText, seededShuffle, spawnWithSecret,
} from '../src/core.mjs'
import { expectedFirstSurface, resolveStrategies, strategySourcePath } from '../src/strategies.mjs'

test('base URLs are normalized without accepting credential-bearing URLs', () => {
  assert.equal(normalizeBaseUrl('https://api.deepseek.com/'), 'https://api.deepseek.com')
  assert.equal(normalizeBaseUrl('http://127.0.0.1:8080/v1'), 'http://127.0.0.1:8080/v1')
  assert.throws(() => normalizeBaseUrl('https://key@example.test'))
  assert.throws(() => normalizeBaseUrl('https://example.test/path?token=x'))
})

test('canonical public config fingerprints ignore object insertion order', () => {
  assert.equal(configFingerprint({ b: 2, a: { d: 4, c: 3 } }), configFingerprint({ a: { c: 3, d: 4 }, b: 2 }))
})

test('random order is deterministic and preserves all repeated jobs', () => {
  const left = buildJobs(['standard', 'minimal'], 3, 'random', 'seed-1')
  const right = buildJobs(['standard', 'minimal'], 3, 'random', 'seed-1')
  assert.deepEqual(left, right)
  assert.equal(left.length, 6)
  assert.notDeepEqual(seededShuffle([1, 2, 3, 4, 5], 'a'), seededShuffle([1, 2, 3, 4, 5], 'b'))
})

test('strategy groups exclude known-broken presets by default', () => {
  assert.deepEqual(resolveStrategies(['all']), ['standard', 'minimal', 'historical-anchored', 'anchored-standard'])
  assert.ok(resolveStrategies(['all-known']).includes('router-standard'))
  assert.equal(expectedFirstSurface('standard', 'darwin').length, 25)
  assert.equal(expectedFirstSurface('standard', 'win32')[1], 'pwsh')
  assert.deepEqual(expectedFirstSurface('historical-anchored', 'win32'), ['pwsh', 'read'])
  assert.deepEqual(expectedFirstSurface('historical-anchored', 'darwin'), ['bash', 'read'])
  assert.equal(
    strategySourcePath('/unrelated/workspace', 'schema-factor-persistent-editor'),
    fileURLToPath(new URL('../experiments/schema-factor/presets/persistent-editor', import.meta.url)),
  )
})

test('child environments strip credential-like values without dumping the parent environment', () => {
  const env = childEnvironment({
    PATH: '/bin',
    DEEPSEEK_API_KEY: 'secret',
    OTHER_TOKEN: 'token',
    API_KEY_BACKUP: 'backup',
    PLAIN: 'ok',
  }, { DSH_HOME: '/tmp/lab' })
  assert.deepEqual(env, { PATH: '/bin', PLAIN: 'ok', DSH_HOME: '/tmp/lab' })
})

test('authorization and exact secrets are redacted', () => {
  const key = 'CANARY-KEY-123'
  const redacted = redactText(`Bearer ${key}\nauthorization: ${key}\nraw=${key}`, [key])
  assert.equal(redacted.includes(key), false)
})

test('secret travels by stdin only and cannot survive returned stdout/stderr', async () => {
  const key = 'CANARY-KEY-DO-NOT-WRITE-9f312'
  const fixture = fileURLToPath(new URL('../fixtures/secret-child.mjs', import.meta.url))
  const outcome = await spawnWithSecret({
    command: process.execPath,
    args: [fixture],
    cwd: join(fixture, '..'),
    env: childEnvironment(process.env),
    secret: key,
    timeoutMs: 10_000,
  })
  assert.equal(outcome.code, 0)
  assert.equal(outcome.stdout.includes(key), false)
  assert.equal(outcome.stderr.includes(key), false)
  assert.deepEqual(JSON.parse(outcome.stdout.trim()), {
    argvHasSecret: false,
    envHasSecret: false,
    receivedBytes: Buffer.byteLength(key),
  })
})

test('dry-run artifacts do not contain an ambient canary API key', async () => {
  const key = 'CANARY-AMBIENT-KEY-DO-NOT-WRITE-7721'
  const output = await mkdtemp(join(tmpdir(), 'dsh-lab-dry-security-'))
  const cli = fileURLToPath(new URL('../src/cli.mjs', import.meta.url))
  try {
    const run = spawnSync(process.execPath, [
      cli, 'run', '--strategy', 'minimal', '--task', 'dry security check', '--dry-run', '--out', output,
    ], {
      encoding: 'utf8',
      env: { ...process.env, DEEPSEEK_API_KEY: key },
    })
    assert.equal(run.status, 0, run.stderr)
    for (const name of await readdir(output)) {
      const content = await readFile(join(output, name), 'utf8')
      assert.equal(content.includes(key), false, `${name} leaked the canary`)
    }
    assert.equal(run.stdout.includes(key), false)
    assert.equal(run.stderr.includes(key), false)
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})
