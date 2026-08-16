#!/usr/bin/env node

import { execFileSync, spawn } from 'node:child_process'
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { accessSync, constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL('./', import.meta.url))
const LAB_ROOT = resolve(ROOT, '../..')
const WORKSPACE_ROOT = resolve(LAB_ROOT, '..')
const DEFAULT_HARNESS = join(WORKSPACE_ROOT, 'deepseek-harness')
const RESULT_PREFIX = 'DSH_SCHEMA_FACTOR_RESULT '
const VARIANTS = [
  { id: 'persistent-editor', shellSchema: 'persistent', fileSchema: 'str_replace_editor', expectedTools: ['bash', 'str_replace_editor'] },
  { id: 'persistent-read', shellSchema: 'persistent', fileSchema: 'read', expectedTools: ['bash', 'read'] },
  { id: 'oneshot-editor', shellSchema: 'one-shot', fileSchema: 'str_replace_editor', expectedTools: ['bash', 'str_replace_editor'] },
  { id: 'oneshot-read', shellSchema: 'one-shot', fileSchema: 'read', expectedTools: ['bash', 'read'] },
]
const HOST_TOOL_ROWS = [
  'tool-bash', 'tool-pwsh', 'tool-jobs', 'tool-fs', 'tool-fs-search',
  'tool-str-replace-editor', 'skill-filesystem', 'tool-skill', 'tool-goal',
  'plan-mode', 'compaction-basic', 'command-compact', 'tool-result-pruner',
  'tool-subagent-control', 'tool-subagent-list-agents', 'tool-subagent',
  'tool-subagent-fork', 'workflow-worker-thread', 'tool-workflow', 'tool-ralph',
  'agent-instructions', 'tool-todo', 'tool-web',
]

function exists(path) {
  try {
    accessSync(path, fsConstants.F_OK)
    return true
  } catch {
    return false
  }
}

function parseArgs(argv) {
  const result = { harnessRoot: DEFAULT_HARNESS, out: join(ROOT, 'artifacts', 'latest.json') }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index + 1]
    if (argv[index] === '--harness-root' && value !== undefined) {
      result.harnessRoot = resolve(value)
      index += 1
    } else if (argv[index] === '--out' && value !== undefined) {
      result.out = resolve(value)
      index += 1
    } else {
      throw new Error(`unknown or incomplete argument ${argv[index]}`)
    }
  }
  return result
}

function gitHead(path) {
  try {
    return execFileSync('git', ['-C', path, 'rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return null
  }
}

function cleanEnvironment(overrides) {
  const env = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i.test(key)) continue
    env[key] = value
  }
  return { ...env, ...overrides }
}

function renderPatch(variant, preset, cwd) {
  const disabled = HOST_TOOL_ROWS.map(id => `- id: ${id}\n  disabled: true`).join('\n\n')
  return `# Ephemeral, credential-free schema-factor smoke overlay.
${disabled}

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
    mode: read-only
    workspaceRoot: ${JSON.stringify(cwd)}

- insert:
    - id: agent-presets
      name: '@deepseek-ai/dsh-agent-presets'
      config:
        default: standard

    - id: schema-factor-smoke-runner
      name: ./smoke-runner.mjs
      inject: [agents, agentPresets, systemPrompt]
      config:
        preset: ${JSON.stringify(preset)}
        cwd: ${JSON.stringify(cwd)}
        shellSchema: ${JSON.stringify(variant.shellSchema)}
        fileSchema: ${JSON.stringify(variant.fileSchema)}
        expectedTools: ${JSON.stringify(variant.expectedTools)}
`
}

function invocation(harnessRoot) {
  const built = join(harnessRoot, 'apps', 'cli', 'lib', 'bin.js')
  if (exists(built)) return { command: process.execPath, args: [built] }
  const source = join(harnessRoot, 'apps', 'cli', 'src', 'bin.ts')
  const tsx = join(harnessRoot, 'node_modules', 'tsx', 'dist', 'esm', 'index.mjs')
  if (!exists(source) || !exists(tsx)) throw new Error('Harness is not built and its source dependencies are unavailable')
  return { command: process.execPath, args: ['--import', pathToFileURL(tsx).href, source] }
}

