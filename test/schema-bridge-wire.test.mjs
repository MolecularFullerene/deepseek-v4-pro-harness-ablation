import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { access, mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { execFileSync } from 'node:child_process'
import { test } from 'node:test'
import { runJob, WORKSPACE_ROOT } from '../src/launcher.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const HARNESS_ROOT = join(PACKAGE_ROOT, '..', 'deepseek-harness')
const BUILT_CLI = join(HARNESS_ROOT, 'apps', 'cli', 'lib', 'bin.js')
const FETCH_MOCK = join(PACKAGE_ROOT, 'fixtures', 'schema-bridge-fetch-mock.mjs')
const SYSTEM_HASH = '5fab6e32f283d71510531ce850df2690b8fb77437d36bfabbe8c4ac862f19df9'
const EXPECTED = {
  'schema-bridge-pp': [
    'fd7afc1cf7fcddd6569f0382dfd9b1a06c0b2b1e2302bd37a3927bee6959b1b1',
    '0948b7082aad2c337f314df4c3e62a779d9a0fdd03f04f07811d7c13e2f2ef3b',
  ],
  'schema-bridge-po': [
    'b22421b472b4209f14a70aacccfc54bfc4f865a0f50fdabb250de8a1140566b2',
    '0948b7082aad2c337f314df4c3e62a779d9a0fdd03f04f07811d7c13e2f2ef3b',
  ],
  'schema-bridge-op': [
    'fd23fda05ece071a86dfeded9de0ad09df71ff8796fbe2b3e11b36d29ccb12b3',
    '0948b7082aad2c337f314df4c3e62a779d9a0fdd03f04f07811d7c13e2f2ef3b',
  ],
  'schema-bridge-oo': [
    'ce6ad0324e0e05d863eae734cde4a77ade47574b4c31ed4d2665c89c711ec9e9',
    '0948b7082aad2c337f314df4c3e62a779d9a0fdd03f04f07811d7c13e2f2ef3b',
  ],
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

function harnessClean() {
  try {
    return execFileSync('git', ['-C', HARNESS_ROOT, 'status', '--porcelain'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() === ''
  } catch {
    return false
  }
}

const INTEGRATION_AVAILABLE = existsSync(BUILT_CLI)
  && `${process.platform}-${process.arch}` === 'darwin-arm64'
  && harnessClean()

function fixedOptions(sequence, strategy, capture, marker, status = '200') {
  return {
    command: 'run',
    mode: 'run',
    sequence,
    workspace: PACKAGE_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
    harnessRoot: HARNESS_ROOT,
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    baseUrl: 'https://api.deepseek.com',
    reasoningEffort: 'max',
    temperature: undefined,
    maxTokens: 768,
    timeoutMs: 900_000,
    capture: 'trajectory',
    permissionMode: 'read-only',
    stopAfterFirstAssistant: true,
    apiKeyStdin: true,
    allowNetwork: true,
    keepRuntime: false,
    task: 'Inspect package.json and report only its public package name. Do not modify anything.',
    schemaBridgeTestMode: true,
    testOnlySchemaBridgeTransport: {
      NODE_OPTIONS: `--import=${pathToFileURL(FETCH_MOCK).href}`,
      DSH_WIRE_CAPTURE: capture,
      DSH_WIRE_MARKER: marker,
      DSH_WIRE_STATUS: status,
    },
  }
}

async function absent(path) {
  try {
    await access(path)
    return false
  } catch {
    return true
  }
}

test('official adapter wire body preserves exact four-arm system/tool schemas and never dispatches', {
  skip: !INTEGRATION_AVAILABLE,
  timeout: 60_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'schema-bridge-wire-'))
  try {
    for (const [index, strategy] of Object.keys(EXPECTED).entries()) {
      const capture = join(directory, `${strategy}.jsonl`)
      const marker = join(directory, `${strategy}.executor-ran`)
      const record = await runJob(
        fixedOptions(index + 1, strategy, capture, marker),
        { strategy, repetition: 1 },
        'TEST-ONLY-WIRE-SECRET-CANARY',
      )
      assert.equal(existsSync(capture), true, JSON.stringify(record))
      const lines = (await readFile(capture, 'utf8')).trim().split('\n').map(JSON.parse)
      assert.equal(lines.length, 1, `${strategy} made more than one intercepted fetch`)
      const wire = lines[0]
      assert.equal(wire.url, 'https://api.deepseek.com/chat/completions')
      assert.equal(wire.method, 'POST')
      assert.equal(wire.authorizationPresent, true)
      assert.equal(JSON.stringify(wire).includes('TEST-ONLY-WIRE-SECRET-CANARY'), false)
      assert.equal(wire.body.messages[0].role, 'system')
      assert.equal(sha256(wire.body.messages[0].content), SYSTEM_HASH)
      assert.deepEqual(wire.body.tools.map(tool => tool.function.name), ['bash', 'str_replace_editor'])
      assert.deepEqual(wire.body.tools.map(tool => sha256(JSON.stringify(tool.function))), EXPECTED[strategy])
      assert.equal(wire.body.max_tokens, 768)
      assert.equal(Object.hasOwn(wire.body, 'temperature'), false)
      assert.equal(record.process.exitCode, 0)
      assert.equal(record.runtime.requestHeaderCount, 1)
      assert.equal(record.runtime.assistantMessageCount, 1)
      assert.equal(record.runtime.retryCount, 0)
      assert.equal(record.runtime.toolCalls.length, 1)
      assert.equal(record.runtime.toolResults.length, 1)
      assert.equal(record.runtime.toolResults[0].error.code, 'ABORTED_BEFORE_DISPATCH')
      assert.equal(record.bridgeProtocolCheck.checks.noDispatch, true)
      assert.equal(record.run.config.environmentMode, 'test-only-transport-override')
      assert.equal(record.bridgeProtocolCheck.matches, false, 'test preload must never masquerade as formal attestation')
      assert.equal(await absent(marker), true, 'persistent executor body unexpectedly ran')
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('retryable adapter failure still produces exactly one intercepted fetch', {
  skip: !INTEGRATION_AVAILABLE,
  timeout: 30_000,
}, async () => {
  const directory = await mkdtemp(join(tmpdir(), 'schema-bridge-wire-500-'))
  const capture = join(directory, 'attempts.jsonl')
  const marker = join(directory, 'executor-ran')
  try {
    const record = await runJob(
      fixedOptions(1, 'schema-bridge-pp', capture, marker, '500'),
      { strategy: 'schema-bridge-pp', repetition: 1 },
      'TEST-ONLY-WIRE-SECRET-CANARY',
    )
    assert.equal(existsSync(capture), true, JSON.stringify(record))
    const lines = (await readFile(capture, 'utf8')).trim().split('\n')
    assert.equal(lines.length, 1, 'llm-retry or recovery emitted a second provider fetch')
    assert.notEqual(record.process.exitCode, 0)
    assert.equal(await absent(marker), true)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
