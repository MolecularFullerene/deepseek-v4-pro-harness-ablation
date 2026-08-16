import { randomBytes } from 'node:crypto'
import { execFileSync, spawn } from 'node:child_process'
import { access, lstat, mkdir, readFile, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, normalizeBaseUrl, readSecret, redactText, redactValue, sha256 } from './core.mjs'
import { writeJson } from './launcher.mjs'
import { verifyOfficialMinimalSurface } from './minimal-surface-verifier.mjs'
import {
  buildLiveReplayPlan, publicLiveReplayPlan, validateLiveReplayFixture,
} from './request2-live-replay.mjs'
import {
  validateV2Oracle, validateV2Preflight, v2ArtifactIntegritySha256,
} from '../experiments/request2-live-replay-v2/score-artifact.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const WORKER = join(PACKAGE_ROOT, 'runtime', 'request2-live-replay-worker.mjs')
const DEFAULT_BASE_URL = 'https://api.deepseek.com'

async function requireFreshOutput(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error('refusing to overwrite an existing --out file')
}

async function writeInitialJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('refusing to overwrite an existing --out file')
    throw error
  }
}

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

async function spawnWorker({ harnessRoot, protocol, secret, timeoutMs }) {
  const builtAdapter = join(harnessRoot, 'packages', 'llm', 'llm-deepseek', 'lib', 'index.js')
  const builtLlm = join(harnessRoot, 'packages', 'llm', 'llm', 'lib', 'index.js')
  await Promise.all([builtAdapter, builtLlm].map(path => access(path, fsConstants.R_OK))).catch(() => {
    throw new Error('official DeepSeek adapter build is missing; run `pnpm run build:lib` in deepseek-harness')
  })
  const child = spawn(process.execPath, [WORKER, harnessRoot], {
    cwd: PACKAGE_ROOT,
    env: nonCredentialEnvironment(),
    stdio: ['pipe', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  let outputBytes = 0
  let overflow = false
  const collect = target => chunk => {
    outputBytes += chunk.length
    if (outputBytes > 32 * 1024 * 1024) {
      overflow = true
      child.kill('SIGTERM')
      return
    }
    target.push(chunk)
  }
  child.stdout.on('data', collect(stdout))
  child.stderr.on('data', collect(stderr))
  child.stdin.on('error', () => {})
  child.stdin.end(JSON.stringify({ ...protocol, apiKey: secret }))
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, timeoutMs)
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => clearTimeout(timer))
  const output = redactText(Buffer.concat(stdout).toString('utf8'), [secret])
  const error = redactText(Buffer.concat(stderr).toString('utf8'), [secret]).trim()
  if (outcome.code !== 0 || overflow) {
    throw new Error(`live replay worker failed${timedOut ? ' (timed out)' : ''}${overflow ? ' (output limit exceeded)' : ''}${error === '' ? '' : `: ${error}`}`)
  }
  return {
    report: JSON.parse(output),
    process: { exitCode: outcome.code, signal: outcome.signal, timedOut, outputOverflow: overflow },
  }
}

/** Run the guarded official-adapter transport replay; never resolve a key outside stdin. */
export async function request2LiveReplayCommand(options) {
  if (options.fixture === undefined) throw new Error('request2-live-replay requires --fixture PATH')
  if (options.out === undefined) throw new Error('request2-live-replay requires --out PATH')
  if (!options.apiKeyStdin) throw new Error('request2-live-replay requires --api-key-stdin; environment and argv credentials are forbidden')
  if (options.mockScript !== undefined && options.allowNetwork) throw new Error('--mock-script and --allow-network are mutually exclusive')
  if (options.mockScript === undefined && !options.allowNetwork) {
    throw new Error('refusing transport: use --mock-script PATH for offline E2E or explicitly add --allow-network')
  }

  const repeat = options.repeatExplicit ? options.repeat : 3
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error('live --repeat must be an integer from 1 to 100')
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000) throw new Error('--timeout-ms must be an integer of at least 1000')
  if (typeof options.provider !== 'string' || options.provider.length === 0) throw new Error('--provider must be non-empty')
  if (typeof options.model !== 'string' || options.model.length === 0) throw new Error('--model must be non-empty')
  if (!['high', 'max'].includes(options.reasoningEffort)) throw new Error('request2-live-replay requires --reasoning-effort high or max')
  if (options.temperature !== undefined && !Number.isFinite(options.temperature)) throw new Error('--temperature must be a number')
  if (options.maxTokens !== undefined && (!Number.isSafeInteger(options.maxTokens) || options.maxTokens < 1)) {
    throw new Error('--max-tokens must be a positive safe integer')
  }
  if (options.allowNetwork && options.maxTokens === undefined) {
    throw new Error('network request2-live-replay requires explicit --max-tokens to bound pilot/main cost')
  }
  // Check before fixture/oracle reads or a keyless harness mount, then use an
  // exclusive first write below to close the check/create race before stdin or transport.
  await requireFreshOutput(options.out)
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
  const seed = options.seed ?? randomBytes(16).toString('hex')
  const fixtureText = await readFile(options.fixture, 'utf8')
  const fixture = validateLiveReplayFixture(JSON.parse(fixtureText))
  const fixtureSha256 = sha256(fixtureText)
  const externalOracleText = options.oracle === undefined ? undefined : await readFile(options.oracle, 'utf8')
  const externalOracle = externalOracleText === undefined
    ? undefined
    : validateV2Oracle(JSON.parse(externalOracleText))
  const externalOracleSha256 = externalOracle === undefined ? null : sha256(canonicalJson(externalOracle))
  const surfaceVerification = await verifyOfficialMinimalSurface({
    harnessRoot: options.harnessRoot,
    fixture,
    timeoutMs: Math.min(options.timeoutMs, 60_000),
  })
  const mockScript = options.mockScript === undefined
    ? undefined
    : JSON.parse(await readFile(options.mockScript, 'utf8'))
  const mockScriptSha256 = mockScript === undefined ? null : sha256(canonicalJson(mockScript))
  const transport = mockScript === undefined ? 'explicit-network' : 'in-process-mock'
  const harnessCommit = gitHead(options.harnessRoot)
  if (externalOracle !== undefined) {
    validateV2Preflight({
      oracleInput: externalOracle,
      fixtureSha256,
      harnessCommit,
      exactMinimalSurface: surfaceVerification,
      transport,
      provider: options.provider,
      model: options.model,
      baseUrl,
      mockScriptSha256,
      reasoningEffort: options.reasoningEffort,
      temperature: options.temperature ?? null,
      maxTokens: options.maxTokens ?? null,
      repeat,
      seed,
    })
  }
  const privatePlan = buildLiveReplayPlan({ repeat, seed })
  const plan = publicLiveReplayPlan(privatePlan)
  const configFingerprint = sha256(canonicalJson({
    provider: options.provider,
    model: options.model,
    baseUrl,
    reasoningEffort: options.reasoningEffort,
    temperature: options.temperature ?? null,
    maxTokens: options.maxTokens ?? null,
    repeat,
    pilotOnly: options.pilotOnly === true,
    seed,
    fixtureSha256,
    mockScriptSha256,
    surfaceSha256: surfaceVerification.surfaceSha256,
    planSha256: plan.sha256,
    externalOracleSha256,
  }))
  const planned = {
    schemaVersion: 1,
    mode: 'official-adapter-request2-transport-replay',
    status: 'planned',
    createdAt: new Date().toISOString(),
    transport,
    credentialMode: 'api-key-stdin only; process memory only; never argv/environment/artifact',
    provider: options.provider,
    model: options.model,
    baseUrl,
    reasoningEffort: options.reasoningEffort,
    temperature: options.temperature ?? null,
    maxTokens: options.maxTokens ?? null,
    repeat,
    pilotOnly: options.pilotOnly === true,
    seed,
    fixtureSha256,
    mockScriptSha256,
    configFingerprint,
    anonymousUserIdSha256: sha256(fixture.anonymousUserId),
    exactMinimalSurface: surfaceVerification,
    scoring: {
      preregistered: true,
      method: 'extract exactly one JSON object; canonical deep equality against expectedJson',
      expectedJson: fixture.expectedJson,
      expectedJsonSha256: sha256(canonicalJson(fixture.expectedJson)),
      protocolSuccessIsSeparate: true,
      reasoningPrefixLabelsAreDiagnosticOnly: true,
      externalOracleSha256,
    },
    plan,
    harness: { commit: harnessCommit },
    platform: { os: process.platform, arch: process.arch, node: process.version },
    limitation: 'Guarded transport-level serializer replay with independent request1 source sessions; not a DSH Agent/Session fork.',
  }
  // Freeze the complete allocation and stopping rule on disk before any key is read or request is made.
  await writeInitialJson(options.out, planned)

  let secret = ''
  try {
    secret = await readSecret(process.stdin)
    if (fixtureText.includes(secret)
      || JSON.stringify(mockScript ?? {}).includes(secret)
      || (externalOracleText?.includes(secret) ?? false)) {
      throw new Error('refusing to run because the stdin credential also appears in a non-secret experiment file')
    }
    const { report, process: processFacts } = await spawnWorker({
      harnessRoot: options.harnessRoot,
      secret,
      timeoutMs: options.timeoutMs,
      protocol: {
        protocolVersion: 1,
        baseUrl,
        provider: options.provider,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
        ...(options.maxTokens === undefined ? {} : { maxTokens: options.maxTokens }),
        fixture,
        plan: privatePlan,
        pilotOnly: options.pilotOnly === true,
        ...(mockScript === undefined ? { allowNetwork: true } : { mockScript }),
      },
    })
    if (report.planSha256 !== plan.sha256) throw new Error('worker plan fingerprint does not match the pre-frozen manifest')
    const artifactPayload = redactValue({
      ...planned,
      ...report,
      plan,
      finishedAt: new Date().toISOString(),
      process: processFacts,
    }, [secret])
    const artifact = {
      ...artifactPayload,
      integritySha256: v2ArtifactIntegritySha256(artifactPayload),
    }
    await writeJson(options.out, artifact)
    process.stdout.write(`request2 guarded transport replay: ${options.out}\n`)
    process.stdout.write(`status: ${artifact.status}; main samples: ${artifact.samples?.length ?? 0}\n`)
    return ['completed', 'pilot-passed'].includes(artifact.status) ? 0 : 1
  } catch (error) {
    const message = redactText(error instanceof Error ? error.message : String(error), [secret])
    await writeJson(options.out, { ...planned, status: 'worker-failed', finishedAt: new Date().toISOString(), error: { message } })
    throw new Error(message)
  } finally {
    secret = ''
  }
}
