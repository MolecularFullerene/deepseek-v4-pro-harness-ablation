import { randomUUID } from 'node:crypto'
import { canonicalJson, seededShuffle, sha256 } from './core.mjs'
import { REPLAY_VARIANTS } from './request2-replay.mjs'

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const item of Object.values(value)) deepFreeze(item)
  }
  return value
}

function assertNonEmptyString(value, path) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a non-empty string`)
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Validate the secret-free request1 template and fixed, non-executable tool fixtures. */
export function validateLiveReplayFixture(input) {
  if (!plainObject(input)) throw new Error('live fixture must be an object')
  const fixture = structuredClone(input)
  assertNonEmptyString(fixture.anonymousUserId, 'fixture.anonymousUserId')
  if (fixture.system !== undefined && typeof fixture.system !== 'string') throw new Error('fixture.system must be a string')
  if (!Array.isArray(fixture.messages) || fixture.messages.length !== 1) {
    throw new Error('fixture.messages must contain exactly one initial user message')
  }
  const message = fixture.messages[0]
  if (message?.role !== 'user' || !Array.isArray(message.content) || message.content.length === 0) {
    throw new Error('fixture.messages[0] must be a non-empty user message')
  }
  if (!message.content.every(block => block?.type === 'text' && typeof block.text === 'string')) {
    throw new Error('fixture.messages[0] may contain text blocks only')
  }
  if (message.content.every(block => block.text.length === 0)) throw new Error('fixture.messages[0] text is empty')
  if (!Array.isArray(fixture.tools) || fixture.tools.length === 0) throw new Error('fixture.tools must be a non-empty array')
  if (!plainObject(fixture.toolResultFixtures)) throw new Error('fixture.toolResultFixtures must be an object')

  const toolNames = new Set()
  for (let index = 0; index < fixture.tools.length; index += 1) {
    const tool = fixture.tools[index]
    assertNonEmptyString(tool?.name, `fixture.tools[${index}].name`)
    assertNonEmptyString(tool?.description, `fixture.tools[${index}].description`)
    if (!plainObject(tool?.parameters)) throw new Error(`fixture.tools[${index}].parameters must be an object`)
    if (toolNames.has(tool.name)) throw new Error(`fixture.tools has duplicate name ${JSON.stringify(tool.name)}`)
    toolNames.add(tool.name)
    const result = fixture.toolResultFixtures[tool.name]
    if (!plainObject(result)) throw new Error(`fixture.toolResultFixtures.${tool.name} must be an object`)
    if (typeof result.text !== 'string' || result.text.length > 4096) {
      throw new Error(`fixture.toolResultFixtures.${tool.name}.text must be a string of at most 4096 characters`)
    }
    if (result.isError !== undefined && typeof result.isError !== 'boolean') {
      throw new Error(`fixture.toolResultFixtures.${tool.name}.isError must be boolean when provided`)
    }
  }
  for (const name of Object.keys(fixture.toolResultFixtures)) {
    if (!toolNames.has(name)) throw new Error(`tool result fixture ${JSON.stringify(name)} has no matching declared tool`)
  }
  if (!plainObject(fixture.expectedSurface)) throw new Error('fixture.expectedSurface must be an object')
  const actualSurface = {
    systemSha256: sha256(fixture.system ?? ''),
    orderedToolNames: fixture.tools.map(tool => tool.name),
    toolSchemaSha256: fixture.tools.map(tool => sha256(JSON.stringify(tool))),
  }
  if (canonicalJson(actualSurface) !== canonicalJson(fixture.expectedSurface)) {
    throw new Error(`fixture does not match its frozen DSH surface proof: ${JSON.stringify(actualSurface)}`)
  }
  if (fixture.stop !== undefined
    && (!Array.isArray(fixture.stop) || !fixture.stop.every(item => typeof item === 'string' && item.length > 0))) {
    throw new Error('fixture.stop must be an array of non-empty strings')
  }
  if (!plainObject(fixture.expectedJson)) throw new Error('fixture.expectedJson must be a JSON object')
  try {
    JSON.stringify(fixture.expectedJson)
  } catch {
    throw new Error('fixture.expectedJson must be lossless JSON data')
  }
  if (!plainObject(fixture.surfaceLock)) throw new Error('fixture.surfaceLock must be a real-mount evidence object')
  if (fixture.surfaceLock.source !== 'official-minimal-real-mount') {
    throw new Error('fixture.surfaceLock.source must be official-minimal-real-mount')
  }
  assertNonEmptyString(fixture.surfaceLock.harnessCommit, 'fixture.surfaceLock.harnessCommit')
  assertNonEmptyString(fixture.surfaceLock.platform, 'fixture.surfaceLock.platform')
  const toolLocks = fixture.surfaceLock.tools
  if (!Array.isArray(toolLocks) || toolLocks.length !== fixture.tools.length) {
    throw new Error('fixture.surfaceLock.tools must cover the complete tool surface')
  }
  const computedSystem = sha256(fixture.system ?? '')
  const computedSurface = sha256(JSON.stringify({ system: fixture.system, tools: fixture.tools }))
  if (fixture.surfaceLock.systemSha256 !== computedSystem) throw new Error('fixture surface system SHA does not match its system text')
  if (fixture.surfaceLock.surfaceSha256 !== computedSurface) throw new Error('fixture surface SHA does not match its system/tools')
  fixture.tools.forEach((tool, index) => {
    const lock = toolLocks[index]
    if (lock?.name !== tool.name || lock?.schemaSha256 !== sha256(JSON.stringify(tool))) {
      throw new Error(`fixture surface tool lock does not match tools[${index}]`)
    }
  })
  return deepFreeze(fixture)
}

function jsonObjectCandidates(text) {
  const candidates = []
  for (let start = 0; start < text.length; start += 1) {
    if (text[start] !== '{') continue
    let depth = 0
    let quoted = false
    let escaped = false
    for (let index = start; index < text.length; index += 1) {
      const character = text[index]
      if (quoted) {
        if (escaped) escaped = false
        else if (character === '\\') escaped = true
        else if (character === '"') quoted = false
        continue
      }
      if (character === '"') quoted = true
      else if (character === '{') depth += 1
      else if (character === '}') {
        depth -= 1
        if (depth === 0) {
          const raw = text.slice(start, index + 1)
          let accepted = false
          try {
            const value = JSON.parse(raw)
            if (plainObject(value)) {
              candidates.push({ raw, value, start, end: index + 1 })
              accepted = true
            }
          } catch { /* not a valid JSON object */ }
          // A valid outer object owns its nested braces; continue after it so
          // nested member objects are not miscounted as independent answers.
          if (accepted) start = index
          break
        }
      }
    }
  }
  return candidates
}

/** Strict preregistered request2 scorer: one JSON object and exact fields/values. */
export function scoreExpectedJson(text, expectedJson, protocolSuccess = true) {
  const candidates = jsonObjectCandidates(text)
  const unique = candidates.length === 1 ? candidates[0] : undefined
  const answerCorrect = protocolSuccess
    && unique !== undefined
    && canonicalJson(unique.value) === canonicalJson(expectedJson)
  return {
    method: 'extract exactly one JSON object; canonical deep equality against preregistered expectedJson',
    protocolSuccess,
    scorable: protocolSuccess && unique !== undefined,
    answerCorrect,
    jsonObjectCount: candidates.length,
    visibleTextIsOnlyJson: unique === undefined ? false : text.trim() === unique.raw,
    expectedJsonSha256: sha256(canonicalJson(expectedJson)),
    actualJsonSha256: unique === undefined ? null : sha256(canonicalJson(unique.value)),
  }
}

/** Non-scoring trajectory labels. */
export function reasoningDiagnostics(reasoning) {
  const trimmed = String(reasoning).trimStart()
  return {
    startsWithWeNeed: /^we need\b/i.test(trimmed),
    startsWithLetMe: /^let me\b/i.test(trimmed),
    labelRole: 'diagnostic-only; never used as protocol success or answer correctness',
  }
}

function sessionId(label) {
  return `dsh-lab-${label}-${randomUUID()}`
}

/**
 * Freeze all treatment allocation and session identities before request1.
 * Every block contains each treatment exactly once in seeded random order.
 */
export function buildLiveReplayPlan({ repeat, seed, makeSessionId = sessionId }) {
  if (!Number.isInteger(repeat) || repeat < 1 || repeat > 100) throw new Error('live --repeat must be an integer from 1 to 100')
  assertNonEmptyString(seed, 'seed')
  const used = new Set()
  const fresh = label => {
    const value = makeSessionId(label)
    assertNonEmptyString(value, `generated ${label} session id`)
    if (used.has(value)) throw new Error('session id generator returned a duplicate')
    used.add(value)
    return value
  }
  const pilot = {
    allocation: seededShuffle(REPLAY_VARIANTS, `${seed}\0pilot`).map((treatment, index) => ({
      unitId: `pilot-unit-${String(index + 1).padStart(2, '0')}`,
      position: index + 1,
      treatment: { id: treatment.id, reasoning: treatment.reasoning, session: treatment.session },
      sourceSessionId: fresh('pilot-source'),
      newSessionId: fresh('pilot-new'),
    })),
  }
  const blocks = []
  for (let block = 1; block <= repeat; block += 1) {
    const allocation = seededShuffle(REPLAY_VARIANTS, `${seed}\0block:${block}`).map((treatment, index) => ({
      unitId: `block-${String(block).padStart(3, '0')}-unit-${String(index + 1).padStart(2, '0')}`,
      block,
      position: index + 1,
      treatment: { id: treatment.id, reasoning: treatment.reasoning, session: treatment.session },
      sourceSessionId: fresh(`b${block}-source`),
      newSessionId: fresh(`b${block}-new`),
    }))
    blocks.push({ block, allocation })
  }
  return deepFreeze({
    seed,
    repeat,
    pilot,
    blocks,
    stopRule: 'Run four independent-source protocol-pilot cells first. Main samples require all four to succeed. Only both retain cells succeeding plus a drop-cell HTTP 400 identifies drop protocol rejection; every other failure is factorial-pilot-unidentifiable.',
  })
}

function publicUnit(unit) {
  const request2SessionId = unit.treatment.session === 'same' ? unit.sourceSessionId : unit.newSessionId
  return {
    unitId: unit.unitId,
    ...(unit.block === undefined ? {} : { block: unit.block, position: unit.position }),
    treatment: { ...unit.treatment },
    sourceSessionIdSha256: sha256(unit.sourceSessionId),
    request2SessionIdSha256: sha256(request2SessionId),
    sessionRelationCheck: unit.treatment.session === 'same'
      ? request2SessionId === unit.sourceSessionId
      : request2SessionId !== unit.sourceSessionId,
  }
}

/** Export only hashes of model-hidden identities; raw session ids stay in worker memory. */
export function publicLiveReplayPlan(plan) {
  const value = {
    seed: plan.seed,
    repeat: plan.repeat,
    pilot: { allocation: plan.pilot.allocation.map(publicUnit) },
    blocks: plan.blocks.map(block => ({
      block: block.block,
      allocation: block.allocation.map(publicUnit),
    })),
    stopRule: plan.stopRule,
  }
  return deepFreeze({ ...value, sha256: sha256(canonicalJson(value)) })
}

/** Preregistered four-cell protocol-pilot decision rule. */
export function classifyProtocolPilot(records) {
  if (!Array.isArray(records) || records.length !== 4) throw new Error('protocol pilot requires exactly four records')
  const byId = Object.fromEntries(records.map(record => [record.treatment?.id, record]))
  if (REPLAY_VARIANTS.some(variant => byId[variant.id] === undefined)) throw new Error('protocol pilot is missing a treatment')
  const protocolSuccess = record => record.eligible === true && record.request2?.protocol?.success === true
  const httpStatus = record => record.request2?.response?.error?.status ?? record.request2?.request?.httpStatus ?? null
  const allProtocolSuccess = REPLAY_VARIANTS.every(variant => protocolSuccess(byId[variant.id]))
  const retainCellsSucceeded = ['retain-same', 'retain-new'].every(id => protocolSuccess(byId[id]))
  const dropHttp400Cells = ['drop-same', 'drop-new'].filter(id => httpStatus(byId[id]) === 400)
  const status = allProtocolSuccess
    ? 'passed'
    : retainCellsSucceeded && dropHttp400Cells.length > 0
      ? 'drop-protocol-rejected'
      : 'factorial-pilot-unidentifiable'
  return {
    status,
    allProtocolSuccess,
    retainCellsSucceeded,
    dropHttp400Cells,
    protocolSuccessByTreatment: Object.fromEntries(REPLAY_VARIANTS.map(variant => [variant.id, protocolSuccess(byId[variant.id])])),
    httpStatusByTreatment: Object.fromEntries(REPLAY_VARIANTS.map(variant => [variant.id, httpStatus(byId[variant.id])])),
    rule: 'drop rejection requires both retain cells protocol-successful and at least one drop cell HTTP 400',
  }
}

/** Summarize transport headers without exporting authentication or raw experiment identities. */
export function summarizeReplayHeaders(headers) {
  const normalized = Object.fromEntries(Object.entries(headers).map(([key, value]) => [key.toLowerCase(), String(value)]))
  const names = Object.keys(normalized).filter(name => name !== 'authorization').sort()
  const valuesSha256 = {}
  for (const name of names) {
    if (name === 'authorization' || name === 'x-deepseek-harness-user-id' || name === 'x-deepseek-harness-session-id') continue
    valuesSha256[name] = sha256(normalized[name])
  }
  return {
    names,
    userIdSha256: normalized['x-deepseek-harness-user-id'] === undefined
      ? null
      : sha256(normalized['x-deepseek-harness-user-id']),
    sessionIdSha256: normalized['x-deepseek-harness-session-id'] === undefined
      ? null
      : sha256(normalized['x-deepseek-harness-session-id']),
    valuesSha256,
  }
}

/** Remove raw bodies and raw header values from the existing strict proof report. */
export function publicConformanceProof(report, rawCaptures = []) {
  const rawById = Object.fromEntries(rawCaptures.map(capture => [capture.id, capture]))
  return {
    schemaVersion: report.schemaVersion,
    fixtureSha256: report.fixtureSha256,
    firstToolCallResponseSha256: report.firstToolCallResponseSha256,
    assistantMessageIndex: report.assistantMessageIndex,
    variants: report.variants.map(variant => ({
      id: variant.id,
      factors: variant.factors,
      bodySha256: variant.bodySha256,
      bodyBytes: variant.bodyBytes,
      headers: summarizeReplayHeaders(rawById[variant.id]?.headers ?? variant.headers),
    })),
    comparisons: report.comparisons,
    checks: report.checks,
  }
}
