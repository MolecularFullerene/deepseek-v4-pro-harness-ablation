import { randomUUID } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { access, chmod, lstat, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { constants as fsConstants } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { canonicalJson, normalizeBaseUrl, readSecret, redactText, sha256 } from './core.mjs'
import { digestDirectory, inspectHarness, makeSchemaBridgeProtocolSnapshot, runJob, WORKSPACE_ROOT } from './launcher.mjs'
import {
  buildSchemaBridgePlan,
  SCHEMA_BRIDGE_ARMS,
  SCHEMA_BRIDGE_CLASSIFIER_SHA256,
  SCHEMA_BRIDGE_IDENTITIES,
  SCHEMA_BRIDGE_MAX_HTTP_ATTEMPTS,
  SCHEMA_BRIDGE_ORACLE_SHA256,
  schemaBridgeArtifactIntegritySha256,
  schemaBridgePilotGate,
  validateSchemaBridgeObservation,
  validateSchemaBridgeOracle,
  validateSchemaBridgePrompts,
} from './schema-bridge-live.mjs'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const PROMPTS_PATH = join(PACKAGE_ROOT, 'experiments', 'schema-bridge-live', 'prompts.json')
const CLASSIFIER_PATH = join(PACKAGE_ROOT, 'experiments', 'schema-bridge-live', 'classifier.mjs')
const DEFAULT_BASE_URL = 'https://api.deepseek.com'

function researchGitFacts() {
  try {
    const commit = execFileSync('git', ['-C', PACKAGE_ROOT, 'rev-parse', 'HEAD'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    const trackedDirty = execFileSync('git', ['-C', PACKAGE_ROOT, 'status', '--porcelain'], {
      encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim() !== ''
    return { commit, trackedDirty }
  } catch {
    throw new Error('schema-bridge-live requires an intact research Git worktree')
  }
}

async function requireFreshOutput(path) {
  try {
    await lstat(path)
  } catch (error) {
    if (error?.code === 'ENOENT') return
    throw error
  }
  throw new Error('refusing to overwrite an existing --out file')
}

async function writeInitialArtifact(path, value) {
  await mkdir(dirname(path), { recursive: true })
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error('refusing to overwrite an existing --out file')
    throw error
  }
}

async function saveArtifact(path, value) {
  const temporary = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`)
  try {
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
    await chmod(temporary, 0o600)
    await rename(temporary, path)
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {})
    throw error
  }
}

const LIFECYCLE_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP'])

function installSignalGovernance(signalSource = process, options = {}) {
  const controller = new AbortController()
  let interruptionError = null
  let receivedSignal = null
  let disposed = false
  const handlers = new Map(LIFECYCLE_SIGNALS.map(signal => [signal, () => {
    if (receivedSignal !== null) {
      dispose()
      if (signalSource === process) process.kill(process.pid, signal)
      else options.onRepeatedSignal?.(signal)
      return
    }
    receivedSignal = signal
    interruptionError = new Error(`schema-bridge-live interrupted by ${signal}`)
    interruptionError.code = 'SCHEMA_BRIDGE_LIFECYCLE_SIGNAL'
    controller.abort(interruptionError)
  }]))
  try {
    for (const [signal, handler] of handlers) signalSource.on(signal, handler)
  } catch (error) {
    for (const [signal, handler] of handlers) signalSource.off(signal, handler)
    throw error
  }
  function dispose() {
    if (disposed) return
    disposed = true
    for (const [signal, handler] of handlers) signalSource.off(signal, handler)
  }
  return {
    signal: controller.signal,
    get interruptionError() { return interruptionError },
    get receivedSignal() { return receivedSignal },
    throwIfInterrupted() {
      if (interruptionError !== null) throw interruptionError
    },
    dispose,
  }
}

export const schemaBridgeLiveFileInternals = Object.freeze({
  writeInitialArtifact,
  saveArtifact,
  retainProtocolSnapshot,
  installSignalGovernance,
  settleRunnerFailure,
})

function terminalArtifact(value, status, extra = {}) {
  const payload = {
    ...value,
    ...extra,
    status,
    finishedAt: new Date().toISOString(),
  }
  return { ...payload, integritySha256: schemaBridgeArtifactIntegritySha256(payload) }
}

function fixedOptions(options, oracle) {
  const binding = oracle.artifactBinding
  return {
    ...options,
    command: 'schema-bridge-live',
    workspace: PACKAGE_ROOT,
    workspaceRoot: WORKSPACE_ROOT,
    mode: 'run',
    provider: binding.provider,
    model: binding.model,
    baseUrl: binding.baseUrl,
    reasoningEffort: binding.reasoningEffort,
    temperature: undefined,
    maxTokens: binding.maxTokens,
    timeoutMs: binding.timeoutMs,
    capture: binding.capture,
    permissionMode: binding.permissionMode,
    stopAfterFirstAssistant: true,
    apiKeyStdin: true,
    allowNetwork: true,
    keepRuntime: false,
    schemaBridgeTestMode: false,
    testOnlySchemaBridgeTransport: undefined,
  }
}

function validateDedicatedFlags(options) {
  if (Object.hasOwn(process.env, 'NODE_OPTIONS') || Object.hasOwn(process.env, 'NODE_PATH')) {
    throw new Error('schema-bridge-live refuses ambient NODE_OPTIONS/NODE_PATH before credential access')
  }
  if (options.oracle === undefined) throw new Error('schema-bridge-live requires --oracle PATH')
  if (options.out === undefined) throw new Error('schema-bridge-live requires --out PATH')
  const relativeOut = relative(PACKAGE_ROOT, options.out)
  const insidePackage = relativeOut === '' || (!relativeOut.startsWith(`..${sep}`) && relativeOut !== '..' && !isAbsolute(relativeOut))
  const privateRunsRoot = resolve(PACKAGE_ROOT, 'runs', 'schema-bridge-live')
  const relativePrivate = relative(privateRunsRoot, options.out)
  const insidePrivateRuns = relativePrivate !== '' && !relativePrivate.startsWith(`..${sep}`)
    && relativePrivate !== '..' && !isAbsolute(relativePrivate)
  if (insidePackage && !insidePrivateRuns) {
    throw new Error('schema-bridge-live raw --out must be outside the repository or under runs/schema-bridge-live/')
  }
  if (!options.apiKeyStdin) throw new Error('schema-bridge-live requires --api-key-stdin; environment and argv credentials are forbidden')
  if (!options.allowNetwork) throw new Error('schema-bridge-live requires explicit --allow-network')
  if (options.maxTokens !== 768 || options.maxTokensExplicit !== true) {
    throw new Error('schema-bridge-live requires explicit --max-tokens 768')
  }
  if (options.temperature !== undefined) throw new Error('schema-bridge-live fixes temperature to null; omit --temperature')
  if (options.orderExplicit || options.identityExplicit || options.workspaceExplicit
    || options.permissionModeExplicit || options.captureExplicit || options.reasoningEffortExplicit
    || options.timeoutExplicit || options.stopExplicit || options.providerExplicit
    || options.modelExplicit || options.baseUrlExplicit) {
    throw new Error('schema-bridge-live rejects generic strategy/order/identity/workspace/runtime overrides')
  }
  if (options.identity !== 'fixed') throw new Error('schema-bridge-live requires the four fixed identities')
  if (options.capture !== 'trajectory') throw new Error('schema-bridge-live fixes --capture trajectory')
  if (options.reasoningEffort !== 'max') throw new Error('schema-bridge-live fixes --reasoning-effort max')
  if (options.mockScript !== undefined || options.fixture !== undefined || options.pilotOnly
    || options.dryRun || options.keepRuntime || options.repeatExplicit || options.seed !== undefined
    || options.strategies.length > 0 || options.task !== undefined || options.taskFile !== undefined) {
    throw new Error('schema-bridge-live rejects generic sampling, fixture, mock, pilot-only, seed, task, and runtime-retention options')
  }
  if (options.timeoutMs !== 900000) throw new Error('schema-bridge-live fixes --timeout-ms 900000')
}

function validatePreflightMount(record, strategy, oracle) {
  const runtime = record?.runtime
  const expected = oracle.surface.toolSchemaRawSha256[strategy]
  const actual = runtime?.mountToolSchemas?.map(tool => sha256(JSON.stringify(tool)))
  const checks = {
    process: record?.process?.exitCode === 0 && record?.process?.timedOut === false
      && record?.process?.outputOverflow === false,
    mode: runtime?.mode === 'mount',
    platform: `${runtime?.platform}-${runtime?.arch}` === oracle.artifactBinding.platform,
    harnessCommit: record?.run?.config?.harnessCommit === oracle.artifactBinding.harnessCommit,
    system: runtime?.mountSystem?.sha256 === oracle.surface.systemRawSha256,
    toolOrder: canonicalJson(runtime?.mountTools) === canonicalJson(oracle.surface.orderedToolNames),
    rawSchemas: canonicalJson(actual) === canonicalJson(expected),
    environment: record?.run?.config?.environmentMode === oracle.artifactBinding.environmentMode,
    launcher: record?.run?.config?.launcherMode === oracle.artifactBinding.launcherMode,
    protocolClosure: record?.run?.config?.protocolClosureSha256 === oracle.artifactBinding.protocolClosureSha256,
  }
  return {
    accepted: Object.values(checks).every(Boolean),
    checks,
    surface: {
      harnessCommit: record?.run?.config?.harnessCommit ?? null,
      launcherMode: record?.run?.config?.launcherMode ?? null,
      protocolClosureSha256: record?.run?.config?.protocolClosureSha256 ?? null,
      platform: `${runtime?.platform}-${runtime?.arch}`,
      systemRawSha256: runtime?.mountSystem?.sha256 ?? null,
      orderedToolNames: runtime?.mountTools ?? null,
      toolSchemaRawSha256: actual,
    },
  }
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw signal.reason instanceof Error ? signal.reason : new Error('schema-bridge-live lifecycle was aborted')
  }
}

async function retainProtocolSnapshot(callback, abortSignal) {
  throwIfAborted(abortSignal)
  const snapshot = await makeSchemaBridgeProtocolSnapshot()
  let retained = false
  try {
    throwIfAborted(abortSignal)
    const result = await callback(snapshot)
    throwIfAborted(abortSignal)
    retained = true
    return result
  } finally {
    if (!retained) await rm(snapshot.root, { recursive: true, force: true })
  }
}

async function keylessPreflight(options, abortSignal) {
  throwIfAborted(abortSignal)
  const oracleText = await readFile(options.oracle, 'utf8')
  throwIfAborted(abortSignal)
  const oracle = validateSchemaBridgeOracle(JSON.parse(oracleText))
  const promptsText = await readFile(PROMPTS_PATH, 'utf8')
  throwIfAborted(abortSignal)
  const prompts = validateSchemaBridgePrompts(JSON.parse(promptsText), oracle)
  const classifierText = await readFile(CLASSIFIER_PATH, 'utf8')
  throwIfAborted(abortSignal)
  if (sha256(classifierText) !== SCHEMA_BRIDGE_CLASSIFIER_SHA256) {
    throw new Error('self-contained classifier bytes do not match modeltest@04255b5')
  }
  const plan = buildSchemaBridgePlan(prompts, oracle)
  throwIfAborted(abortSignal)
  const research = researchGitFacts()
  if (research.trackedDirty) throw new Error('schema-bridge-live requires a clean Git-visible research worktree')
  const baseUrl = normalizeBaseUrl(options.baseUrl ?? DEFAULT_BASE_URL)
  const harness = await inspectHarness(options.harnessRoot)
  throwIfAborted(abortSignal)
  if (!harness.runnable || !harness.builtLauncher) {
    throw new Error('DeepSeek Harness frozen built launcher is required before live sampling')
  }
  if (harness.gitHead !== oracle.artifactBinding.harnessCommit || harness.gitTrackedDirty !== false
    || `${process.platform}-${process.arch}` !== oracle.artifactBinding.platform
    || options.provider !== oracle.artifactBinding.provider
    || options.model !== oracle.artifactBinding.model
    || baseUrl !== oracle.artifactBinding.baseUrl
    || options.reasoningEffort !== oracle.artifactBinding.reasoningEffort
    || options.capture !== oracle.artifactBinding.capture) {
    throw new Error('schema-bridge-live route, Harness commit, platform, or fixed runtime controls do not match the oracle')
  }
  await access(options.harnessRoot, fsConstants.R_OK)
  throwIfAborted(abortSignal)

  return await retainProtocolSnapshot(async protocolSnapshot => {
    // Everything after snapshot creation belongs inside this retained scope:
    // a Git inspection failure must not strand private protocol bytes.
    throwIfAborted(abortSignal)
    const researchAfterSnapshot = researchGitFacts()
    throwIfAborted(abortSignal)
    if (protocolSnapshot.sha256 !== oracle.artifactBinding.protocolClosureSha256
      || researchAfterSnapshot.trackedDirty || researchAfterSnapshot.commit !== research.commit) {
      throw new Error('schema-bridge-live protocol closure changed while the keyless snapshot was created')
    }

    const mountFacts = []
    const mountOptions = {
      ...fixedOptions(options, oracle),
      mode: 'mount',
      capture: 'full',
      task: '',
      allowNetwork: false,
      apiKeyStdin: false,
      stopAfterFirstAssistant: false,
      sequence: 0,
      protocolSnapshotRoot: protocolSnapshot.root,
      protocolClosureSha256: protocolSnapshot.sha256,
      strategyCommit: research.commit,
      abortSignal,
    }
    for (let index = 0; index < SCHEMA_BRIDGE_ARMS.length; index += 1) {
      throwIfAborted(abortSignal)
      const strategy = SCHEMA_BRIDGE_ARMS[index]
      const record = await runJob({ ...mountOptions, sequence: index + 1 }, { strategy, repetition: 1 })
      throwIfAborted(abortSignal)
      const validation = validatePreflightMount(record, strategy, oracle)
      if (!validation.accepted) throw new Error(`keyless real-DSH mount preflight failed for ${strategy}: ${Object.entries(validation.checks).filter(([, ok]) => !ok).map(([name]) => name).join(', ')}`)
      mountFacts.push({ strategy, ...validation })
    }
    throwIfAborted(abortSignal)
    return {
      oracle, oracleText, prompts, promptsText, classifierText, plan, harness, mountFacts, research,
      protocolSnapshot,
    }
  }, abortSignal)
}

function promptForUnit(unit, prompts) {
  if (unit.phase === 'pilot') return prompts.pilot
  const prompt = prompts.tasks.find(candidate => candidate.id === unit.taskId)
  if (prompt === undefined) throw new Error(`plan references unknown prompt ${unit.taskId}`)
  return prompt
}

function applyCrossUnitInvariants(item, identityHashes, sessionHashes) {
  const failures = [...item.validation.failures]
  const identityHash = item.record?.run?.anonymousUserIdSha256
  const previous = identityHashes.get(item.identity)
  if (previous === undefined && typeof identityHash === 'string') {
    if ([...identityHashes.values()].includes(identityHash)) failures.push('identity-home-collision')
    identityHashes.set(item.identity, identityHash)
  } else if (previous !== identityHash) {
    failures.push('identity-home-drift')
  }
  const sessionHash = item.record?.runtime?.sessionIdSha256
  if (typeof sessionHash === 'string') {
    if (sessionHashes.has(sessionHash)) failures.push('duplicate-session')
    sessionHashes.add(sessionHash)
  }
  item.validation = { accepted: failures.length === 0, failures: [...new Set(failures)] }
  item.status = item.validation.accepted ? 'accepted' : 'aborted'
  return item
}

function progressOf(artifact) {
  const items = [...artifact.pilot, ...artifact.samples]
  return {
    plannedUnits: 164,
    attemptedUnits: items.length,
    observedRequestHeaders: items.reduce((sum, item) => sum + (item.record?.runtime?.requestHeaderCount ?? 0), 0),
    acceptedUnits: items.filter(item => item.status === 'accepted').length,
    abortedUnits: items.filter(item => item.status === 'aborted').length,
  }
}

async function executeUnit(unit, prompt, runtimeHome, baseOptions, secret, oracle, identityHashes, sessionHashes) {
  if (baseOptions.abortSignal?.aborted) throw baseOptions.abortSignal.reason
  const research = researchGitFacts()
  const closureSha256 = await digestDirectory(baseOptions.protocolSnapshotRoot)
  if (baseOptions.abortSignal?.aborted) throw baseOptions.abortSignal.reason
  if (research.trackedDirty || research.commit !== baseOptions.strategyCommit
    || closureSha256 !== oracle.artifactBinding.protocolClosureSha256) {
    return {
      ...unit,
      prompt: { sha256: sha256(prompt.text), chars: prompt.text.length },
      status: 'aborted',
      validation: { accepted: false, failures: ['research-or-protocol-closure-drift-before-provider-call'] },
      record: null,
    }
  }
  const record = await runJob({
    ...baseOptions,
    sequence: unit.sequence,
    runtimeHome,
    task: prompt.text,
  }, { strategy: unit.strategy, repetition: 1 }, secret)
  if (baseOptions.abortSignal?.aborted) throw baseOptions.abortSignal.reason
  const item = {
    ...unit,
    prompt: { sha256: sha256(prompt.text), chars: prompt.text.length },
    status: 'aborted',
    validation: validateSchemaBridgeObservation(record, unit, oracle),
    record,
  }
  return applyCrossUnitInvariants(item, identityHashes, sessionHashes)
}

async function removeRuntimeHomes(runtimeHomes) {
  const cleanup = await Promise.allSettled(runtimeHomes.map(home => rm(home.path, { recursive: true, force: true })))
  const ok = cleanup.every(result => result.status === 'fulfilled')
  if (ok) runtimeHomes.splice(0, runtimeHomes.length)
  return ok
}

async function removeProtocolSnapshot(holder) {
  if (holder.path === null) return true
  try {
    await rm(holder.path, { recursive: true, force: true })
    holder.path = null
    return true
  } catch {
    return false
  }
}

async function settleRunnerFailure({ artifact, out, runtimeHomes, protocolSnapshot, error, secret }) {
  const removed = await removeRuntimeHomes(runtimeHomes)
  const snapshotRemoved = await removeProtocolSnapshot(protocolSnapshot)
  const baseMessage = redactText(error instanceof Error ? error.message : String(error), [secret])
  const cleanupFailed = !removed || !snapshotRemoved
  const message = cleanupFailed ? `${baseMessage}; private runtime-state cleanup also failed` : baseMessage
  const terminal = terminalArtifact(artifact, 'runner-failed', {
    error: { message },
    progress: progressOf(artifact),
    privateRuntimeHomesRemoved: removed,
    privateProtocolSnapshotRemoved: snapshotRemoved,
  })
  await saveArtifact(out, terminal)
  throw new Error(message)
}

/** Run the fixed, guarded, real-DSH schema bridge protocol. */
export async function schemaBridgeLiveCommand(options, lifecycleOptions = {}) {
  const signalSource = lifecycleOptions.signalSource ?? process
  const lifecycle = installSignalGovernance(signalSource, {
    onRepeatedSignal: lifecycleOptions.onRepeatedSignal,
  })
  try {
    return await schemaBridgeLiveCommandGoverned(options, lifecycleOptions, lifecycle, signalSource)
  } finally {
    lifecycle.dispose()
  }
}

async function schemaBridgeLiveCommandGoverned(options, lifecycleOptions, lifecycle, signalSource) {
  lifecycle.throwIfInterrupted()
  validateDedicatedFlags(options)
  await requireFreshOutput(options.out)
  lifecycle.throwIfInterrupted()
  // Every operation above and inside keylessPreflight is credential-free.
  const testPreflight = lifecycleOptions.testOnlyKeylessPreflight
  if (testPreflight !== undefined && lifecycleOptions.schemaBridgeLifecycleTestMode !== true) {
    throw new Error('test-only keyless preflight requires explicit lifecycle test mode')
  }
  const preflight = await (testPreflight ?? keylessPreflight)(options, lifecycle.signal)
  if (testPreflight !== undefined) {
    throw new Error('test-only keyless preflight must interrupt and may never create a formal artifact')
  }
  const { oracle, plan, prompts } = preflight
  const protocolSnapshot = { path: preflight.protocolSnapshot.root }
  try {
    lifecycle.throwIfInterrupted()
  } catch (error) {
    await removeProtocolSnapshot(protocolSnapshot)
    throw error
  }
  const planned = {
    schemaVersion: 1,
    mode: 'schema-bridge-live',
    protocol: oracle.protocol,
    status: 'planned',
    createdAt: new Date().toISOString(),
    credentialMode: 'hidden TTY/readSecret to child stdin only; never argv/environment/artifact',
    rawArtifactPublication: 'forbidden; score with the publication-allowlisted scorer',
    privateRuntimeHomesRemoved: false,
    privateProtocolSnapshotRemoved: false,
    oracleSha256: SCHEMA_BRIDGE_ORACLE_SHA256,
    promptSetSha256: oracle.prompts.setCanonicalSha256,
    researchCommit: preflight.research.commit,
    classifier: { ...oracle.classifier },
    route: { ...oracle.artifactBinding },
    design: { ...oracle.design },
    plan,
    preflight: {
      completedBeforeCredentialRead: true,
      realDshMounts: preflight.mountFacts,
    },
    progress: { plannedUnits: 164, attemptedUnits: 0, observedRequestHeaders: 0, acceptedUnits: 0, abortedUnits: 0 },
    pilotGate: null,
    pilot: [],
    samples: [],
  }
  try {
    await writeInitialArtifact(options.out, planned)
  } catch (error) {
    await removeProtocolSnapshot(protocolSnapshot)
    throw error
  }

  let secret = ''
  const runtimeHomes = []
  let artifact = planned
  try {
    secret = await readSecret(
      lifecycleOptions.input ?? process.stdin,
      64 * 1024,
      lifecycleOptions.promptStream ?? process.stderr,
      signalSource,
      lifecycle.signal,
    )
    lifecycle.throwIfInterrupted()
    if (preflight.oracleText.includes(secret) || preflight.promptsText.includes(secret)
      || preflight.classifierText.includes(secret)) {
      throw new Error('refusing to run because the stdin credential appears in a non-secret protocol file')
    }
    for (const identity of SCHEMA_BRIDGE_IDENTITIES) {
      runtimeHomes.push({ identity, path: await mkdtemp(join(tmpdir(), 'dsh-schema-bridge-identity-')) })
      lifecycle.throwIfInterrupted()
    }
    const homeByIdentity = new Map(runtimeHomes.map(home => [home.identity, home.path]))
    const baseOptions = {
      ...fixedOptions(options, oracle),
      protocolSnapshotRoot: protocolSnapshot.path,
      protocolClosureSha256: preflight.protocolSnapshot.sha256,
      strategyCommit: preflight.research.commit,
      abortSignal: lifecycle.signal,
    }
    const identityHashes = new Map()
    const sessionHashes = new Set()

    artifact = { ...artifact, status: 'running-pilot' }
    await saveArtifact(options.out, artifact)
    lifecycle.throwIfInterrupted()
    for (const unit of plan.pilot) {
      const item = await executeUnit(
        unit, promptForUnit(unit, prompts), homeByIdentity.get(unit.identity), baseOptions,
        secret, oracle, identityHashes, sessionHashes,
      )
      artifact.pilot.push(item)
      artifact.progress = progressOf(artifact)
      if (artifact.progress.attemptedUnits > SCHEMA_BRIDGE_MAX_HTTP_ATTEMPTS) {
        throw new Error('fixed model-attempt unit cap exceeded')
      }
      await saveArtifact(options.out, artifact)
      lifecycle.throwIfInterrupted()
    }
    artifact.pilotGate = schemaBridgePilotGate(artifact.pilot)
    if (!artifact.pilotGate.passed) {
      if (!await removeRuntimeHomes(runtimeHomes)) throw new Error('failed to remove private schema-bridge runtime homes')
      if (!await removeProtocolSnapshot(protocolSnapshot)) throw new Error('failed to remove private schema-bridge protocol snapshot')
      lifecycle.throwIfInterrupted()
      artifact = terminalArtifact(artifact, 'pilot-aborted', {
        privateRuntimeHomesRemoved: true,
        privateProtocolSnapshotRemoved: true,
        stopReason: 'The fixed pilot protocol gate failed; no main request was sent and no unit was replaced.',
      })
      await saveArtifact(options.out, artifact)
      lifecycle.throwIfInterrupted()
      return 1
    }

    artifact.status = 'running-main'
    await saveArtifact(options.out, artifact)
    lifecycle.throwIfInterrupted()
    for (const block of plan.blocks) {
      // A block is deliberately contiguous; never interleave another identity/task.
      for (const unit of block.allocation) {
        const item = await executeUnit(
          unit, promptForUnit(unit, prompts), homeByIdentity.get(unit.identity), baseOptions,
          secret, oracle, identityHashes, sessionHashes,
        )
        artifact.samples.push(item)
        artifact.progress = progressOf(artifact)
        if (artifact.progress.attemptedUnits > SCHEMA_BRIDGE_MAX_HTTP_ATTEMPTS) {
          throw new Error('fixed model-attempt unit cap exceeded')
        }
        await saveArtifact(options.out, artifact)
        lifecycle.throwIfInterrupted()
      }
    }
    const allAccepted = artifact.samples.length === 160
      && artifact.samples.every(item => item.status === 'accepted')
      && artifact.progress.observedRequestHeaders === SCHEMA_BRIDGE_MAX_HTTP_ATTEMPTS
    if (!await removeRuntimeHomes(runtimeHomes)) throw new Error('failed to remove private schema-bridge runtime homes')
    if (!await removeProtocolSnapshot(protocolSnapshot)) throw new Error('failed to remove private schema-bridge protocol snapshot')
    lifecycle.throwIfInterrupted()
    artifact = terminalArtifact(artifact, allAccepted ? 'completed' : 'aborted', {
      privateRuntimeHomesRemoved: true,
      privateProtocolSnapshotRemoved: true,
      stopReason: allAccepted
        ? 'Fixed pilot and all 160 main units completed; no retry or replacement was used.'
        : 'At least one fixed main unit was aborted; it was retained in place and never replaced.',
    })
    await saveArtifact(options.out, artifact)
    lifecycle.throwIfInterrupted()
    process.stdout.write(`schema bridge live raw artifact: ${options.out}\nstatus: ${artifact.status}\n`)
    return allAccepted ? 0 : 1
  } catch (error) {
    return await settleRunnerFailure({
      artifact,
      out: options.out,
      runtimeHomes,
      protocolSnapshot,
      error: lifecycle?.interruptionError ?? error,
      secret,
    })
  } finally {
    secret = ''
    if (runtimeHomes.length > 0) {
      await Promise.allSettled(runtimeHomes.map(home => rm(home.path, { recursive: true, force: true })))
    }
    if (protocolSnapshot.path !== null) {
      await rm(protocolSnapshot.path, { recursive: true, force: true }).catch(() => {})
    }
  }
}
