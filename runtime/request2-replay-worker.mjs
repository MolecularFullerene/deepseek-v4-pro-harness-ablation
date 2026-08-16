/** Offline oracle: real DeepSeek adapter + mocked fetch, with no credential lookup. */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { analyzeReplayCaptures, buildReplayMatrix } from '../src/request2-replay.mjs'

const OFFLINE_BEARER_SENTINEL = 'offline-mock-bearer-not-a-credential'

async function readStdin() {
  const chunks = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  return Buffer.concat(chunks).toString('utf8')
}

function responseSse() {
  const events = [
    '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
    '{"choices":[{"delta":{"content":"offline replay acknowledged"}}]}',
    '{"choices":[{"delta":{"content":""},"finish_reason":"stop"}],"usage":{"prompt_tokens":1,"completion_tokens":1}}',
    '[DONE]',
  ]
  return events.map(event => `data: ${event}\n\n`).join('')
}

async function main() {
  const harnessRoot = resolve(process.argv[2] ?? '')
  const adapterUrl = pathToFileURL(resolve(harnessRoot, 'packages/llm/llm-deepseek/lib/index.js')).href
  const { DeepSeekAdapter, resolveAdapterOptions } = await import(adapterUrl)
  const fixture = JSON.parse(await readStdin())
  const matrix = buildReplayMatrix(fixture)
  const connection = resolveAdapterOptions({
    baseURL: 'https://offline-adapter.invalid',
    thinking: 'enabled',
    reasoningEffort: 'high',
  })
  const adapter = new DeepSeekAdapter({
    options: () => connection,
    resolveApiKey: () => Promise.resolve(OFFLINE_BEARER_SENTINEL),
    resolveUserId: () => fixture.anonymousUserId,
  })
  const captures = []
  let activeId
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    const headers = Object.fromEntries(new Headers(init.headers).entries())
    captures.push({ id: activeId, url: String(url), rawBody: String(init.body), headers })
    return new Response(responseSse(), { status: 200, headers: { 'content-type': 'text/event-stream' } })
  }
  try {
    for (const variant of matrix.variants) {
      activeId = variant.id
      for await (const _chunk of adapter.stream(variant.options)) { /* drain the mocked SSE */ }
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  const report = analyzeReplayCaptures(matrix, captures)
  process.stdout.write(JSON.stringify(report) + '\n')
}

try {
  await main()
} catch (error) {
  process.stderr.write(`request2-replay-worker: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exitCode = 1
}
