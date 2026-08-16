#!/usr/bin/env node

import { randomBytes } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { buildJobs, normalizeBaseUrl, readSecret, redactText } from './core.mjs'
import { inspectHarness, resultFilename, runJob, WORKSPACE_ROOT, writeJson } from './launcher.mjs'
import { request2LiveReplayCommand } from './request2-live-replay-command.mjs'
import { request2ReplayCommand } from './request2-replay-command.mjs'
import { schemaBridgeLiveCommand } from './schema-bridge-live-command.mjs'
import { SCHEMA_BRIDGE_FIXED_ROUTE, validateGenericSchemaBridgeRun } from './schema-bridge-live.mjs'
import { DEFAULT_COMPARISON, resolveStrategies, STRATEGIES } from './strategies.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))

const HELP = `dsh-lab-cli — isolated event-level DeepSeek Harness experiments

Usage:
  node src/cli.mjs list
  node src/cli.mjs doctor [--harness-root PATH]
  node src/cli.mjs smoke --strategy NAME [...] [options]
  node src/cli.mjs run --strategy NAME [...] (--task TEXT | --task-file PATH) [options]
  node src/cli.mjs request2-replay --fixture PATH --out PATH [--harness-root PATH]
  node src/cli.mjs request2-live-replay --fixture PATH --out PATH --api-key-stdin (--mock-script PATH | --allow-network) [options]
  node src/cli.mjs schema-bridge-live --oracle PATH --out PATH --api-key-stdin --allow-network --max-tokens 768 [options]

Core options:
  --strategy NAME              Repeatable; comma-separated, all, or all-known
  --model NAME                 Default: deepseek-v4-pro
  --provider NAME              Default: deepseek-official
  --base-url URL               Default: DEEPSEEK_BASE_URL or https://api.deepseek.com
  --reasoning-effort LEVEL     Usually high or max; default: max
  --temperature NUMBER
  --max-tokens INTEGER
  --capture MODE               summary | trajectory | full (default: trajectory)
  --workspace PATH             Agent cwd and process sandbox root (default: current cwd)
  --permission-mode MODE       read-only | workspace-write | danger-full-access
  --repeat INTEGER             Fresh-process repetitions per strategy (default: 1)
  --order ORDER                random | grouped (default: random)
  --identity MODE              fixed | rotate (default: fixed per batch)
  --seed TEXT                  Recorded shuffle seed; random when omitted
  --timeout-ms INTEGER         Per-process timeout (default: 900000)
  --out PATH                   Batch directory (default: runs/<timestamp>)
  --stop-after-first-assistant Capture the first model response and cancel
  --api-key-stdin              Read the key from stdin instead of DEEPSEEK_API_KEY
  --keep-runtime              Preserve temporary DSH_HOME for debugging (contains session data)
  --dry-run                   Write only the public batch manifest; no key required

Guarded request2 options:
  --mock-script PATH          Exercise the live transport path with in-process SSE fixtures
  --oracle PATH               Validate and bind the frozen v2 JSON oracle before credential read
  --allow-network             Explicit gate required when --mock-script is absent
  --pilot-only                Run the four-cell protocol pilot, never the main sample
  --max-tokens INTEGER        Required explicit cost bound for guarded network replay
  --repeat INTEGER            Randomized blocks; request2-live-replay default: 3

There is intentionally no --api-key value option: credentials never enter argv.
request2-replay is an offline raw official-adapter replay, not a live Agent fork;
it performs no network I/O and never reads an API key.
request2-live-replay is also transport-level (not an Agent fork). It uses one
independent request1 source per live treatment, a controlled four-cell protocol
pilot, and blocked random allocation (default --repeat 3). It never reads key
environment variables.
schema-bridge-live is a fixed real-Agent protocol: one four-arm pilot followed
by 40 contiguous identity×task Latin-square blocks (160 main requests). It
requires the frozen oracle and an output path that does not already exist.
`

