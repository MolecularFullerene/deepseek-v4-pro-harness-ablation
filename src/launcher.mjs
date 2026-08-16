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
  childEnvironment, configFingerprint, parseRuntimeReport, redactValue, sha256, spawnWithSecret,
} from './core.mjs'
import { expectedFirstSurface, STRATEGIES, strategySourcePath } from './strategies.mjs'

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

async function digestDirectory(root) {
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
    ? { command: process.execPath, args: [built] }
    : { command: process.execPath, args: ['--import', pathToFileURL(tsxLoader).href, source] })
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
  await Promise.all([
    cp(join(RUNTIME_ROOT, 'pipe-credentials.mjs'), join(profileDir, 'pipe-credentials.mjs')),
    cp(join(RUNTIME_ROOT, 'lab-runner.mjs'), join(profileDir, 'lab-runner.mjs')),
  ])
  const source = strategySourcePath(workspaceRoot, strategyName)
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

function publicRunConfig(options, job, source) {
  const task = options.task ?? ''
  return {
    strategy: job.strategy,
    repetition: job.repetition,
    preset: STRATEGIES[job.strategy].preset,
    strategyStatus: STRATEGIES[job.strategy].status,
    expectedFirstSurface: expectedFirstSurface(job.strategy, process.platform) ?? null,
    platformQualification: STRATEGIES[job.strategy].platformNote ?? null,
    provider: options.provider,
    model: options.model,
    baseUrl: options.baseUrl,
    reasoningEffort: options.reasoningEffort ?? null,
    temperature: options.temperature ?? null,
    maxTokens: options.maxTokens ?? null,
    capture: options.capture,
    stopAfterFirstAssistant: options.stopAfterFirstAssistant,
    permissionMode: options.permissionMode,
    task: { sha256: sha256(task), chars: task.length },
    harnessCommit: gitHead(options.harnessRoot),
    strategyCommit: source === undefined ? gitHead(options.harnessRoot) : gitHead(source),
    strategyFilesSha256: source === undefined ? null : undefined,
  }
}

function runtimeLogs(stdout) {
  return stdout.split(/\r?\n/).filter(line => !line.startsWith('DSH_LAB_RESULT ')).join('\n').trim()
}

/** Run one fresh DSH process and return an allowlisted, redacted record. */
export async function runJob(options, job, secret = '') {
  const strategy = STRATEGIES[job.strategy]
  const ownsRuntime = options.runtimeHome === undefined
  const tempHome = options.runtimeHome ?? await mkdtemp(join(tmpdir(), 'dsh-lab-'))
  const runId = `${String(options.sequence).padStart(4, '0')}-${job.strategy}-${randomUUID()}`
  let record
  try {
    const patchConfig = {
      ...options,
      strategy: job.strategy,
      preset: strategy.preset,
    }
    const staged = await stageRuntime({
      tempHome,
      strategyName: job.strategy,
      workspaceRoot: options.workspaceRoot,
      patchConfig,
    })
    const publicConfig = publicRunConfig(options, job, staged.presetSource)
    if (staged.presetSource !== undefined) {
      publicConfig.strategyFilesSha256 = await digestDirectory(staged.presetSource)
    }
    const fingerprint = configFingerprint(publicConfig)
    const invocation = await launcherInvocation(options.harnessRoot)
    const childEnv = childEnvironment(process.env, {
      DSH_HOME: tempHome,
      DSH_TELEMETRY_DISABLED: '1',
      DSH_PERMISSION_MODE: options.permissionMode,
      DSH_CWD: options.workspace,
      DEEPSEEK_BASE_URL: options.baseUrl,
    })
    const startedAt = new Date().toISOString()
    const outcome = await spawnWithSecret({
      command: invocation.command,
      args: [...invocation.args, '--profile', 'headless', '--patch', staged.patchPath],
      // The source launcher must start at the Harness root so tsx discovers
      // its tsconfig path mappings. The patch and DSH_CWD still make the
      // experiment workspace the agent cwd and sandbox root.
      cwd: options.harnessRoot,
      env: childEnv,
      secret,
      timeoutMs: options.timeoutMs,
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
    if (ownsRuntime && !options.keepRuntime) await rm(tempHome, { recursive: true, force: true })
    else if (options.keepRuntime) record.runtimeDirectory = tempHome
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
