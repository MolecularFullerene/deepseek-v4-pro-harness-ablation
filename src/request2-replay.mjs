import { createHash } from 'node:crypto'

export const REPLAY_VARIANTS = Object.freeze([
  Object.freeze({ id: 'retain-same', reasoning: 'retain', session: 'same' }),
  Object.freeze({ id: 'retain-new', reasoning: 'retain', session: 'new' }),
  Object.freeze({ id: 'drop-same', reasoning: 'drop', session: 'same' }),
  Object.freeze({ id: 'drop-new', reasoning: 'drop', session: 'new' }),
])

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

function assertString(value, path) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a non-empty string`)
}

/** Validate the frozen request-2 source fixture and locate its one eligible tool-call response. */
export function validateReplayFixture(fixture) {
  if (fixture === null || typeof fixture !== 'object' || Array.isArray(fixture)) throw new Error('fixture must be an object')
  assertString(fixture.provider, 'fixture.provider')
  assertString(fixture.model, 'fixture.model')
  assertString(fixture.originalSessionId, 'fixture.originalSessionId')
  assertString(fixture.newSessionId, 'fixture.newSessionId')
  assertString(fixture.anonymousUserId, 'fixture.anonymousUserId')
  if (fixture.originalSessionId === fixture.newSessionId) throw new Error('fixture session ids must differ')
  if (!Array.isArray(fixture.messages)) throw new Error('fixture.messages must be an array')
  const eligible = []
  for (let index = 0; index < fixture.messages.length; index += 1) {
    const message = fixture.messages[index]
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) continue
    const reasoning = message.content.filter(block => block?.type === 'reasoning' && typeof block.text === 'string' && block.text.length > 0)
    const toolCalls = message.content.filter(block => block?.type === 'tool-call')
    if (reasoning.length > 0 && toolCalls.length > 0) eligible.push({ index, reasoning, toolCalls })
  }
  if (eligible.length !== 1) {
    throw new Error(`fixture must contain exactly one assistant message with non-empty reasoning and tool calls; found ${eligible.length}`)
  }
  const target = eligible[0]
  for (const [offset, block] of target.toolCalls.entries()) {
    assertString(block.id, `fixture.messages[${target.index}].content.toolCalls[${offset}].id`)
    assertString(block.name, `fixture.messages[${target.index}].content.toolCalls[${offset}].name`)
    if (typeof block.arguments !== 'string') throw new Error('tool-call arguments must already be a JSON string')
  }
  if (fixture.tools !== undefined && !Array.isArray(fixture.tools)) throw new Error('fixture.tools must be an array when provided')
  return { assistantMessageIndex: target.index }
}

/** Build the raw request-2 2x2 from one immutable first-response history. */
export function buildReplayMatrix(input) {
  const fixture = structuredClone(input)
  const { assistantMessageIndex } = validateReplayFixture(fixture)
  const originalHash = sha256(JSON.stringify(fixture.messages[assistantMessageIndex]))
  const variants = REPLAY_VARIANTS.map(factor => {
    const messages = structuredClone(fixture.messages)
    if (factor.reasoning === 'drop') {
      messages[assistantMessageIndex].content = messages[assistantMessageIndex].content
        .filter(block => block.type !== 'reasoning')
    }
    const sessionId = factor.session === 'same' ? fixture.originalSessionId : fixture.newSessionId
    return deepFreeze({
      id: factor.id,
      factors: { reasoning: factor.reasoning, sessionId: factor.session },
      options: {
        provider: fixture.provider,
        model: fixture.model,
        messages,
        ...(fixture.system === undefined ? {} : { system: fixture.system }),
        ...(fixture.tools === undefined ? {} : { tools: structuredClone(fixture.tools) }),
        ...(fixture.reasoningEffort === undefined ? {} : { reasoningEffort: fixture.reasoningEffort }),
        ...(fixture.temperature === undefined ? {} : { temperature: fixture.temperature }),
        ...(fixture.maxTokens === undefined ? {} : { maxTokens: fixture.maxTokens }),
        ...(fixture.stop === undefined ? {} : { stop: structuredClone(fixture.stop) }),
        sessionId,
      },
    })
  })
  return deepFreeze({
    fixtureSha256: sha256(JSON.stringify(fixture)),
    firstToolCallResponseSha256: originalHash,
    assistantMessageIndex,
    variants,
  })
}

const MISSING = Symbol('missing')

/** Deterministic leaf/path diff for JSON-compatible values. */
export function diffJson(left, right, path = '') {
  if (Object.is(left, right)) return []
  if (Array.isArray(left) && Array.isArray(right)) {
    const diffs = []
    const length = Math.max(left.length, right.length)
    for (let index = 0; index < length; index += 1) {
      diffs.push(...diffJson(index in left ? left[index] : MISSING, index in right ? right[index] : MISSING, `${path}/${index}`))
    }
    return diffs
  }
  if (left !== MISSING && right !== MISSING
    && left !== null && right !== null
    && typeof left === 'object' && typeof right === 'object'
    && !Array.isArray(left) && !Array.isArray(right)) {
    const keys = [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()
    return keys.flatMap(key => diffJson(
      Object.hasOwn(left, key) ? left[key] : MISSING,
      Object.hasOwn(right, key) ? right[key] : MISSING,
      `${path}/${key.replaceAll('~', '~0').replaceAll('/', '~1')}`,
    ))
  }
  return [{
    path: path || '/',
    left: left === MISSING ? { missing: true } : left,
    right: right === MISSING ? { missing: true } : right,
  }]
}

function withoutAuthorization(headers) {
  return Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'authorization'))
}

function exactlySessionHeader(diffs) {
  return diffs.length === 1 && diffs[0].path === '/x-deepseek-harness-session-id'
}

function reasoningRemovalProof(retain, drop) {
  const left = JSON.parse(retain.rawBody)
  const right = JSON.parse(drop.rawBody)
  const diffs = diffJson(left, right)
  if (diffs.length !== 1 || !diffs[0].path.endsWith('/reasoning_content')) {
    return { passed: false, diffPaths: diffs.map(item => item.path), normalizedBytesEqual: false }
  }
  const segments = diffs[0].path.split('/').slice(1)
  let cursor = left
  for (const segment of segments.slice(0, -1)) cursor = cursor[Number.isInteger(Number(segment)) && segment !== '' ? Number(segment) : segment]
  delete cursor[segments.at(-1)]
  return {
    passed: JSON.stringify(left) === drop.rawBody,
    diffPaths: diffs.map(item => item.path),
    normalizedBytesEqual: JSON.stringify(left) === drop.rawBody,
  }
}

/**
 * Prove the four captures differ only by reasoning_content and session header.
 * Captures include raw bodies and full headers in memory; the returned report
 * intentionally removes Authorization. Raw bodies are retained in the
 * mode-0600 replay bundle so a later, separately authorized sender can reuse
 * the exact serializer output instead of reconstructing it.
 */
export function analyzeReplayCaptures(matrix, captures) {
  if (!Array.isArray(captures) || captures.length !== 4) throw new Error('expected exactly four adapter captures')
  const byId = Object.fromEntries(captures.map(capture => [capture.id, capture]))
  for (const variant of REPLAY_VARIANTS) {
    const capture = byId[variant.id]
    if (capture === undefined) throw new Error(`missing adapter capture ${variant.id}`)
    if (typeof capture.rawBody !== 'string') throw new Error(`${variant.id}.rawBody is missing`)
    if (capture.headers === null || typeof capture.headers !== 'object') throw new Error(`${variant.id}.headers is missing`)
  }

  const rs = byId['retain-same']
  const rn = byId['retain-new']
  const ds = byId['drop-same']
  const dn = byId['drop-new']
  const retainReasoning = reasoningRemovalProof(rs, ds)
  const newReasoning = reasoningRemovalProof(rn, dn)
  const retainSessionHeaderDiffs = diffJson(rs.headers, rn.headers)
  const dropSessionHeaderDiffs = diffJson(ds.headers, dn.headers)
  const checks = {
    sameSessionChangeLeavesHeadersIdentical: diffJson(rs.headers, ds.headers).length === 0,
    newSessionChangeLeavesHeadersIdentical: diffJson(rn.headers, dn.headers).length === 0,
    retainBodyByteIdenticalAcrossSessionFactor: rs.rawBody === rn.rawBody,
    dropBodyByteIdenticalAcrossSessionFactor: ds.rawBody === dn.rawBody,
    retainHeadersDifferOnlyBySessionId: exactlySessionHeader(retainSessionHeaderDiffs),
    dropHeadersDifferOnlyBySessionId: exactlySessionHeader(dropSessionHeaderDiffs),
    retainVsDropDiffOnlyReasoningContentSameSession: retainReasoning.passed,
    retainVsDropDiffOnlyReasoningContentNewSession: newReasoning.passed,
    sameUserIdAcrossAllVariants: new Set(captures.map(item => item.headers['x-deepseek-harness-user-id'])).size === 1,
    authorizationPresentButNeverExported: captures.every(item => typeof item.headers.authorization === 'string'),
  }
  if (!Object.values(checks).every(Boolean)) {
    throw new Error(`request2 replay conformance failed: ${JSON.stringify(checks)}`)
  }

  return {
    schemaVersion: 1,
    mode: 'raw-official-adapter-replay',
    fixtureSha256: matrix.fixtureSha256,
    firstToolCallResponseSha256: matrix.firstToolCallResponseSha256,
    assistantMessageIndex: matrix.assistantMessageIndex,
    credentialMode: 'fixed in-memory offline sentinel; no environment or file credential lookup',
    variants: REPLAY_VARIANTS.map(variant => {
      const capture = byId[variant.id]
      return {
        id: variant.id,
        factors: { reasoning: variant.reasoning, sessionId: variant.session },
        url: capture.url,
        bodySha256: sha256(capture.rawBody),
        bodyBytes: Buffer.byteLength(capture.rawBody),
        rawBody: capture.rawBody,
        headers: withoutAuthorization(capture.headers),
      }
    }),
    comparisons: {
      retainSessionFactor: {
        bodyByteIdentical: rs.rawBody === rn.rawBody,
        headerDiffPaths: retainSessionHeaderDiffs.map(item => item.path),
      },
      dropSessionFactor: {
        bodyByteIdentical: ds.rawBody === dn.rawBody,
        headerDiffPaths: dropSessionHeaderDiffs.map(item => item.path),
      },
      reasoningFactorSameSession: retainReasoning,
      reasoningFactorNewSession: newReasoning,
    },
    checks,
  }
}
