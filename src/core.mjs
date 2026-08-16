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

/** Read one secret from stdin with a strict in-memory size bound. */
export async function readSecret(stream, maxBytes = 64 * 1024) {
  const chunks = []
  let bytes = 0
  for await (const chunk of stream) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > maxBytes) throw new Error('API key from stdin exceeds 64 KiB')
    chunks.push(buffer)
  }
  const secret = Buffer.concat(chunks).toString('utf8').replace(/(?:\r?\n)$/, '')
  if (secret.length === 0) throw new Error('API key is empty')
  if (secret.includes('\0')) throw new Error('API key contains a NUL byte')
  return secret
}

/**
 * Spawn a child, feed the key through stdin only, and return redacted output.
 * The key never enters argv or the child environment.
 */
export async function spawnWithSecret({ command, args, cwd, env, secret = '', timeoutMs = 900_000, maxOutputBytes = 32 * 1024 * 1024 }) {
  if (args.some(argument => secret.length > 0 && argument.includes(secret))) {
    throw new Error('refusing to place the API key in child argv')
  }
  if (Object.values(env).some(value => secret.length > 0 && String(value).includes(secret))) {
    throw new Error('refusing to place the API key in the child environment')
  }

  const child = spawn(command, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'] })
  const stdout = []
  const stderr = []
  let outputBytes = 0
  let overflow = false
  const collect = target => chunk => {
    outputBytes += chunk.length
    if (outputBytes > maxOutputBytes) {
      overflow = true
      child.kill('SIGTERM')
      return
    }
    target.push(chunk)
  }
  child.stdout.on('data', collect(stdout))
  child.stderr.on('data', collect(stderr))
  child.stdin.on('error', () => {})
  child.stdin.end(secret)

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