function parse(argv) {
  const command = argv[0]
  if (!['run', 'smoke', 'request2-replay', 'request2-live-replay', 'schema-bridge-live', 'doctor', 'list', 'help', '--help', '-h'].includes(command)) {
    throw new Error('first argument must be run, smoke, request2-replay, request2-live-replay, schema-bridge-live, doctor, list, or help')
  }
  const options = {
    command,
    strategies: [],
    provider: 'deepseek-official',
    model: 'deepseek-v4-pro',
    reasoningEffort: 'max',
    capture: 'trajectory',
    captureExplicit: false,
    workspace: process.cwd(),
    workspaceExplicit: false,
    workspaceRoot: WORKSPACE_ROOT,
    harnessRoot: resolve(WORKSPACE_ROOT, 'deepseek-harness'),
    permissionMode: 'workspace-write',
    permissionModeExplicit: false,
    repeat: 1,
    repeatExplicit: false,
    order: 'random',
    orderExplicit: false,
    identity: 'fixed',
    identityExplicit: false,
    timeoutMs: 900_000,
    stopAfterFirstAssistant: false,
    apiKeyStdin: false,
    keepRuntime: false,
    dryRun: false,
  }
  const take = (args, index, flag) => {
    const value = args[index + 1]
    if (value === undefined || value.startsWith('--')) throw new Error(`${flag} needs a value`)
    return value
  }
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index]
    switch (arg) {
      case '--strategy': options.strategies.push(take(argv, index, arg)); index += 1; break
      case '--provider': options.provider = take(argv, index, arg); options.providerExplicit = true; index += 1; break
      case '--model': options.model = take(argv, index, arg); options.modelExplicit = true; index += 1; break
      case '--base-url': options.baseUrl = take(argv, index, arg); options.baseUrlExplicit = true; index += 1; break
      case '--reasoning-effort': options.reasoningEffort = take(argv, index, arg); options.reasoningEffortExplicit = true; index += 1; break
      case '--temperature': options.temperature = Number(take(argv, index, arg)); options.temperatureExplicit = true; index += 1; break
      case '--max-tokens': options.maxTokens = Number(take(argv, index, arg)); options.maxTokensExplicit = true; index += 1; break
      case '--capture': options.capture = take(argv, index, arg); options.captureExplicit = true; index += 1; break
      case '--workspace': options.workspace = resolve(take(argv, index, arg)); options.workspaceExplicit = true; index += 1; break
      case '--permission-mode': options.permissionMode = take(argv, index, arg); options.permissionModeExplicit = true; index += 1; break
      case '--repeat': options.repeat = Number(take(argv, index, arg)); options.repeatExplicit = true; index += 1; break
      case '--order': options.order = take(argv, index, arg); options.orderExplicit = true; index += 1; break
      case '--identity': options.identity = take(argv, index, arg); options.identityExplicit = true; index += 1; break
      case '--seed': options.seed = take(argv, index, arg); index += 1; break
      case '--timeout-ms': options.timeoutMs = Number(take(argv, index, arg)); options.timeoutExplicit = true; index += 1; break
      case '--out': options.out = resolve(take(argv, index, arg)); index += 1; break
      case '--harness-root': options.harnessRoot = resolve(take(argv, index, arg)); index += 1; break
      case '--task': options.task = take(argv, index, arg); index += 1; break
      case '--task-file': options.taskFile = resolve(take(argv, index, arg)); index += 1; break
      case '--fixture': options.fixture = resolve(take(argv, index, arg)); index += 1; break
      case '--mock-script': options.mockScript = resolve(take(argv, index, arg)); index += 1; break
      case '--oracle': options.oracle = resolve(take(argv, index, arg)); index += 1; break
      case '--allow-network': options.allowNetwork = true; break
      case '--pilot-only': options.pilotOnly = true; break
      case '--stop-after-first-assistant': options.stopAfterFirstAssistant = true; options.stopExplicit = true; break
      case '--api-key-stdin': options.apiKeyStdin = true; break
      case '--keep-runtime': options.keepRuntime = true; break
      case '--dry-run': options.dryRun = true; break
      case '--help': options.command = 'help'; break
      default: throw new Error(`unknown option ${arg}`)
    }
  }
  return options
}

