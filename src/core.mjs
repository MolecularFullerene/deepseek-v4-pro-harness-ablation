import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'

/** Stable SHA-256 over a string. */
export function sha256(text) {
  return createHash('sha256').update(text).digest('hex')
}

/** Canonical JSON used for reproducible public configuration fingerprints. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

/** Fingerprint an allowlisted, secret-free experiment configuration. */
export function configFingerprint(config) {
  return sha256(canonicalJson(config))
}

/** Validate and normalize a non-secret HTTP(S) API base URL. */
export function normalizeBaseUrl(raw) {
  let url
  try {
    url = new URL(raw)
  } catch {
    throw new Error('base URL must be an absolute HTTP(S) URL')
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('base URL must use http or https')
  }
  if (url.username !== '' || url.password !== '') {
    throw new Error('base URL must not contain embedded credentials')
  }
  if (url.search !== '' || url.hash !== '') {
    throw new Error('base URL must not contain a query string or fragment')
  }
  return url.toString().replace(/\/$/, '')
}

/** Remove secrets from arbitrary captured process text. */
export function redactText(value, secrets = []) {
  let text = String(value)
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length > 0) text = text.split(secret).join('[REDACTED]')
  }
  text = text
    .replace(/(authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,;"']+/gi, '$1[REDACTED]')
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [REDACTED]')
  return text
}

/** Recursively redact strings without changing non-string JSON values. */
export function redactValue(value, secrets = []) {
  if (typeof value === 'string') return redactText(value, secrets)
  if (Array.isArray(value)) return value.map(item => redactValue(item, secrets))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactValue(item, secrets)]))
  }
  return value
}

/**
 * Build the child's least-secret environment. Credential-like parent entries
 * are removed; the DeepSeek key is delivered only over the anonymous stdin pipe.
 */
export function childEnvironment(parent, overrides = {}) {
  const env = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue
    if (/(?:^|_)(?:API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIALS?)(?:_|$)/i.test(key)) continue
    env[key] = value
  }
  return { ...env, ...overrides }
}

/**
 * Build a deliberately small child environment for credential-bearing formal
 * protocols. Node preload hooks, DSH/DeepSeek knobs, proxy configuration,
 * credentials, and unrelated application state are intentionally not inherited.
 */
export function minimalChildEnvironment(parent, overrides = {}) {
  const allowed = new Set([
    'PATH', 'TMPDIR', 'TMP', 'TEMP',
    'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'ComSpec', 'COMSPEC', 'PATHEXT',
    'LANG', 'LANGUAGE', 'LC_ALL', 'LC_CTYPE', 'TZ',
  ])
  const env = {}
  for (const [key, value] of Object.entries(parent)) {
    if (value !== undefined && allowed.has(key)) env[key] = value
  }
  return { ...env, ...overrides }
}

/** Deterministically shuffle a list from a recorded string seed. */
export function seededShuffle(values, seed) {
  const result = [...values]
  let counter = 0
  const random = () => {
    const digest = createHash('sha256').update(`${seed}\0${counter++}`).digest()
    return digest.readUInt32BE(0) / 0x1_0000_0000
  }
  for (let index = result.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1))
    ;[result[index], result[swap]] = [result[swap], result[index]]
  }
  return result
}

/** Build repeated jobs, optionally random-interleaved with a reproducible seed. */
export function buildJobs(strategies, repeat, order, seed) {
  const jobs = []
  for (let repetition = 1; repetition <= repeat; repetition += 1) {
    for (const strategy of strategies) jobs.push({ strategy, repetition })
  }
  return order === 'random' ? seededShuffle(jobs, seed) : jobs
}

function decodeSecret(buffer) {
  const secret = buffer.toString('utf8').replace(/(?:\r?\n)$/, '')
  if (secret.length === 0) throw new Error('API key is empty')
  if (secret.includes('\0')) throw new Error('API key contains a NUL byte')
  return secret
}

const TTY_INPUT_SIGNALS = Object.freeze(['SIGINT', 'SIGTERM', 'SIGHUP'])

function abortReason(signal, fallback = 'operation was aborted') {
  return signal?.reason instanceof Error ? signal.reason : new Error(fallback)
}

