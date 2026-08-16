/**
 * Read-only in-memory credential provider for dsh-lab-cli.
 *
 * The parent sends the DeepSeek key over this process's anonymous stdin pipe.
 * It is never placed in argv, the process environment, a Cordis config, or a file.
 */

import { Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { CredentialProvider, credentialRef } from '@deepseek-ai/dsh-credentials'

const MAX_SECRET_BYTES = 64 * 1024

async function readPipe() {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    bytes += buffer.length
    if (bytes > MAX_SECRET_BYTES) throw new Error('pipe-credentials: credential exceeds 64 KiB')
    chunks.push(buffer)
  }
  const value = Buffer.concat(chunks).toString('utf8')
  if (value.includes('\0')) throw new Error('pipe-credentials: credential contains a NUL byte')
  return value
}

export default class PipeCredentials extends CredentialProvider {
  static Config = z.object({
    ref: z.string().default('DEEPSEEK_API_KEY'),
    allowEmpty: z.boolean().default(false),
  })

  constructor(ctx, config) {
    super(ctx)
    // Cordis service calls are traced through a Proxy. JavaScript private
    // fields reject that receiver, so keep these values as non-enumerable own
    // properties: proxy-safe without exposing the secret to object dumps.
    Object.defineProperties(this, {
      secret: { value: undefined, writable: true, enumerable: false },
      ref: { value: credentialRef(config.ref ?? 'DEEPSEEK_API_KEY'), enumerable: false },
      allowEmpty: { value: config.allowEmpty ?? false, enumerable: false },
    })
  }

  async *[Service.init]() {
    const value = await readPipe()
    if (value.length === 0 && !this.allowEmpty) throw new Error('pipe-credentials: credential is empty')
    this.secret = value.length === 0 ? undefined : value
    yield () => { this.secret = undefined }
  }

  async resolve(ref) {
    if (ref !== this.ref || this.secret === undefined) return undefined
    return { value: this.secret, source: 'memory-pipe' }
  }

  async describe(ref) {
    return {
      configured: ref === this.ref && this.secret !== undefined,
      ...(ref === this.ref && this.secret !== undefined ? { source: 'memory-pipe' } : {}),
      writable: false,
    }
  }

  async set() {
    throw new Error('pipe-credentials: provider is read-only')
  }

  async unset() {
    throw new Error('pipe-credentials: provider is read-only')
  }
}