function validate(options) {
  if (!Number.isInteger(options.repeat) || options.repeat < 1 || options.repeat > 1000) throw new Error('--repeat must be an integer from 1 to 1000')
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs < 1000) throw new Error('--timeout-ms must be an integer of at least 1000')
  if (options.temperature !== undefined && !Number.isFinite(options.temperature)) throw new Error('--temperature must be a number')
  if (options.maxTokens !== undefined && (!Number.isInteger(options.maxTokens) || options.maxTokens < 1)) throw new Error('--max-tokens must be a positive integer')
  if (!['summary', 'trajectory', 'full'].includes(options.capture)) throw new Error('--capture must be summary, trajectory, or full')
  if (!['random', 'grouped'].includes(options.order)) throw new Error('--order must be random or grouped')
  if (!['fixed', 'rotate'].includes(options.identity)) throw new Error('--identity must be fixed or rotate')
  if (!['read-only', 'workspace-write', 'danger-full-access'].includes(options.permissionMode)) {
    throw new Error('--permission-mode must be read-only, workspace-write, or danger-full-access')
  }
  if (options.task !== undefined && options.taskFile !== undefined) throw new Error('--task and --task-file are mutually exclusive')
}

function safeTimestamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

async function list() {
  for (const [name, entry] of Object.entries(STRATEGIES)) {
    const expected = entry.platformNote === undefined ? '' : `\n  ${entry.platformNote}`
    process.stdout.write(`${name.padEnd(22)} ${entry.status}\n  ${entry.evidence}${expected}\n`)
  }
  process.stdout.write(`\n\`all\` = ${DEFAULT_COMPARISON.join(', ')}\n`)
}

async function doctor(options) {
  const harness = await inspectHarness(options.harnessRoot)
  process.stdout.write(JSON.stringify({
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    harness,
    note: harness.dependenciesInstalled
      ? harness.runnable
        ? 'Ready for offline mount smoke and API runs.'
        : 'Dependencies are installed, but generated artifacts are missing; run `pnpm run build:lib` in the harness repository.'
      : 'Run `pnpm install --frozen-lockfile` in the harness repository before live or mount tests.',
  }, null, 2) + '\n')
}