async function readHiddenTtySecret(stream, maxBytes, promptStream, signalSource, abortSignal) {
  if (typeof stream.setRawMode !== 'function') throw new Error('TTY stdin cannot disable echo')
  const bytes = []
  const wasRaw = stream.isRaw === true
  let rawModeActive = false
  let prompted = false
  let finished = false
  let resolveInput
  let rejectInput

  const cleanupInputListeners = () => {
    stream.off('data', onData)
    stream.off('end', onEnd)
    stream.off('error', onError)
    stream.off('close', onClose)
  }
  const finish = error => {
    if (finished) return
    finished = true
    cleanupInputListeners()
    if (error === undefined) resolveInput(Buffer.from(bytes))
    else rejectInput(error)
  }
  const onData = chunk => {
    for (const byte of Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)) {
      if (byte === 3) return finish(new Error('API key input was cancelled'))
      if (byte === 4 || byte === 10 || byte === 13) return finish()
      if (byte === 8 || byte === 127) {
        bytes.pop()
        continue
      }
      bytes.push(byte)
      if (bytes.length > maxBytes) return finish(new Error('API key from stdin exceeds 64 KiB'))
    }
  }
  const onEnd = () => finish()
  const onError = error => finish(error)
  const onClose = () => finish(new Error('TTY stdin closed before API key input completed'))
  const onAbort = () => {
    try {
      restoreTerminal()
    } catch {
      // The main cleanup path will report a terminal restoration failure.
    }
    finish(abortReason(abortSignal, 'API key input was aborted'))
    stream.destroy()
  }
  const input = new Promise((resolve, reject) => {
    resolveInput = resolve
    rejectInput = reject
  })

  const restoreTerminal = () => {
    if (!rawModeActive) return
    stream.setRawMode(wasRaw)
    rawModeActive = false
  }
  const signalHandlers = new Map(TTY_INPUT_SIGNALS.map(signal => [signal, () => {
    let error = new Error(`API key input was interrupted by ${signal}`)
    try {
      restoreTerminal()
    } catch (restoreError) {
      error = new Error(`failed to restore TTY mode after ${signal}`, { cause: restoreError })
    }
    finish(error)
    // Releasing the resumed TTY handle lets a plain CLI finish its error path
    // instead of hanging after the signal has been converted to a rejection.
    stream.destroy()
  }]))
  const cleanupSignalListeners = () => {
    for (const [signal, handler] of signalHandlers) signalSource.off(signal, handler)
  }
  try {
    if (abortSignal?.aborted) throw abortReason(abortSignal, 'API key input was aborted')
    abortSignal?.addEventListener('abort', onAbort, { once: true })
    if (abortSignal?.aborted) throw abortReason(abortSignal, 'API key input was aborted')
    for (const [signal, handler] of signalHandlers) signalSource.prependOnceListener(signal, handler)
    // Do not advertise a hidden prompt until echo has actually been disabled.
    stream.setRawMode(true)
    rawModeActive = true
    // Attaching a data listener can make a Readable flow, so it too belongs
    // behind the successful raw-mode transition.
    stream.on('data', onData)
    stream.once('end', onEnd)
    stream.once('error', onError)
    stream.once('close', onClose)
    prompted = true
    promptStream.write('Temporary API key (input hidden): ')
    stream.resume()
    return decodeSecret(await input)
  } finally {
    abortSignal?.removeEventListener('abort', onAbort)
    cleanupInputListeners()
    cleanupSignalListeners()
    let cleanupError
    try {
      restoreTerminal()
    } catch (error) {
      cleanupError = error
    }
    try {
      stream.pause()
    } catch (error) {
      cleanupError ??= error
    }
    if (prompted) {
      try {
        promptStream.write('\n')
      } catch (error) {
        cleanupError ??= error
      }
    }
    if (cleanupError !== undefined) throw cleanupError
  }
}

/** Read one secret from stdin with a strict in-memory size bound. TTY input is
 * placed in raw mode and completed by Enter/EOF so the value is never echoed. */
export async function readSecret(
  stream,
  maxBytes = 64 * 1024,
  promptStream = process.stderr,
  signalSource = process,
  abortSignal,
) {
  if (stream.isTTY === true) {
    return await readHiddenTtySecret(stream, maxBytes, promptStream, signalSource, abortSignal)
  }
  if (abortSignal?.aborted) throw abortReason(abortSignal, 'API key input was aborted')
  let rejectAborted
  const aborted = new Promise((resolve, reject) => { rejectAborted = reject })
  const onAbort = () => {
    rejectAborted(abortReason(abortSignal, 'API key input was aborted'))
    stream.destroy()
  }
  const reading = (async () => {
    const chunks = []
    let bytes = 0
    for await (const chunk of stream) {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
      bytes += buffer.length
      if (bytes > maxBytes) throw new Error('API key from stdin exceeds 64 KiB')
      chunks.push(buffer)
    }
    return decodeSecret(Buffer.concat(chunks))
  })()
  if (abortSignal === undefined) return await reading
  abortSignal.addEventListener('abort', onAbort, { once: true })
  if (abortSignal.aborted) onAbort()
  try {
    return await Promise.race([reading, aborted])
  } finally {
    abortSignal.removeEventListener('abort', onAbort)
  }
}

