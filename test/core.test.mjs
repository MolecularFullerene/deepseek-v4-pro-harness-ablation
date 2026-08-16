import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import { test } from 'node:test'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import {
  buildJobs, childEnvironment, configFingerprint, minimalChildEnvironment, normalizeBaseUrl, readSecret, redactText, seededShuffle, spawnWithSecret,
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
  assert.equal(
    strategySourcePath('/unrelated/workspace', 'schema-bridge-po'),
    fileURLToPath(new URL('../experiments/schema-bridge/preset', import.meta.url)),
  )
  assert.deepEqual(expectedFirstSurface('schema-bridge-op', 'darwin'), ['bash', 'str_replace_editor'])
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

test('formal minimal child environments drop ambient preload, proxy, cloud, and DSH configuration', () => {
  const env = minimalChildEnvironment({
    PATH: '/bin',
    LANG: 'C.UTF-8',
    NODE_OPTIONS: '--import /tmp/canary.mjs',
    NODE_PATH: '/tmp/canary-modules',
    HTTPS_PROXY: 'http://proxy.invalid',
    SSL_CERT_FILE: '/tmp/canary.pem',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    AWS_PROFILE: 'canary',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/google.json',
    AZURE_CONFIG_DIR: '/tmp/azure',
    DSH_HOME: '/tmp/ambient-dsh',
    DEEPSEEK_BASE_URL: 'https://ambient.invalid',
    DEEPSEEK_API_KEY: 'secret',
  }, {
    HOME: '/tmp/private-home',
    DSH_HOME: '/tmp/private-home',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  })
  assert.deepEqual(env, {
    PATH: '/bin',
    LANG: 'C.UTF-8',
    HOME: '/tmp/private-home',
    DSH_HOME: '/tmp/private-home',
    DEEPSEEK_BASE_URL: 'https://api.deepseek.com',
  })
})

test('authorization and exact secrets are redacted', () => {
  const key = 'CANARY-KEY-123'
  const redacted = redactText(`Bearer ${key}\nauthorization: ${key}\nraw=${key}`, [key])
  assert.equal(redacted.includes(key), false)
})

test('TTY secret input disables echo and restores terminal mode', async () => {
  const input = new PassThrough()
  const prompt = new PassThrough()
  const signals = new EventEmitter()
  const promptChunks = []
  const promptRawStates = []
  const dataListenerRawStates = []
  const modes = []
  input.isTTY = true
  input.isRaw = false
  const originalOn = input.on
  input.on = function (event, listener) {
    if (event === 'data') dataListenerRawStates.push(input.isRaw)
    return originalOn.call(this, event, listener)
  }
  input.setRawMode = value => {
    modes.push(value)
    input.isRaw = value
  }
  prompt.on('data', chunk => {
    promptRawStates.push(input.isRaw)
    promptChunks.push(chunk)
  })
  const pending = readSecret(input, 64 * 1024, prompt, signals)
  assert.deepEqual(dataListenerRawStates, [true], 'stdin must not start flowing before raw mode is active')
  assert.equal(promptRawStates[0], true, 'the hidden prompt must appear only after raw mode is active')
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(signal), 1)
  input.write('PUBLIC-HIDDEN-INPUT')
  input.write('\r')
  assert.equal(await pending, 'PUBLIC-HIDDEN-INPUT')
  assert.deepEqual(modes, [true, false])
  assert.equal(input.isRaw, false)
  const visible = Buffer.concat(promptChunks).toString('utf8')
  assert.match(visible, /input hidden/)
  assert.equal(visible.includes('PUBLIC-HIDDEN-INPUT'), false)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(signal), 0)
})

test('TTY secret input fails closed on close and restores mode and listeners', async () => {
  const input = new PassThrough()
  const prompt = new PassThrough()
  const signals = new EventEmitter()
  const modes = []
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = value => {
    modes.push(value)
    input.isRaw = value
  }

  const pending = readSecret(input, 64 * 1024, prompt, signals)
  input.emit('close')
  await assert.rejects(pending, /TTY stdin closed before API key input completed/)
  assert.deepEqual(modes, [true, false])
  assert.equal(input.isRaw, false)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(signal), 0)
})

