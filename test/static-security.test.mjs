import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'

test('runtime credentials provider does not read the API key from argv, env, or a file', async () => {
  const source = await readFile(new URL('../runtime/pipe-credentials.mjs', import.meta.url), 'utf8')
  assert.equal(source.includes('process.argv'), false)
  assert.equal(source.includes('process.env'), false)
  assert.equal(source.includes('readFile'), false)
  assert.equal(source.includes('writeFile'), false)
  assert.match(source, /process\.stdin/)
})

test('runtime report is built from an allowlist rather than raw session serialization', async () => {
  const source = await readFile(new URL('../runtime/lab-runner.mjs', import.meta.url), 'utf8')
  assert.equal(source.includes('JSON.stringify(agent.session.events)'), false)
  assert.equal(source.includes('process.env'), false)
  assert.match(source, /requestSummary/)
  assert.match(source, /toolNames/)
})