/**
 * Spawn a child, feed the key through stdin only, and return redacted output.
 * The key never enters argv or the child environment.
 */
export async function spawnWithSecret({
  command,
  args,
  cwd,
  env,
  secret = '',
  timeoutMs = 900_000,
  maxOutputBytes = 32 * 1024 * 1024,
  signal,
  terminationGraceMs = 1_000,
  killSettleMs = 1_000,
}) {
  if (args.some(argument => secret.length > 0 && argument.includes(secret))) {
    throw new Error('refusing to place the API key in child argv')
  }
  if (Object.values(env).some(value => secret.length > 0 && String(value).includes(secret))) {
    throw new Error('refusing to place the API key in the child environment')
  }

  if (signal?.aborted) throw abortReason(signal, 'child launch was aborted')
  if (!Number.isFinite(terminationGraceMs) || terminationGraceMs < 0
    || !Number.isFinite(killSettleMs) || killSettleMs < 0) {
    throw new Error('child termination grace values must be finite non-negative milliseconds')
  }

  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout = []
  const stderr = []
  let outputBytes = 0
  let overflow = false
  let timedOut = false
  let aborted = false
  let forcedKill = false
  let forcedSettle = false
  let terminationStarted = false
  let timeoutTimer
  let killTimer
  let settleTimer
  let settled = false
  let resolveOutcome
  let rejectOutcome

  const clearTimers = () => {
    clearTimeout(timeoutTimer)
    clearTimeout(killTimer)
    clearTimeout(settleTimer)
  }
  const finish = (callback, value) => {
    if (settled) return
    settled = true
    clearTimers()
    signal?.removeEventListener('abort', onAbort)
    callback(value)
  }
  const terminate = () => {
    if (settled || terminationStarted) return
    terminationStarted = true
    clearTimeout(timeoutTimer)
    try {
      child.kill('SIGTERM')
    } catch {
      // The close/error event or bounded settle below remains authoritative.
    }
    killTimer = setTimeout(() => {
      if (settled) return
      forcedKill = true
      try {
        child.kill('SIGKILL')
      } catch {
        // Bound the caller even if the platform cannot report process closure.
      }
      settleTimer = setTimeout(() => {
        if (settled) return
        forcedSettle = true
        child.stdin.destroy()
        child.stdout.destroy()
        child.stderr.destroy()
        child.unref()
        finish(resolveOutcome, { code: null, signal: 'SIGKILL' })
      }, killSettleMs)
    }, terminationGraceMs)
  }
  const onAbort = () => {
    aborted = true
    terminate()
  }
  const collect = target => chunk => {
    if (overflow) return
    outputBytes += chunk.length
    if (outputBytes > maxOutputBytes) {
      overflow = true
      terminate()
      return
    }
    target.push(chunk)
  }
  const outcomePromise = new Promise((resolve, reject) => {
    resolveOutcome = resolve
    rejectOutcome = reject
    child.once('error', error => finish(rejectOutcome, error))
    child.once('close', (code, childSignal) => finish(resolveOutcome, { code, signal: childSignal }))
  })
  child.stdout.on('data', collect(stdout))
  child.stderr.on('data', collect(stderr))
  child.stdin.on('error', () => {})
  child.stdin.end(secret)
  signal?.addEventListener('abort', onAbort, { once: true })
  timeoutTimer = setTimeout(() => {
    timedOut = true
    terminate()
  }, timeoutMs)
  if (signal?.aborted) onAbort()
  const outcome = await outcomePromise

  return {
    ...outcome,
    timedOut,
    overflow,
    aborted,
    forcedKill,
    forcedSettle,
    stdout: redactText(Buffer.concat(stdout).toString('utf8'), [secret]),
    stderr: redactText(Buffer.concat(stderr).toString('utf8'), [secret]),
  }
}

/** Extract the event-level report emitted by the runtime plugin. */
export function parseRuntimeReport(stdout, prefix = 'DSH_LAB_RESULT ') {
  const lines = stdout.split(/\r?\n/)
  const line = [...lines].reverse().find(candidate => candidate.startsWith(prefix))
  if (line === undefined) return undefined
  return JSON.parse(line.slice(prefix.length))
}
