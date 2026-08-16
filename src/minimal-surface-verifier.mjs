import { spawn } from 'node:child_process'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { sha256 } from './core.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI = join(PACKAGE_ROOT, 'src', 'cli.mjs')

function cleanEnvironment() {
  const env = {}
  for (const key of ['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot']) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}
async function launch(args, timeoutMs) {
  const child = spawn(process.execPath, args, {
    cwd: PACKAGE_ROOT,
    env: cleanEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const stdout = []
  const stderr = []
  let bytes = 0
  let overflow = false
  const collect = target => chunk => {
    bytes += chunk.length
    if (bytes > 4 * 1024 * 1024) {
      overflow = true
      child.kill('SIGTERM')
      return
    }
    target.push(chunk)
  }
  child.stdout.on('data', collect(stdout))
  child.stderr.on('data', collect(stderr))
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    child.kill('SIGTERM')
  }, timeoutMs)
  const outcome = await new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => resolve({ code, signal }))
  }).finally(() => clearTimeout(timer))
  return {
    ...outcome,
    timedOut,
    overflow,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  }
}

/**
 * Mount the shipped official Minimal preset in a keyless DSH child and prove
 * the fixture's complete system/tool surface matches that live assembly.
 */
export async function verifyOfficialMinimalSurface({ harnessRoot, fixture, timeoutMs = 60_000 }) {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-live-minimal-verify-'))
  try {
    const result = await launch([
      CLI,
      'smoke',
      '--strategy', 'minimal',
      '--capture', 'full',
      '--out', directory,
      '--harness-root', harnessRoot,
      '--workspace', PACKAGE_ROOT,
      '--timeout-ms', String(timeoutMs),
    ], timeoutMs + 5_000)
    if (result.code !== 0 || result.timedOut || result.overflow) {
      throw new Error(`official Minimal mount verification failed${result.timedOut ? ' (timed out)' : ''}${result.overflow ? ' (output overflow)' : ''}${result.stderr.trim() === '' ? '' : `: ${result.stderr.trim()}`}`)
    }
    const filename = (await readdir(directory)).find(name => name !== 'batch.json' && name.endsWith('.json'))
    if (filename === undefined) throw new Error('official Minimal mount produced no result artifact')
    const artifact = JSON.parse(await readFile(join(directory, filename), 'utf8'))
    const runtime = artifact.runtime
    const system = runtime?.mountSystem?.text
    const tools = runtime?.mountToolSchemas
    if (typeof system !== 'string' || !Array.isArray(tools)) throw new Error('official Minimal mount did not export a full system/tool surface')
    const surfaceSha256 = sha256(JSON.stringify({ system, tools }))
    const toolFacts = tools.map(tool => ({
      name: tool.name,
      schemaSha256: sha256(JSON.stringify(tool)),
      schemaChars: JSON.stringify(tool).length,
    }))
    const lock = fixture.surfaceLock
    const checks = {
      mountedOfficialMinimal: runtime.preset === 'minimal' && runtime.mode === 'mount',
      harnessCommitMatchesLock: artifact.run?.config?.harnessCommit === lock.harnessCommit,
      platformMatchesLock: `${runtime.platform}-${runtime.arch}` === lock.platform,
      exactCompleteSystem: system === fixture.system && sha256(system) === lock.systemSha256,
      exactToolOrder: JSON.stringify(tools.map(tool => tool.name)) === JSON.stringify(['bash', 'str_replace_editor']),
      exactCompleteToolSchemas: JSON.stringify(tools) === JSON.stringify(fixture.tools),
      individualToolHashesMatchLock: toolFacts.length === lock.tools.length
        && toolFacts.every((tool, index) => tool.name === lock.tools[index]?.name && tool.schemaSha256 === lock.tools[index]?.schemaSha256),
      completeSurfaceHashMatchesLock: surfaceSha256 === lock.surfaceSha256,
      existingMountSurfaceCheckPassed: artifact.surfaceCheck?.matches === true,
    }
    if (!Object.values(checks).every(Boolean)) {
      throw new Error(`fixture is not the current official exact Minimal surface: ${JSON.stringify(checks)}`)
    }
    return {
      source: 'fresh keyless real DSH mount before credential read',
      harnessCommit: artifact.run.config.harnessCommit,
      platform: `${runtime.platform}-${runtime.arch}`,
      system: { sha256: sha256(system), chars: system.length },
      tools: toolFacts,
      surfaceSha256,
      checks,
    }
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
