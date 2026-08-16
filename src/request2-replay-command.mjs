import { execFileSync, spawn } from 'node:child_process'
import { access, readFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateReplayFixture } from './request2-replay.mjs'
import { writeJson } from './launcher.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const WORKER = join(PACKAGE_ROOT, 'runtime', 'request2-replay-worker.mjs')

function gitHead(path) {
  try {
    return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function nonCredentialEnvironment() {
  const env = {}
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

async function spawnWorker({ harnessRoot, fixtureText, timeoutMs = 30_000 }) {
  const builtAdapter = join(harnessRoot, 'packages', 'llm', 'llm-deepseek', 'lib', 'index.js')
  await access(builtAdapter, fsConstants.R_OK).catch(() => {
    throw new Error('official DeepSeek adapter build is missing; run `pnpm run build:lib` in deepseek-harness')
  })
  const child = spawn(process.execPath, [WORKER, harnessRoot], {
    cwd: PACKAGE_ROOT,
    env: nonCredentialEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  child.stdin.end(fixtureText)
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, timeoutMs)
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => clearTimeout(timer))
  const output = Buffer.concat(stdout).toString('utf8')
  const error = Buffer.concat(stderr).toString('utf8').trim()
  if (outcome.code !== 0) {
    throw new Error(`offline adapter worker failed${timedOut ? ' (timed out)' : ''}${error === '' ? '' : `: ${error}`}`)
  }
  const report = JSON.parse(output)
  if (!Object.values(report.checks ?? {}).every(Boolean)) throw new Error('offline adapter worker returned failed conformance checks')
  return { report, process: { exitCode: outcome.code, signal: outcome.signal, timedOut } }
}

/** Run the no-network, no-credential official-adapter replay command. */
export async function request2ReplayCommand(options) {
  if (options.fixture === undefined) throw new Error('request2-replay requires --fixture PATH')
  if (options.out === undefined) throw new Error('request2-replay requires --out PATH')
  const fixtureText = await readFile(options.fixture, 'utf8')
  const fixture = JSON.parse(fixtureText)
  validateReplayFixture(fixture)
  const result = await spawnWorker({ harnessRoot: options.harnessRoot, fixtureText, timeoutMs: options.timeoutMs })
  const artifact = {
    ...result.report,
    createdAt: new Date().toISOString(),
    harness: { commit: gitHead(options.harnessRoot) },
    platform: { os: process.platform, arch: process.arch, node: process.version },
    process: result.process,
    limitation: 'Raw official-adapter replay, not a forked live DSH Agent/Session lifecycle.',
  }
  await writeJson(options.out, artifact)
  process.stdout.write(`request2 raw replay: ${options.out}\n`)
  process.stdout.write(`${JSON.stringify(artifact.checks, null, 2)}\n`)
  return 0
}
