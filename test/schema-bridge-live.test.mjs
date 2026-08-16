import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawn, spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { canonicalJson, childEnvironment, sha256, spawnWithSecret } from '../src/core.mjs'
import {
  buildSchemaBridgePlan,
  SCHEMA_BRIDGE_CLASSIFIER_SHA256,
  SCHEMA_BRIDGE_ORACLE_SHA256,
  schemaBridgePilotGate,
  validateSchemaBridgeOracle,
  validateSchemaBridgePlan,
  validateSchemaBridgePrompts,
} from '../src/schema-bridge-live.mjs'
import { schemaBridgeLiveCommand, schemaBridgeLiveFileInternals } from '../src/schema-bridge-live-command.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const CLI = join(PACKAGE_ROOT, 'src', 'cli.mjs')
const ORACLE_PATH = join(PACKAGE_ROOT, 'experiments', 'schema-bridge-live', 'oracle.json')
const PROMPTS_PATH = join(PACKAGE_ROOT, 'experiments', 'schema-bridge-live', 'prompts.json')
const CLASSIFIER_PATH = join(PACKAGE_ROOT, 'experiments', 'schema-bridge-live', 'classifier.mjs')
const README_PATH = join(PACKAGE_ROOT, 'experiments', 'schema-bridge-live', 'README.md')

async function fixtures() {
  const [oracleText, promptText, classifier] = await Promise.all([
    readFile(ORACLE_PATH, 'utf8'),
    readFile(PROMPTS_PATH, 'utf8'),
    readFile(CLASSIFIER_PATH),
  ])
  return { oracleText, promptText, classifier, oracle: JSON.parse(oracleText), prompts: JSON.parse(promptText) }
}

async function absent(path) {
  try {
    await access(path)
    return false
  } catch {
    return true
  }
}

function keylessEnv(extra = {}) {
  return {
    ...Object.fromEntries(['PATH', 'TMPDIR', 'TMP', 'TEMP', 'SystemRoot', 'LANG']
      .filter(key => process.env[key] !== undefined)
      .map(key => [key, process.env[key]])),
    DEEPSEEK_API_KEY: 'CANARY-AMBIENT-KEY-MUST-NOT-LEAK',
    ...extra,
  }
}

function dedicatedOptions(out) {
  return {
    command: 'schema-bridge-live',
    oracle: ORACLE_PATH,
    out,
    apiKeyStdin: true,
    allowNetwork: true,
    maxTokens: 768,
    maxTokensExplicit: true,
    identity: 'fixed',
    capture: 'trajectory',
    reasoningEffort: 'max',
    timeoutMs: 900_000,
    strategies: [],
  }
}

test('frozen oracle, prompts, classifier, and complete seed-derived plan validate', async () => {
  const [{ oracleText, promptText, classifier, oracle, prompts }, readme] = await Promise.all([
    fixtures(), readFile(README_PATH, 'utf8'),
  ])
  assert.equal(sha256(canonicalJson(JSON.parse(oracleText))), SCHEMA_BRIDGE_ORACLE_SHA256)
  assert.equal(createHash('sha256').update(classifier).digest('hex'), SCHEMA_BRIDGE_CLASSIFIER_SHA256)
  assert.equal(readme.includes(SCHEMA_BRIDGE_ORACLE_SHA256), true)
  validateSchemaBridgeOracle(oracle)
  validateSchemaBridgePrompts(prompts, oracle)
  assert.equal(prompts.tasks.filter(prompt => prompt.language === 'en').length, 5)
  assert.equal(prompts.tasks.filter(prompt => prompt.language === 'zh').length, 5)
  assert.equal(/\b(?:we need|let me)\b/i.test(promptText), false)

  const plan = buildSchemaBridgePlan(prompts, oracle)
  assert.equal(plan.pilot.length, 4)
  assert.equal(plan.blocks.length, 40)
  assert.equal(plan.blocks.flatMap(block => block.allocation).length, 160)
  validateSchemaBridgePlan(plan, oracle, prompts)
  for (const prompt of prompts.tasks) {
    const blocks = plan.blocks.filter(block => block.taskId === prompt.id)
    for (const arm of ['pp', 'po', 'op', 'oo']) {
      assert.deepEqual(blocks.map(block => block.allocation.find(unit => unit.arm === arm).position).sort(), [1, 2, 3, 4])
    }
  }
})