test('TTY secret input restores mode once and removes listeners for termination signals', async () => {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    const input = new PassThrough()
    const prompt = new PassThrough()
    const signals = new EventEmitter()
    const modes = []
    input.isTTY = true
    input.isRaw = false
    input.setRawMode = value => {
      modes.push(value)
      input.isRaw = value
    }

    const pending = readSecret(input, 64 * 1024, prompt, signals)
    assert.equal(signals.emit(signal), true)
    assert.equal(input.isRaw, false, `${signal} must restore the terminal synchronously`)
    await assert.rejects(pending, new RegExp(signal))
    assert.deepEqual(modes, [true, false], `${signal} must not restore raw mode twice`)
    assert.equal(input.destroyed, true, `${signal} must release the resumed stdin handle`)
    for (const candidate of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      assert.equal(signals.listenerCount(candidate), 0)
    }
    assert.equal(signals.emit(signal), false, `${signal} handler must not leak past the read`)
    assert.deepEqual(modes, [true, false])
  }
})

test('TTY secret input restores mode when writing the prompt fails', async () => {
  const input = new PassThrough()
  const signals = new EventEmitter()
  const modes = []
  input.isTTY = true
  input.isRaw = false
  input.setRawMode = value => {
    modes.push(value)
    input.isRaw = value
  }
  const prompt = {
    write() {
      throw new Error('synthetic prompt failure')
    },
  }

  await assert.rejects(readSecret(input, 64 * 1024, prompt, signals), /synthetic prompt failure/)
  assert.deepEqual(modes, [true, false])
  assert.equal(input.isRaw, false)
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(signal), 0)
})

test('piped secret input aborts promptly under lifecycle governance', async () => {
  const input = new PassThrough()
  const controller = new AbortController()
  const pending = readSecret(input, 64 * 1024, new PassThrough(), new EventEmitter(), controller.signal)
  controller.abort(new Error('synthetic credential-stage signal'))
  await assert.rejects(pending, /synthetic credential-stage signal/)
  assert.equal(input.destroyed, true)
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

test('child timeout hard-kills a process that refuses SIGTERM within a bounded deadline', async () => {
  const started = Date.now()
  const outcome = await spawnWithSecret({
    command: process.execPath,
    args: ['-e', "process.on('SIGTERM',()=>process.stdout.write('TERM\\n')); process.stdout.write('READY\\n'); setInterval(()=>{},1000)"],
    cwd: process.cwd(),
    env: childEnvironment(process.env),
    timeoutMs: 500,
    terminationGraceMs: 50,
    killSettleMs: 100,
  })
  assert.equal(outcome.timedOut, true)
  assert.equal(outcome.overflow, false)
  assert.equal(outcome.forcedKill, true)
  assert.equal(outcome.signal, 'SIGKILL')
  assert.match(outcome.stdout, /READY/)
  assert.match(outcome.stdout, /TERM/)
  assert.ok(Date.now() - started < 2_000, 'timeout termination exceeded its hard settle bound')
})

test('output overflow hard-kills a process that refuses SIGTERM within a bounded deadline', async () => {
  const script = [
    "process.on('SIGTERM',()=>{})",
    "process.stdout.write('READY\\n')",
    "const chunk='x'.repeat(65536)",
    'setInterval(()=>process.stdout.write(chunk),0)',
  ].join(';')
  const started = Date.now()
  const outcome = await spawnWithSecret({
    command: process.execPath,
    args: ['-e', script],
    cwd: process.cwd(),
    env: childEnvironment(process.env),
    timeoutMs: 10_000,
    maxOutputBytes: 1_024,
    terminationGraceMs: 50,
    killSettleMs: 100,
  })
  assert.equal(outcome.timedOut, false)
  assert.equal(outcome.overflow, true)
  assert.equal(outcome.forcedKill, true)
  assert.equal(outcome.signal, 'SIGKILL')
  assert.ok(Date.now() - started < 2_000, 'overflow termination exceeded its hard settle bound')
})

test('an AbortSignal terminates the current child and does not wait for the normal timeout', async () => {
  const controller = new AbortController()
  const abortTimer = setTimeout(() => controller.abort(new Error('synthetic lifecycle signal')), 500)
  const started = Date.now()
  try {
    const outcome = await spawnWithSecret({
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM',()=>{}); process.stdout.write('READY\\n'); setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      env: childEnvironment(process.env),
      timeoutMs: 10_000,
      signal: controller.signal,
      terminationGraceMs: 50,
      killSettleMs: 100,
    })
    assert.equal(outcome.aborted, true)
    assert.equal(outcome.timedOut, false)
    assert.equal(outcome.forcedKill, true)
    assert.equal(outcome.signal, 'SIGKILL')
    assert.ok(Date.now() - started < 2_000, 'AbortSignal did not terminate the child within the hard bound')
  } finally {
    clearTimeout(abortTimer)
  }
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
