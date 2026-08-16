import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { existsSync } from 'node:fs'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const HARNESS_ROOT = join(PACKAGE_ROOT, '..', 'deepseek-harness')
const BUILT_LAUNCHER = join(HARNESS_ROOT, 'apps', 'cli', 'lib', 'bin.js')
const CLI = join(PACKAGE_ROOT, 'src', 'cli.mjs')

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

async function walkFiles(root) {
  const found = []
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) found.push(child)
    }
  }
  await visit(root)
  return found
}

async function run(command, args, options) {
  const child = spawn(command, args, { ...options, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = []
  const stderr = []
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  const result = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  })
  return {
    ...result,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }
}

test('real DSH adapter keeps a canary key in memory and cancels before first tool dispatch', {
  skip: !existsSync(BUILT_LAUNCHER),
  timeout: 60_000,
}, async (t) => {
  const canary = 'CANARY-REAL-ADAPTER-KEY-DO-NOT-WRITE-1182'
  const out = await mkdtemp(join(tmpdir(), 'dsh-lab-integration-out-'))
  const forbiddenMarker = join(out, 'TOOL-MUST-NOT-RUN')
  let runtimeHome
  const received = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk.toString('utf8') })
    request.on('end', () => {
      received.push({ path: request.url, headers: request.headers, body: JSON.parse(body) })
      const events = [
        '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
        '{"choices":[{"delta":{"reasoning_content":"offline plan"}}]}',
        JSON.stringify({ choices: [{ delta: { tool_calls: [{
          index: 0,
          id: 'call_offline_guard',
          type: 'function',
          function: { name: 'bash', arguments: JSON.stringify({ command: `touch ${forbiddenMarker}` }) },
        }] } }] }),
        '{"choices":[{"delta":{"content":""},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":3,"completion_tokens":2}}',
        '[DONE]',
      ]
      response.writeHead(200, { 'content-type': 'text/event-stream' })
      for (const event of events) response.write(`data: ${event}\n\n`)
      response.end()
    })
  })
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(0, '127.0.0.1', resolve)
    })
  } catch (error) {
    if (error?.code === 'EPERM') {
      t.skip('sandbox does not permit a loopback listener; run this test outside network sandboxing')
      return
    }
    throw error
  }
  const address = server.address()
  if (address === null || typeof address === 'string') throw new Error('mock server did not bind a TCP port')

  try {
    const result = await run(process.execPath, [
      CLI,
      'run',
      '--strategy', 'minimal',
      '--task', 'Reply briefly.',
      '--model', 'deepseek-v4-pro',
      '--base-url', `http://127.0.0.1:${address.port}`,
      '--reasoning-effort', 'max',
      '--stop-after-first-assistant',
      '--order', 'grouped',
      '--out', out,
      '--keep-runtime',
    ], {
      cwd: PACKAGE_ROOT,
      env: { ...process.env, DEEPSEEK_API_KEY: canary },
    })
    const debugManifest = await readFile(join(out, 'batch.json'), 'utf8').catch(() => '')
    const debugResultName = debugManifest === '' ? undefined : JSON.parse(debugManifest).results?.[0]?.file
    const debugRecord = debugResultName === undefined
      ? ''
      : await readFile(join(out, debugResultName), 'utf8').catch(() => '')
    assert.equal(result.code, 0, `${result.stderr}\n${result.stdout}\n${debugManifest}\n${debugRecord}`)
    assert.equal(result.stdout.includes(canary), false)
    assert.equal(result.stderr.includes(canary), false)
    assert.equal(received.length, 1)
    assert.equal(received[0].path, '/chat/completions')
    assert.equal(received[0].headers.authorization, `Bearer ${canary}`)
    assert.ok(received[0].headers['x-deepseek-harness-user-id'])
    assert.ok(received[0].headers['x-deepseek-harness-session-id'])
    assert.deepEqual(received[0].body.tools.map(tool => tool.function.name), ['bash', 'str_replace_editor'])

    const manifest = JSON.parse(await readFile(join(out, 'batch.json'), 'utf8'))
    runtimeHome = manifest.runtimeDirectory
    assert.equal(manifest.results.length, 1)
    assert.equal(
      manifest.results[0].anonymousUserIdSha256,
      sha256(received[0].headers['x-deepseek-harness-user-id']),
    )
    assert.equal(
      manifest.results[0].sessionIdSha256,
      sha256(received[0].headers['x-deepseek-harness-session-id']),
    )

    const resultName = manifest.results[0].file
    const record = JSON.parse(await readFile(join(out, resultName), 'utf8'))
    assert.deepEqual(record.runtime.requests[0].toolNames, ['bash', 'str_replace_editor'])
    assert.equal(record.runtime.assistantMessages[0].reasoningPassbackEligible, true)
    assert.equal(record.runtime.assistantMessages[0].blocks[0].text, 'offline plan')
    assert.equal(record.runtime.toolResults[0].error.code, 'ABORTED_BEFORE_DISPATCH')
    assert.equal(existsSync(forbiddenMarker), false)
    assert.equal(record.runtime.turnEnds.at(-1).reason.kind, 'aborted')

    const needle = Buffer.from(canary)
    for (const root of [out, runtimeHome]) {
      for (const path of await walkFiles(root)) {
        const content = await readFile(path)
        assert.equal(content.includes(needle), false, `${path} persisted the canary key`)
      }
    }
  } finally {
    if (server.listening) await new Promise(resolve => server.close(resolve))
    await rm(out, { recursive: true, force: true })
    if (runtimeHome !== undefined && dirname(runtimeHome) === tmpdir()) {
      await rm(runtimeHome, { recursive: true, force: true })
    }
  }
})
