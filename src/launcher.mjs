import { randomUUID, createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import {
  access, cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile,
} from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import {
  childEnvironment, configFingerprint, minimalChildEnvironment, parseRuntimeReport, redactValue, sha256, spawnWithSecret,
} from './core.mjs'
import { expectedFirstSurface, STRATEGIES, strategySourcePath } from './strategies.mjs'
import { SCHEMA_BRIDGE_SURFACE } from '../experiments/schema-bridge/preset/schema-bridge.mjs'
import { SCHEMA_BRIDGE_PROTOCOL_CLOSURE_SHA256 } from './schema-bridge-live.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
export const WORKSPACE_ROOT = resolve(PACKAGE_ROOT, '..')
const RUNTIME_ROOT = join(PACKAGE_ROOT, 'runtime')

async function exists(path) {
  try {
    await access(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function gitHead(path) {
  try {
    return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function gitTrackedDirty(path) {
  try {
    return execFileSync('git', ['-C', path, 'status', '--porcelain'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() !== ''
  } catch {
    return null
  }
}

export async function digestDirectory(root) {
  const hash = createHash('sha256')
  async function visit(path) {
    const entries = await readdir(path, { withFileTypes: true })
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name === '.git' || entry.name === 'node_modules') continue
      const child = join(path, entry.name)
      if (entry.isDirectory()) await visit(child)
      else if (entry.isFile()) {
        hash.update(relative(root, child))
        hash.update('\0')
        hash.update(await readFile(child))
        hash.update('\0')
      }
    }
  }
  await visit(root)
  return hash.digest('hex')
}

export async function makeSchemaBridgeProtocolSnapshot() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-schema-bridge-protocol-'))
  try {
    await mkdir(join(root, 'runtime'), { recursive: true })
    await Promise.all([
      cp(join(RUNTIME_ROOT, 'pipe-credentials.mjs'), join(root, 'runtime', 'pipe-credentials.mjs')),
      cp(join(RUNTIME_ROOT, 'lab-runner.mjs'), join(root, 'runtime', 'lab-runner.mjs')),
      cp(join(PACKAGE_ROOT, 'experiments', 'schema-bridge', 'preset'), join(root, 'preset'), {
        recursive: true, errorOnExist: true,
      }),
    ])
    return { root, sha256: await digestDirectory(root) }
  } catch (error) {
    await rm(root, { recursive: true, force: true }).catch(() => {})
    throw error
  }
}

export async function inspectHarness(harnessRoot) {
  const source = join(harnessRoot, 'apps', 'cli', 'src', 'bin.ts')
  const built = join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
  const tsx = join(harnessRoot, 'node_modules', 'tsx')
  const cordis = join(harnessRoot, 'apps', 'cli', 'node_modules', '@deepseek-ai', 'cordis')
  const typertHost = join(harnessRoot, 'packages', 'interaction', 'commands', 'lib', 'typert.host.js')
  const themeClient = join(harnessRoot, 'packages', 'client', 'ui-theme', 'lib', 'client.js')
  const dependenciesInstalled = await exists(tsx) && await exists(cordis)
  const hostArtifactsBuilt = await exists(typertHost)
  const clientArtifactsBuilt = await exists(themeClient)
  return {
    harnessRoot,
    gitHead: gitHead(harnessRoot),
    gitTrackedDirty: gitTrackedDirty(harnessRoot),
    sourceLauncher: await exists(source),
    builtLauncher: await exists(built),
    dependenciesInstalled,
    hostArtifactsBuilt,
    clientArtifactsBuilt,
    runnable: dependenciesInstalled
      && hostArtifactsBuilt
      && clientArtifactsBuilt
      && (await exists(built) || await exists(source)),
  }
}

function launcherInvocation(harnessRoot) {
  const built = join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
  const source = join(harnessRoot, 'apps', 'cli', 'src', 'bin.ts')
  const tsxLoader = join(harnessRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
  return exists(built).then(hasBuilt => hasBuilt
    ? { mode: 'built-js', command: process.execPath, args: [built] }
    : { mode: 'source-tsx', command: process.execPath, args: ['--import', pathToFileURL(tsxLoader).href, source] })
}

function yaml(value) {
  return JSON.stringify(value)
}

function renderPatch(config) {
  const optional = []
  if (config.reasoningEffort !== undefined) optional.push(`        reasoningEffort: ${yaml(config.reasoningEffort)}`)
  if (config.temperature !== undefined) optional.push(`        temperature: ${String(config.temperature)}`)
  if (config.maxTokens !== undefined) optional.push(`        maxTokens: ${String(config.maxTokens)}`)
  return `# Generated in an ephemeral directory by dsh-lab-cli. Contains no credential.
# The headless bundle normally keeps model-facing rows in the host plane. Once
# an AgentPresets roster is introduced those rows must move behind presets, as
# they do in the official Web bundle; otherwise Minimal silently inherits the
# Standard/global catalog and is not an exact two-tool experiment.
- id: tool-bash
  disabled: true

- id: tool-pwsh
  disabled: true

- id: tool-jobs
  disabled: true

- id: tool-fs
  disabled: true

- id: tool-fs-search
  disabled: true

- id: tool-str-replace-editor
  disabled: true

- id: skill-filesystem
  disabled: true

- id: tool-skill
  disabled: true

- id: tool-goal
  disabled: true

- id: plan-mode
  disabled: true

- id: compaction-basic
  disabled: true

- id: command-compact
  disabled: true

- id: tool-result-pruner
  disabled: true

- id: tool-subagent-control
  disabled: true

- id: tool-subagent-list-agents
  disabled: true

- id: tool-subagent
  disabled: true

- id: tool-subagent-fork
  disabled: true

- id: workflow-worker-thread
  disabled: true

- id: tool-workflow
  disabled: true

- id: tool-ralph
  disabled: true

- id: agent-instructions
  disabled: true

- id: tool-todo
  disabled: true

- id: tool-web
  disabled: true

- id: headless-startup
  disabled: true

- id: headless-runner
  disabled: true

- id: session-title-llm
  disabled: true

${config.disableLlmRetry ? '- id: llm-retry\n  disabled: true\n' : ''}
- id: credentials
  disabled: true

- id: sandbox-policy
  config:
    mode: ${yaml(config.permissionMode)}
    workspaceRoot: ${yaml(config.workspace)}

- insert:
    - id: dsh-lab-pipe-credentials
      name: ./pipe-credentials.mjs
      config:
        ref: DEEPSEEK_API_KEY
        allowEmpty: ${config.mode === 'mount' ? 'true' : 'false'}

    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard

    - id: dsh-lab-runner
      name: ./lab-runner.mjs
      inject: [agentDefaultModel, agents, sessions, agentPresets]
      config:
        mode: ${yaml(config.mode)}
        task: ${yaml(config.task ?? '')}
        strategy: ${yaml(config.strategy)}
        preset: ${yaml(config.preset)}
        cwd: ${yaml(config.workspace)}
        provider: ${yaml(config.provider)}
        model: ${yaml(config.model)}
        capture: ${yaml(config.capture)}
        stopAfterFirstAssistant: ${config.stopAfterFirstAssistant ? 'true' : 'false'}
${optional.join('\n')}${optional.length === 0 ? '' : '\n'}`
}

async function stageRuntime({ tempHome, strategyName, workspaceRoot, patchConfig }) {
  const profileDir = join(tempHome, 'profiles', 'headless')
  await mkdir(profileDir, { recursive: true })
  const runtimeRoot = patchConfig.protocolSnapshotRoot === undefined
    ? RUNTIME_ROOT
    : join(patchConfig.protocolSnapshotRoot, 'runtime')
  await Promise.all([
    cp(join(runtimeRoot, 'pipe-credentials.mjs'), join(profileDir, 'pipe-credentials.mjs')),
    cp(join(runtimeRoot, 'lab-runner.mjs'), join(profileDir, 'lab-runner.mjs')),
  ])
  const source = patchConfig.protocolSnapshotRoot !== undefined
    && STRATEGIES[strategyName].schemaBridgeArm !== undefined
    ? join(patchConfig.protocolSnapshotRoot, 'preset')
    : strategySourcePath(workspaceRoot, strategyName)
  if (source !== undefined) {
    if (!await exists(source)) throw new Error(`strategy source is missing: ${source}`)
    const presetDir = join(tempHome, '.agent-presets', STRATEGIES[strategyName].preset)
    await mkdir(dirname(presetDir), { recursive: true })
    if (!await exists(presetDir)) await cp(source, presetDir, { recursive: true, errorOnExist: true })
  }
  const patchPath = join(profileDir, 'dsh-lab.patch.yml')
  await writeFile(patchPath, renderPatch(patchConfig), { mode: 0o600 })
  return { patchPath, profileDir, presetSource: source }
}

function publicRunConfig(options, job, source, launcherMode) {
  const strategy = STRATEGIES[job.strategy]
  const task = options.task ?? ''
  const bridgeTestOverride = strategy.schemaBridgeArm !== undefined
    && options.schemaBridgeTestMode === true
    && options.testOnlySchemaBridgeTransport !== undefined
  return {
    mode: options.mode,
    strategy: job.strategy,
    repetition: job.repetition,
    preset: STRATEGIES[job.strategy].preset,
    strategyStatus: STRATEGIES[job.strategy].status,
    experimentalFactors: strategy.experimentalFactors ?? null,
    expectedFirstSurface: expectedFirstSurface(job.strategy, process.platform) ?? null,
    platformQualification: STRATEGIES[job.strategy].platformNote ?? null,
    provider: options.provider,
    model: options.model,
    baseUrl: options.baseUrl,
    reasoningEffort: options.reasoningEffort ?? null,
    temperature: options.temperature ?? null,
    maxTokens: options.maxTokens ?? null,
    timeoutMs: options.timeoutMs,
    capture: options.capture,
    stopAfterFirstAssistant: options.stopAfterFirstAssistant,
    llmRetry: strategy.schemaBridgeArm === undefined ? null : false,
    credentialMode: options.mode === 'mount'
      ? 'none/keyless'
      : options.apiKeyStdin === true ? 'stdin' : 'ambient-environment',
    networkGate: options.allowNetwork === true,
    permissionMode: options.permissionMode,
    task: { sha256: sha256(task), chars: task.length },
    harnessCommit: gitHead(options.harnessRoot),
    strategyCommit: options.strategyCommit
      ?? (source === undefined ? gitHead(options.harnessRoot) : gitHead(source)),
    strategyFilesSha256: source === undefined ? null : undefined,
    protocolClosureSha256: options.protocolClosureSha256 ?? null,
    environmentMode: strategy.schemaBridgeArm === undefined
      ? 'filtered-inherit'
      : bridgeTestOverride ? 'test-only-transport-override' : 'minimal-allowlist',
    launcherMode,
  }
}

function runtimeLogs(stdout) {
  return stdout.split(/\r?\n/).filter(line => !line.startsWith('DSH_LAB_RESULT ')).join('\n').trim()
}

function assertSchemaBridgeRunOptions(options, strategy) {
  if (strategy.schemaBridgeArm === undefined || options.mode !== 'run') return
  const fixed = [
    [options.stopAfterFirstAssistant === true, '--stop-after-first-assistant'],
    [options.apiKeyStdin === true, '--api-key-stdin'],
    [options.allowNetwork === true, '--allow-network'],
    [options.maxTokens === 768, '--max-tokens 768'],
    [options.capture === 'trajectory', '--capture trajectory'],
    [options.permissionMode === 'read-only', '--permission-mode read-only'],
    [options.reasoningEffort === 'max', '--reasoning-effort max'],
    [options.temperature === undefined, 'temperature null (omit --temperature)'],
    [options.timeoutMs === 900_000, '--timeout-ms 900000'],
    [options.provider === 'deepseek-official', '--provider deepseek-official'],
    [options.model === 'deepseek-v4-pro', '--model deepseek-v4-pro'],
    [options.baseUrl === 'https://api.deepseek.com', '--base-url https://api.deepseek.com'],
    [`${process.platform}-${process.arch}` === 'darwin-arm64', 'platform darwin-arm64'],
    [gitHead(options.harnessRoot) === '47f943859bef60e4160492346772ded9b24f765a', 'frozen Harness commit'],
    [gitTrackedDirty(options.harnessRoot) === false, 'clean Git-visible Harness worktree'],
  ]
  const missing = fixed.filter(([accepted]) => !accepted).map(([, label]) => label)
  if (missing.length > 0) {
    throw new Error(`schema bridge live runs are guarded; required fixed controls: ${missing.join(', ')}`)
  }
}

function schemaBridgeProtocolCheck(runtime, publicConfig, arm) {
  if (arm === undefined || publicConfig.mode !== 'run') return null
  const toolCalls = runtime?.toolCalls ?? []
  const toolResults = runtime?.toolResults ?? []
  const checks = {
    runtimeMode: runtime?.mode === 'run',
    fixedRunControls: publicConfig.stopAfterFirstAssistant === true
      && publicConfig.llmRetry === false
      && publicConfig.credentialMode === 'stdin'
      && publicConfig.networkGate === true
      && publicConfig.capture === 'trajectory'
      && publicConfig.permissionMode === 'read-only'
      && publicConfig.reasoningEffort === 'max'
      && publicConfig.temperature === null
      && publicConfig.maxTokens === 768
      && publicConfig.timeoutMs === 900_000
      && publicConfig.environmentMode === 'minimal-allowlist'
      && publicConfig.launcherMode === 'built-js'
      && publicConfig.protocolClosureSha256 === SCHEMA_BRIDGE_PROTOCOL_CLOSURE_SHA256,
    exactlyOneRequestHeader: runtime?.requestHeaderCount === 1 && runtime?.requests?.length === 1,
    exactlyOneAssistant: runtime?.assistantMessageCount === 1 && runtime?.assistantMessages?.length === 1,
    noRetry: runtime?.retryCount === 0,
    exactRequestConfig: runtime.requests?.[0]?.config?.provider === 'deepseek-official'
      && runtime.requests?.[0]?.config?.model === 'deepseek-v4-pro'
      && runtime.requests?.[0]?.config?.reasoningEffort === 'max'
      && runtime.requests?.[0]?.config?.maxTokens === 768
      && runtime.requests?.[0]?.config?.temperature === undefined
      && runtime.requests?.[0]?.config?.stop === undefined
      && JSON.stringify(Object.keys(runtime.requests?.[0]?.config ?? {}).sort())
        === JSON.stringify(['maxTokens', 'model', 'provider', 'reasoningEffort']),
    exactSystem: runtime.requests?.[0]?.system?.sha256 === SCHEMA_BRIDGE_SURFACE.systemRawSha256,
    exactToolOrder: JSON.stringify(runtime.requests?.[0]?.toolNames)
      === JSON.stringify(SCHEMA_BRIDGE_SURFACE.orderedToolNames),
    exactRawToolSchemas: JSON.stringify(runtime?.requests?.[0]?.tools?.map(tool => tool.schemaRawSha256 ?? tool.schemaSha256))
      === JSON.stringify([SCHEMA_BRIDGE_SURFACE.armRawSha256[arm], SCHEMA_BRIDGE_SURFACE.editorRawSha256]),
    noDispatch: toolResults.length === toolCalls.length
      && toolResults.every(result => result.error?.code === 'ABORTED_BEFORE_DISPATCH'),
  }
  return { matches: Object.values(checks).every(Boolean), checks }
}

function testOnlySchemaBridgeTransportEnvironment(options) {
  const value = options.testOnlySchemaBridgeTransport
  if (value === undefined) return {}
  if (options.schemaBridgeTestMode !== true || value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('schema bridge test transport overrides require explicit in-process test mode')
  }
  const allowed = new Set(['NODE_OPTIONS', 'DSH_WIRE_CAPTURE', 'DSH_WIRE_MARKER', 'DSH_WIRE_STATUS'])
  if (Object.keys(value).some(key => !allowed.has(key))) {
    throw new Error('schema bridge test transport contains a non-allowlisted environment key')
  }
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string'))
}

/** Run one fresh DSH process and return an allowlisted, redacted record. */
export async function runJob(options, job, secret = '') {
  const strategy = STRATEGIES[job.strategy]
  let ownedProtocolSnapshot = null
  const ownsRuntime = options.runtimeHome === undefined
  const tempHome = options.runtimeHome ?? await mkdtemp(join(tmpdir(), 'dsh-lab-'))
  const runId = `${String(options.sequence).padStart(4, '0')}-${job.strategy}-${randomUUID()}`
  let record
  try {
    assertSchemaBridgeRunOptions(options, strategy)
    if (strategy.schemaBridgeArm !== undefined && options.protocolSnapshotRoot === undefined) {
      const snapshot = await makeSchemaBridgeProtocolSnapshot()
      if (snapshot.sha256 !== SCHEMA_BRIDGE_PROTOCOL_CLOSURE_SHA256) {
        await rm(snapshot.root, { recursive: true, force: true })
        throw new Error('schema bridge protocol closure digest drifted')
      }
      ownedProtocolSnapshot = snapshot.root
      options = {
        ...options,
        protocolSnapshotRoot: snapshot.root,
        protocolClosureSha256: snapshot.sha256,
        strategyCommit: gitHead(PACKAGE_ROOT),
      }
    }
    const patchConfig = {
      ...options,
      strategy: job.strategy,
      preset: strategy.preset,
      disableLlmRetry: strategy.schemaBridgeArm !== undefined,
    }
    const staged = await stageRuntime({
      tempHome,
      strategyName: job.strategy,
      workspaceRoot: options.workspaceRoot,
      patchConfig,
    })
    const invocation = await launcherInvocation(options.harnessRoot)
    if (strategy.schemaBridgeArm !== undefined && invocation.mode !== 'built-js') {
      throw new Error('schema bridge requires the frozen built Harness launcher')
    }
    const publicConfig = publicRunConfig(options, job, staged.presetSource, invocation.mode)
    if (staged.presetSource !== undefined) {
      publicConfig.strategyFilesSha256 = await digestDirectory(staged.presetSource)
    }
    const fingerprint = configFingerprint(publicConfig)
    const environmentOverrides = {
      HOME: tempHome,
      USERPROFILE: tempHome,
      XDG_CONFIG_HOME: join(tempHome, '.config'),
      XDG_CACHE_HOME: join(tempHome, '.cache'),
      XDG_DATA_HOME: join(tempHome, '.local', 'share'),
      DSH_HOME: tempHome,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: options.permissionMode,
      DSH_CWD: options.workspace,
      DEEPSEEK_BASE_URL: options.baseUrl,
      ...(strategy.schemaBridgeArm === undefined ? {} : { DSH_SCHEMA_BRIDGE_ARM: strategy.schemaBridgeArm }),
    }
    const childEnv = strategy.schemaBridgeArm === undefined
      ? childEnvironment(process.env, environmentOverrides)
      : minimalChildEnvironment(process.env, {
          ...environmentOverrides,
          // Deliberately unreachable from the CLI: local wire-conformance
          // tests use this to preload a no-network fetch interceptor.
          ...testOnlySchemaBridgeTransportEnvironment(options),
        })
    const startedAt = new Date().toISOString()
    const outcome = await spawnWithSecret({
      command: invocation.command,
      args: [...invocation.args, '--profile', 'headless', '--patch', staged.patchPath],
      // Generic source launches need the Harness root for tsx path mappings.
      // Guarded bridge launches require built JS and use the private home as
      // cwd, preventing project/Harness .env discovery; DSH_CWD remains the
      // read-only experiment workspace.
      cwd: strategy.schemaBridgeArm === undefined ? options.harnessRoot : tempHome,
      env: childEnv,
      secret,
      timeoutMs: options.timeoutMs,
      signal: options.abortSignal,
    })
    const runtime = parseRuntimeReport(outcome.stdout)
    let anonymousUserIdSha256 = null
    try {
      const identity = (await readFile(join(tempHome, '.anonymous-user-id'), 'utf8')).trim()
      if (identity !== '') anonymousUserIdSha256 = sha256(identity)
    } catch {
      // A failure before the identity provider initialized has no id to record.
    }
    const actualFirstSurface = runtime?.requests?.[0]?.toolNames ?? runtime?.mountTools ?? null
    const expected = publicConfig.expectedFirstSurface
    const bridgeProtocolCheck = schemaBridgeProtocolCheck(runtime, publicConfig, strategy.schemaBridgeArm)
    record = {
      schemaVersion: 1,
      run: {
        id: runId,
        sequence: options.sequence,
        startedAt,
        finishedAt: new Date().toISOString(),
        configFingerprint: fingerprint,
        anonymousUserIdSha256,
        config: publicConfig,
      },
      process: {
        exitCode: outcome.code,
        signal: outcome.signal,
        timedOut: outcome.timedOut,
        outputOverflow: outcome.overflow,
        ...(runtimeLogs(outcome.stdout) === '' ? {} : { stdout: runtimeLogs(outcome.stdout) }),
        ...(outcome.stderr.trim() === '' ? {} : { stderr: outcome.stderr.trim() }),
      },
      surfaceCheck: {
        expected,
        actual: actualFirstSurface,
        matches: expected === null || actualFirstSurface === null
          ? null
          : JSON.stringify(expected) === JSON.stringify(actualFirstSurface),
        historicalWindowsReproduction: job.strategy === 'historical-anchored'
          ? process.platform === 'win32' && JSON.stringify(actualFirstSurface) === JSON.stringify(['pwsh', 'read'])
          : null,
      },
      ...(bridgeProtocolCheck === null ? {} : { bridgeProtocolCheck }),
      runtime: runtime ?? null,
    }
  } catch (error) {
    record = {
      schemaVersion: 1,
      run: {
        id: runId,
        sequence: options.sequence,
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        config: {
          strategy: job.strategy,
          repetition: job.repetition,
          provider: options.provider,
          model: options.model,
          baseUrl: options.baseUrl,
          platform: process.platform,
        },
      },
      process: { exitCode: null, signal: null, timedOut: false, outputOverflow: false },
      error: { name: error instanceof Error ? error.name : 'Error', message: error instanceof Error ? error.message : String(error) },
      runtime: null,
    }
  } finally {
    const cleanup = []
    if (ownedProtocolSnapshot !== null) cleanup.push(rm(ownedProtocolSnapshot, { recursive: true, force: true }))
    if (ownsRuntime && !options.keepRuntime) cleanup.push(rm(tempHome, { recursive: true, force: true }))
    const settled = await Promise.allSettled(cleanup)
    if (options.keepRuntime) record.runtimeDirectory = tempHome
    if (settled.some(result => result.status === 'rejected')) {
      throw new Error('failed to remove private schema bridge launcher state')
    }
  }
  return redactValue(record, [secret])
}

export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true })
  await writeFile(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 })
}

export function resultFilename(record) {
  return `${basename(record.run.id)}.json`
}