async function launch({ command, args, cwd, env, timeoutMs = 30_000 }) {
  const child = spawn(command, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] })
  const stdout = []
  const stderr = []
  child.stdout.on('data', chunk => stdout.push(chunk))
  child.stderr.on('data', chunk => stderr.push(chunk))
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, timeoutMs)
  const outcome = await new Promise((resolvePromise, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolvePromise({ code, signal }))
  }).finally(() => clearTimeout(timer))
  return {
    ...outcome,
    timedOut,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }
}

function parseReport(stdout) {
  const line = stdout.split(/\r?\n/).find(candidate => candidate.startsWith(RESULT_PREFIX))
  return line === undefined ? null : JSON.parse(line.slice(RESULT_PREFIX.length))
}

function same(values) {
  return new Set(values).size === 1
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const runtimeHome = await mkdtemp(join(tmpdir(), 'dsh-schema-factor-'))
  const profile = join(runtimeHome, 'profiles', 'headless')
  const userPresets = join(runtimeHome, '.agent-presets')
  const invoke = invocation(options.harnessRoot)
  const reports = []
  try {
    await mkdir(profile, { recursive: true })
    await cp(join(ROOT, 'runtime', 'smoke-runner.mjs'), join(profile, 'smoke-runner.mjs'))
    for (const variant of VARIANTS) {
      const preset = `schema-factor-${variant.id}`
      await cp(join(ROOT, 'presets', variant.id), join(userPresets, preset), { recursive: true })
      const patch = join(profile, `${preset}.patch.yml`)
      await writeFile(patch, renderPatch(variant, preset, ROOT), { mode: 0o600 })
      const outcome = await launch({
        ...invoke,
        args: [...invoke.args, '--profile', 'headless', '--patch', patch],
        cwd: options.harnessRoot,
        env: cleanEnvironment({
          DSH_HOME: runtimeHome,
          DSH_CWD: ROOT,
          DSH_PERMISSION_MODE: 'read-only',
          DSH_TELEMETRY_DISABLED: '1',
        }),
      })
      reports.push({
        id: variant.id,
        process: { exitCode: outcome.code, signal: outcome.signal, timedOut: outcome.timedOut },
        report: parseReport(outcome.stdout),
        ...(outcome.stderr.trim() === '' ? {} : { stderr: outcome.stderr.trim() }),
      })
    }

    const successful = reports.filter(item => item.process.exitCode === 0 && item.report !== null)
    const byId = Object.fromEntries(successful.map(item => [item.id, item.report]))
    const tool = (id, name) => byId[id]?.firstRequest.tools.find(item => item.name === name)?.schemaSha256
    const systemHashes = successful.map(item => item.report.firstRequest.system.sha256)
    const checks = {
      allFourMounted: successful.length === 4,
      allVariantChecksPassed: successful.length === 4 && successful.every(item => Object.values(item.report.checks).every(Boolean)),
      identicalSystemAcrossMatrix: successful.length === 4 && same(systemHashes),
      persistentShellStableAcrossFileFactor: tool('persistent-editor', 'bash') === tool('persistent-read', 'bash'),
      oneShotShellStableAcrossFileFactor: tool('oneshot-editor', 'bash') === tool('oneshot-read', 'bash'),
      shellFactorActuallyDiffers: tool('persistent-editor', 'bash') !== tool('oneshot-editor', 'bash'),
      editorStableAcrossShellFactor: tool('persistent-editor', 'str_replace_editor') === tool('oneshot-editor', 'str_replace_editor'),
      readStableAcrossShellFactor: tool('persistent-read', 'read') === tool('oneshot-read', 'read'),
    }
    const artifact = {
      schemaVersion: 1,
      createdAt: new Date().toISOString(),
      harness: { commit: gitHead(options.harnessRoot) },
      platform: { os: process.platform, arch: process.arch, node: process.version },
      controls: {
        system: 'You are a helpful software engineer assistant.',
        includeRuntimeContext: false,
        contextsCount: 0,
        toolCount: 2,
        execution: false,
      },
      matrix: VARIANTS,
      variants: reports,
      checks,
    }
    await mkdir(dirname(options.out), { recursive: true })
    await writeFile(options.out, JSON.stringify(artifact, null, 2) + '\n', { mode: 0o600 })
    process.stdout.write(`schema-factor artifact: ${options.out}\n`)
    process.stdout.write(`${JSON.stringify(checks, null, 2)}\n`)
    return Object.values(checks).every(Boolean) ? 0 : 1
  } finally {
    await rm(runtimeHome, { recursive: true, force: true })
  }
}

try {
  process.exitCode = await main()
} catch (error) {
  process.stderr.write(`schema-factor smoke: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