async function batch(options) {
  validate(options)
  const strategies = resolveStrategies(options.strategies.length === 0 ? ['all'] : options.strategies)
  options.mode = options.command === 'smoke' ? 'mount' : 'run'
  const hasSchemaBridge = strategies.some(strategy => strategy.startsWith('schema-bridge-'))
  options.baseUrl = normalizeBaseUrl(options.baseUrl
    ?? (hasSchemaBridge ? SCHEMA_BRIDGE_FIXED_ROUTE.baseUrl : process.env.DEEPSEEK_BASE_URL ?? 'https://api.deepseek.com'))
  validateGenericSchemaBridgeRun(options, strategies)
  options.seed ??= randomBytes(16).toString('hex')
  options.out ??= resolve(PACKAGE_ROOT, 'runs', safeTimestamp())
  if (options.mode === 'run') {
    if (options.taskFile !== undefined) options.task = await readFile(options.taskFile, 'utf8')
    if (typeof options.task !== 'string' || options.task.trim() === '') throw new Error('run requires a non-empty --task or --task-file')
  } else {
    options.task = ''
  }

  const jobs = buildJobs(strategies, options.repeat, options.order, options.seed)
  const harness = await inspectHarness(options.harnessRoot)
  if (hasSchemaBridge && options.mode === 'run' && harness.gitHead !== SCHEMA_BRIDGE_FIXED_ROUTE.harnessCommit) {
    throw new Error(`schema bridge run requires Harness commit ${SCHEMA_BRIDGE_FIXED_ROUTE.harnessCommit}`)
  }
  if (hasSchemaBridge && options.mode === 'run' && harness.gitTrackedDirty !== false) {
    throw new Error('schema bridge run requires a clean Git-visible Harness worktree')
  }
  if (hasSchemaBridge && !harness.builtLauncher) {
    throw new Error('schema bridge requires the frozen built Harness launcher')
  }
  const manifest = {
    schemaVersion: 1,
    createdAt: new Date().toISOString(),
    mode: options.mode,
    seed: options.seed,
    order: options.order,
    identity: options.identity,
    repeat: options.repeat,
    strategies,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    harness,
    provider: options.provider,
    model: options.model,
    baseUrl: options.baseUrl,
    reasoningEffort: options.reasoningEffort,
    capture: options.capture,
    task: { sha256: (await import('./core.mjs')).sha256(options.task), chars: options.task.length },
    jobs,
    results: [],
  }
  await writeJson(resolve(options.out, 'batch.json'), manifest)
  if (options.dryRun) {
    process.stdout.write(`dry-run manifest: ${resolve(options.out, 'batch.json')}\n`)
    return 0
  }
  if (!harness.runnable) throw new Error('DeepSeek Harness is not runnable; use `doctor` and install its locked dependencies first')

  let secret = ''
  if (options.mode === 'run') {
    secret = options.apiKeyStdin
      ? await readSecret(process.stdin)
      : process.env.DEEPSEEK_API_KEY ?? ''
    if (secret.length === 0) {
      throw new Error('DEEPSEEK_API_KEY is not set; export it or use --api-key-stdin')
    }
  }

  let failures = 0
  const batchRuntimeHome = options.identity === 'fixed' ? await mkdtemp(join(tmpdir(), 'dsh-lab-batch-')) : undefined
  try {
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index]
      const sequence = index + 1
      process.stderr.write(`[${sequence}/${jobs.length}] ${job.strategy} repetition ${job.repetition}\n`)
      const record = await runJob({ ...options, sequence, runtimeHome: batchRuntimeHome }, job, secret)
      const filename = resultFilename(record)
      await writeJson(resolve(options.out, filename), record)
      const failed = record.process.exitCode !== 0
        || record.runtime === null
        || record.surfaceCheck?.matches === false
        || record.bridgeProtocolCheck?.matches === false
      if (failed) failures += 1
      manifest.results.push({
        sequence,
        strategy: job.strategy,
        repetition: job.repetition,
        file: filename,
        exitCode: record.process.exitCode,
        timedOut: record.process.timedOut,
        surfaceMatches: record.surfaceCheck?.matches ?? null,
        bridgeProtocolMatches: record.bridgeProtocolCheck?.matches ?? null,
        anonymousUserIdSha256: record.run.anonymousUserIdSha256 ?? null,
        sessionIdSha256: record.runtime?.requests?.length > 0
          ? record.runtime.sessionIdSha256 ?? null
          : null,
      })
      await writeJson(resolve(options.out, 'batch.json'), manifest)
    }
  } finally {
    secret = ''
    if (batchRuntimeHome !== undefined && !options.keepRuntime) {
      await rm(batchRuntimeHome, { recursive: true, force: true })
    } else if (batchRuntimeHome !== undefined) {
      manifest.runtimeDirectory = batchRuntimeHome
      await writeJson(resolve(options.out, 'batch.json'), manifest)
    }
  }
  process.stdout.write(`batch: ${options.out}\ncompleted: ${jobs.length - failures}/${jobs.length}\n`)
  return failures === 0 ? 0 : 1
}

async function main() {
  const options = parse(process.argv.slice(2))
  if (['help', '--help', '-h'].includes(options.command)) {
    process.stdout.write(HELP)
    return 0
  }
  if (options.command === 'list') {
    await list()
    return 0
  }
  if (options.command === 'doctor') {
    await doctor(options)
    return 0
  }
  if (options.command === 'request2-replay') return await request2ReplayCommand(options)
  if (options.command === 'request2-live-replay') return await request2LiveReplayCommand(options)
  if (options.command === 'schema-bridge-live') return await schemaBridgeLiveCommand(options)
  return await batch(options)
}

try {
  process.exitCode = await main()
} catch (error) {
  // Stdin-only and keyless paths must not even read an ambient credential.
  const argv = process.argv.slice(2)
  const bridgeStrategy = argv.some((argument, index) => argument === '--strategy'
    && argv[index + 1]?.split(',').some(value => value.startsWith('schema-bridge-') || value === 'all-known'))
  const keylessErrorPath = ['request2-replay', 'request2-live-replay', 'schema-bridge-live'].includes(argv[0])
    || bridgeStrategy
  const known = keylessErrorPath ? '' : process.env.DEEPSEEK_API_KEY ?? ''
  const message = error instanceof Error ? error.message : String(error)
  process.stderr.write(`dsh-lab-cli: ${redactText(message, [known])}\n`)
  process.exitCode = 2
}