test('plan validator rebuilds from the frozen seed and rejects balanced self-rehashed tampering', async () => {
  const { oracle, prompts } = await fixtures()
  const tampered = structuredClone(buildSchemaBridgePlan(prompts, oracle))
  ;[tampered.pilot[0].identity, tampered.pilot[1].identity] = [tampered.pilot[1].identity, tampered.pilot[0].identity]
  delete tampered.sha256
  tampered.sha256 = sha256(canonicalJson(tampered))
  assert.throws(() => validateSchemaBridgePlan(tampered, oracle, prompts), /does not exactly match the frozen seed-derived plan/)
})

test('pilot protocol gate is independent of lexical/classifier labels', () => {
  const items = ['pp', 'po', 'op', 'oo'].map((arm, index) => ({
    arm,
    status: 'accepted',
    validation: { accepted: true, failures: [] },
    label: index % 2 === 0 ? 'minimal-like' : 'standard-like',
  }))
  const baseline = schemaBridgePilotGate(items)
  const relabeled = schemaBridgePilotGate(items.map(item => ({ ...item, label: 'ambiguous', reasoning: 'Let me' })))
  assert.deepEqual(relabeled, baseline)
  assert.equal(baseline.passed, true)
})

test('dedicated CLI fails before credential access and never overwrites output', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'schema-bridge-live-cli-'))
  const fresh = join(directory, 'fresh.json')
  const existing = join(directory, 'existing.json')
  await writeFile(existing, 'ORIGINAL\n', { mode: 0o600 })
  try {
    const missingNetwork = spawnSync(process.execPath, [
      CLI, 'schema-bridge-live', '--oracle', ORACLE_PATH, '--out', fresh,
      '--api-key-stdin', '--max-tokens', '768',
    ], { cwd: PACKAGE_ROOT, encoding: 'utf8', env: keylessEnv(), input: '' })
    assert.equal(missingNetwork.status, 2)
    assert.match(missingNetwork.stderr, /requires explicit --allow-network/)
    assert.equal(`${missingNetwork.stdout}${missingNetwork.stderr}`.includes('CANARY-AMBIENT'), false)

    const overwrite = spawnSync(process.execPath, [
      CLI, 'schema-bridge-live', '--oracle', ORACLE_PATH, '--out', existing,
      '--api-key-stdin', '--allow-network', '--max-tokens', '768',
    ], { cwd: PACKAGE_ROOT, encoding: 'utf8', env: keylessEnv(), input: '' })
    assert.equal(overwrite.status, 2)
    assert.match(overwrite.stderr, /refusing to overwrite/)
    assert.equal(await readFile(existing, 'utf8'), 'ORIGINAL\n')

    const ignoredGeneric = spawnSync(process.execPath, [
      CLI, 'schema-bridge-live', '--oracle', ORACLE_PATH, '--out', fresh,
      '--api-key-stdin', '--allow-network', '--max-tokens', '768', '--identity', 'fixed',
    ], { cwd: PACKAGE_ROOT, encoding: 'utf8', env: keylessEnv(), input: '' })
    assert.equal(ignoredGeneric.status, 2)
    assert.match(ignoredGeneric.stderr, /rejects generic strategy\/order\/identity\/workspace\/runtime overrides/)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('dedicated CLI rejects ambient Node preload hooks before reading stdin', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'schema-bridge-live-node-options-'))
  try {
    const result = spawnSync(process.execPath, [
      CLI, 'schema-bridge-live', '--oracle', ORACLE_PATH, '--out', join(directory, 'raw.json'),
      '--api-key-stdin', '--allow-network', '--max-tokens', '768',
    ], {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      env: keylessEnv({ NODE_PATH: join(directory, 'ambient-modules') }),
      input: 'STDIN-CANARY-MUST-NOT-BE-READ\n',
    })
    assert.equal(result.status, 2)
    assert.match(result.stderr, /refuses ambient NODE_OPTIONS\/NODE_PATH/)
    assert.equal(`${result.stdout}${result.stderr}`.includes('STDIN-CANARY'), false)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('raw artifact writes are 0600, progressive, and exclusive at creation', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'schema-bridge-live-files-'))
  const output = join(directory, 'raw.json')
  try {
    await schemaBridgeLiveFileInternals.writeInitialArtifact(output, { status: 'planned' })
    assert.equal((await stat(output)).mode & 0o777, 0o600)
    await assert.rejects(
      () => schemaBridgeLiveFileInternals.writeInitialArtifact(output, { status: 'replaced' }),
      /refusing to overwrite/,
    )
    await schemaBridgeLiveFileInternals.saveArtifact(output, { status: 'running', progress: 1 })
    assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { status: 'running', progress: 1 })
    assert.equal((await stat(output)).mode & 0o777, 0o600)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('snapshot retained scope removes private bytes after any post-creation preflight exception', async () => {
  let snapshotRoot
  await assert.rejects(
    () => schemaBridgeLiveFileInternals.retainProtocolSnapshot(async snapshot => {
      snapshotRoot = snapshot.root
      throw new Error('synthetic researchGitFacts failure after snapshot creation')
    }),
    /synthetic researchGitFacts failure/,
  )
  assert.equal(typeof snapshotRoot, 'string')
  assert.equal(await absent(snapshotRoot), true)
})

