import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { apply as applyBridge } from '../experiments/schema-bridge/preset/schema-bridge.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const HARNESS_ROOT = join(PACKAGE_ROOT, '..', 'deepseek-harness')
const BUILT_CLI = join(HARNESS_ROOT, 'apps', 'cli', 'lib', 'bin.js')
const CLI = join(PACKAGE_ROOT, 'src', 'cli.mjs')
const SYSTEM_HASH = '5fab6e32f283d71510531ce850df2690b8fb77437d36bfabbe8c4ac862f19df9'
const EDITOR_RAW = '0948b7082aad2c337f314df4c3e62a779d9a0fdd03f04f07811d7c13e2f2ef3b'
const EXPECTED = {
  'schema-bridge-pp': 'fd7afc1cf7fcddd6569f0382dfd9b1a06c0b2b1e2302bd37a3927bee6959b1b1',
  'schema-bridge-po': 'b22421b472b4209f14a70aacccfc54bfc4f865a0f50fdabb250de8a1140566b2',
  'schema-bridge-op': 'fd23fda05ece071a86dfeded9de0ad09df71ff8796fbe2b3e11b36d29ccb12b3',
  'schema-bridge-oo': 'ce6ad0324e0e05d863eae734cde4a77ade47574b4c31ed4d2665c89c711ec9e9',
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function installBridge(arm) {
  const listeners = []
  const ctx = {
    tools: { guard() { return () => {} } },
    on(event, callback, options) {
      listeners.push({ event, callback, options })
      return () => {}
    },
  }
  applyBridge(ctx, { arm })
  return Object.fromEntries(listeners.map(listener => [listener.event, listener.callback]))
}

async function frozenMinimalAssembly() {
  const fixture = JSON.parse(await readFile(join(
    PACKAGE_ROOT, 'experiments', 'request2-live-replay-v2', 'fixtures', 'request1.json',
  ), 'utf8'))
  return {
    sections: [{ text: fixture.system }],
    contexts: [],
    tools: structuredClone(fixture.tools),
  }
}

test('schema bridge rejects unknown arms and installs two fail-closed execution barriers', async () => {
  assert.throws(() => applyBridge({ tools: {}, on() {} }, { arm: 'unknown' }), /arm must be one of/)
  let guard
  const listeners = []
  const ctx = {
    tools: {
      guard(callback) {
        guard = callback
        return () => {}
      },
    },
    on(event, callback, options) {
      listeners.push({ event, callback, options })
      return () => {}
    },
  }
  applyBridge(ctx, { arm: 'pp' })
  assert.match(guard({}), /diagnostic-only; tool execution disabled/)
  const tripwire = listeners.find(listener => listener.event === 'tools/execute')
  assert.deepEqual(tripwire.options, { prepend: true })
  await assert.rejects(() => tripwire.callback(), /dispatch reached/)
  assert.equal(listeners.some(listener => listener.event === 'system-prompt/assemble'), true)
})

test('all bridge arms enforce and transform the exact Minimal assembly and final stream surface', async () => {
  const persistent = await frozenMinimalAssembly()
  for (const [strategy, expectedBash] of Object.entries(EXPECTED)) {
    const arm = strategy.slice(-2)
    const listeners = installBridge(arm)
    const bridged = await listeners['system-prompt/assemble'](
      {}, { agent: { session: { events: [] } } }, async () => structuredClone(persistent),
    )
    assert.deepEqual(bridged.tools.map(tool => tool.name), ['bash', 'str_replace_editor'])
    assert.equal(sha256(JSON.stringify(bridged.tools[0])), expectedBash)
    assert.equal(sha256(JSON.stringify(bridged.tools[1])), EDITOR_RAW)
    const nextValue = Symbol('first stream')
    assert.equal(await listeners['llm/stream']({
      provider: 'deepseek-official',
      model: 'deepseek-v4-pro',
      reasoningEffort: 'max',
      maxTokens: 768,
      system: persistent.sections[0].text,
      tools: bridged.tools,
    }, async () => nextValue), nextValue)
    assert.throws(() => listeners['llm/stream']({
      provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max', maxTokens: 768,
      system: persistent.sections[0].text, tools: bridged.tools,
    }, () => {}), /second model stream is forbidden/)
  }
})

test('bridge assembly fails closed on context, tool-order, and second-request drift', async () => {
  const persistent = await frozenMinimalAssembly()
  const cases = [
    { mutate: value => { value.contexts.push({ text: 'ambient' }) }, pattern: /context surface drifted/ },
    { mutate: value => { value.tools.reverse() }, pattern: /tool order drifted/ },
  ]
  for (const example of cases) {
    const listeners = installBridge('pp')
    const value = structuredClone(persistent)
    example.mutate(value)
    await assert.rejects(() => listeners['system-prompt/assemble'](
      {}, { agent: { session: { events: [] } } }, async () => value,
    ), example.pattern)
  }
  const listeners = installBridge('pp')
  await assert.rejects(() => listeners['system-prompt/assemble'](
    {}, { agent: { session: { events: [{ type: 'request/header' }] } } }, async () => structuredClone(persistent),
  ), /second model request is forbidden/)

  const finalSurface = installBridge('pp')
  assert.throws(() => finalSurface['llm/stream']({
    provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max', maxTokens: 768,
    system: `${persistent.sections[0].text} drift`, tools: persistent.tools,
  }, async () => {}), /outbound Minimal system hash drifted/)
})

test('all four bridge arms pass a real DSH mount with exact raw schemas', {
  skip: !existsSync(BUILT_CLI),
  timeout: 30_000,
}, async () => {
  const output = await mkdtemp(join(tmpdir(), 'dsh-schema-bridge-test-'))
  const canary = 'CANARY-SCHEMA-BRIDGE-KEY-MUST-NOT-SURVIVE'
  try {
    const run = spawnSync(process.execPath, [
      CLI,
      'smoke',
      '--strategy', Object.keys(EXPECTED).join(','),
      '--order', 'grouped',
      '--capture', 'full',
      '--base-url', 'https://api.deepseek.com',
      '--out', output,
      '--harness-root', HARNESS_ROOT,
    ], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      env: {
        ...Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot']
          .filter(key => process.env[key] !== undefined)
          .map(key => [key, process.env[key]])),
        DEEPSEEK_API_KEY: canary,
      },
      timeout: 30_000,
    })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
    const names = (await readdir(output)).filter(name => /^\d{4}-.*\.json$/.test(name))
    assert.equal(names.length, 4)
    for (const filename of names) {
      const text = await readFile(join(output, filename), 'utf8')
      assert.equal(text.includes(canary), false)
      const record = JSON.parse(text)
      const strategy = record.run.config.strategy
      assert.equal(record.process.exitCode, 0)
      assert.equal(record.surfaceCheck.matches, true)
      assert.deepEqual(record.runtime.mountTools, ['bash', 'str_replace_editor'])
      assert.equal(record.runtime.mountSystem.sha256, SYSTEM_HASH)
      const bash = record.runtime.mountToolSchemas[0]
      const editor = record.runtime.mountToolSchemas[1]
      assert.equal(sha256(JSON.stringify(bash)), EXPECTED[strategy])
      assert.equal(sha256(JSON.stringify(editor)), EDITOR_RAW)
    }
  } finally {
    await rm(output, { recursive: true, force: true })
  }
})