test('actual command preflight signal hard-stops its child and cleans snapshot/temp state without creating raw output or listeners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'schema-bridge-preflight-signal-'))
  const output = join(directory, 'must-not-exist.json')
  const signals = new EventEmitter()
  let snapshotRoot
  let runtimePath
  let childOutcome
  try {
    await assert.rejects(() => schemaBridgeLiveCommand(dedicatedOptions(output), {
      signalSource: signals,
      schemaBridgeLifecycleTestMode: true,
      testOnlyKeylessPreflight: async (options, abortSignal) => (
        await schemaBridgeLiveFileInternals.retainProtocolSnapshot(async snapshot => {
          snapshotRoot = snapshot.root
          runtimePath = await mkdtemp(join(directory, 'mount-runtime-'))
          try {
            const emitTimer = setTimeout(() => signals.emit('SIGTERM'), 500)
            childOutcome = await spawnWithSecret({
              command: process.execPath,
              args: ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
              cwd: runtimePath,
              env: childEnvironment(process.env),
              timeoutMs: 10_000,
              signal: abortSignal,
              terminationGraceMs: 50,
              killSettleMs: 100,
            }).finally(() => clearTimeout(emitTimer))
            if (abortSignal.aborted) throw abortSignal.reason
            throw new Error('test preflight child unexpectedly completed without interruption')
          } finally {
            await rm(runtimePath, { recursive: true, force: true })
          }
        }, abortSignal)
      ),
    }), /schema-bridge-live interrupted by SIGTERM/)
    assert.equal(childOutcome.aborted, true)
    assert.equal(childOutcome.forcedKill, true)
    assert.equal(childOutcome.signal, 'SIGKILL')
    assert.equal(await absent(snapshotRoot), true)
    assert.equal(await absent(runtimePath), true)
    assert.equal(await absent(output), true)
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(signal), 0)
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

test('a second real process termination signal restores default forced termination', async () => {
  const moduleUrl = new URL('../src/schema-bridge-live-command.mjs', import.meta.url).href
  const script = [
    `const {schemaBridgeLiveFileInternals}=await import(${JSON.stringify(moduleUrl)})`,
    'const governance=schemaBridgeLiveFileInternals.installSignalGovernance(process)',
    "governance.signal.addEventListener('abort',()=>process.stdout.write('FIRST\\n'),{once:true})",
    "process.stdout.write('READY\\n')",
    'setInterval(()=>{},1000)',
  ].join(';')
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], {
    cwd: PACKAGE_ROOT,
    env: keylessEnv(),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let firstSent = false
  let secondSent = false
  const timeout = setTimeout(() => child.kill('SIGKILL'), 5_000)
  try {
    const outcome = await new Promise((resolve, reject) => {
      child.once('error', reject)
      child.stdout.on('data', chunk => {
        stdout += chunk.toString('utf8')
        if (!firstSent && stdout.includes('READY\n')) {
          firstSent = true
          child.kill('SIGTERM')
        }
        if (!secondSent && stdout.includes('FIRST\n')) {
          secondSent = true
          child.kill('SIGTERM')
        }
      })
      child.once('close', (code, signal) => resolve({ code, signal }))
    })
    assert.equal(firstSent, true)
    assert.equal(secondSent, true)
    assert.deepEqual(outcome, { code: null, signal: 'SIGTERM' })
  } finally {
    clearTimeout(timeout)
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
})

test('lifecycle signal aborts work, seals a nonzero terminal failure, cleans all private state, and leaks no listeners', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'schema-bridge-lifecycle-'))
  const output = join(directory, 'raw.json')
  const runtimeHomes = []
  const signals = new EventEmitter()
  let governance
  try {
    for (let index = 0; index < 4; index += 1) {
      runtimeHomes.push({ identity: `identity-${index + 1}`, path: await mkdtemp(join(directory, 'home-')) })
    }
    const snapshotPath = await mkdtemp(join(directory, 'snapshot-'))
    const protocolSnapshot = { path: snapshotPath }
    const running = { status: 'running-pilot', pilot: [], samples: [] }
    await schemaBridgeLiveFileInternals.writeInitialArtifact(output, running)
    governance = schemaBridgeLiveFileInternals.installSignalGovernance(signals)
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(signal), 1)

    const emitTimer = setTimeout(() => signals.emit('SIGTERM'), 500)
    const child = await spawnWithSecret({
      command: process.execPath,
      args: ['-e', "process.on('SIGTERM',()=>{}); setInterval(()=>{},1000)"],
      cwd: process.cwd(),
      env: childEnvironment(process.env),
      timeoutMs: 10_000,
      signal: governance.signal,
      terminationGraceMs: 50,
      killSettleMs: 100,
    }).finally(() => clearTimeout(emitTimer))
    assert.equal(governance.signal.aborted, true)
    assert.equal(governance.receivedSignal, 'SIGTERM')
    assert.equal(child.aborted, true)
    assert.equal(child.forcedKill, true)
    assert.equal(child.signal, 'SIGKILL')
    await assert.rejects(() => schemaBridgeLiveFileInternals.settleRunnerFailure({
      artifact: running,
      out: output,
      runtimeHomes,
      protocolSnapshot,
      error: governance.interruptionError,
      secret: '',
    }), /schema-bridge-live interrupted by SIGTERM/)

    const terminal = JSON.parse(await readFile(output, 'utf8'))
    assert.equal(terminal.status, 'runner-failed')
    assert.equal(terminal.privateRuntimeHomesRemoved, true)
    assert.equal(terminal.privateProtocolSnapshotRemoved, true)
    assert.match(terminal.error.message, /SIGTERM/)
    assert.equal(protocolSnapshot.path, null)
    assert.equal(runtimeHomes.length, 0)
    assert.equal(await absent(snapshotPath), true)
    assert.equal((await stat(output)).mode & 0o777, 0o600)
  } finally {
    governance?.dispose()
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) assert.equal(signals.listenerCount(signal), 0)
    await rm(directory, { recursive: true, force: true })
  }
})
