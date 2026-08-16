/** Guarded transport replay: real official adapter, no Agent/Session lifecycle fork. */
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'
import { analyzeReplayCaptures, buildReplayMatrix, diffJson, REPLAY_VARIANTS } from '../src/request2-replay.mjs'
import {
  classifyProtocolPilot, publicConformanceProof, publicLiveReplayPlan, reasoningDiagnostics, scoreExpectedJson,
  summarizeReplayHeaders, validateLiveReplayFixture,
} from '../src/request2-live-replay.mjs'
import { canonicalJson, redactText, redactValue, sha256 } from '../src/core.mjs'

async function readStdin() {
  const chunks = []
  let bytes = 0
  for await (const chunk of process.stdin) {
    bytes += chunk.length
    if (bytes > 8 * 1024 * 1024) throw new Error('worker protocol exceeds 8 MiB')
    chunks.push(chunk)
  }
  return Buffer.concat(chunks).toString('utf8')
}

function nonEmpty(value, path) {
  if (typeof value !== 'string' || value.length === 0) throw new Error(`${path} must be a non-empty string`)
}

function validatePlan(plan) {
  if (plan === null || typeof plan !== 'object' || Array.isArray(plan)) throw new Error('plan must be an object')
  nonEmpty(plan.seed, 'plan.seed')
  if (!Number.isInteger(plan.repeat) || plan.repeat < 1 || plan.repeat > 100) throw new Error('plan.repeat is invalid')
  if (!Array.isArray(plan.blocks) || plan.blocks.length !== plan.repeat) throw new Error('plan block count does not match repeat')
  const known = new Set(REPLAY_VARIANTS.map(item => item.id))
  const sessions = new Set()
  const checkUnit = (unit, path) => {
    nonEmpty(unit?.unitId, `${path}.unitId`)
    nonEmpty(unit?.sourceSessionId, `${path}.sourceSessionId`)
    nonEmpty(unit?.newSessionId, `${path}.newSessionId`)
    if (unit.sourceSessionId === unit.newSessionId) throw new Error(`${path} session ids must differ`)
    if (!known.has(unit?.treatment?.id)) throw new Error(`${path}.treatment is unknown`)
    const expected = REPLAY_VARIANTS.find(item => item.id === unit.treatment.id)
    if (expected.reasoning !== unit.treatment.reasoning || expected.session !== unit.treatment.session) {
      throw new Error(`${path}.treatment factors do not match its id`)
    }
    for (const value of [unit.sourceSessionId, unit.newSessionId]) {
      if (sessions.has(value)) throw new Error('plan reuses a session id across source units')
      sessions.add(value)
    }
  }
  if (!Array.isArray(plan.pilot?.allocation) || plan.pilot.allocation.length !== 4) {
    throw new Error('plan.pilot must allocate four independent source units')
  }
  if (new Set(plan.pilot.allocation.map(unit => unit.treatment?.id)).size !== 4) {
    throw new Error('plan.pilot must allocate every treatment once')
  }
  plan.pilot.allocation.forEach((unit, index) => checkUnit(unit, `plan.pilot.allocation[${index}]`))
  for (let index = 0; index < plan.blocks.length; index += 1) {
    const block = plan.blocks[index]
    if (!Array.isArray(block?.allocation) || block.allocation.length !== 4) throw new Error(`plan.blocks[${index}] must have four units`)
    if (new Set(block.allocation.map(unit => unit.treatment?.id)).size !== 4) {
      throw new Error(`plan.blocks[${index}] must allocate every treatment once`)
    }
    block.allocation.forEach((unit, unitIndex) => checkUnit(unit, `plan.blocks[${index}].allocation[${unitIndex}]`))
  }
  return plan
}

function sse(events) {
  const values = [...events]
  if (values.at(-1) !== '[DONE]') values.push('[DONE]')
  return values.map(event => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`).join('')
}

function mockSelection(script, active) {
  const selected = active.kind === 'request1'
    ? script?.request1
    : active.pilot
      ? script?.request2?.pilot?.[active.treatmentId]
        ?? script?.request2?.pilot?.default
        ?? script?.request2?.default
      : script?.request2?.[active.treatmentId] ?? script?.request2?.default
  if (selected === undefined) throw new Error(`mock script has no response for ${active.kind}${active.treatmentId === undefined ? '' : `/${active.treatmentId}`}`)
  if (selected.status !== undefined && (!Number.isInteger(selected.status) || selected.status < 100 || selected.status > 599)) {
    throw new Error('mock response status is invalid')
  }
  const status = selected.status ?? 200
  if (status < 200 || status >= 300) {
    return new Response(JSON.stringify(selected.json ?? { error: { message: `mock HTTP ${status}` } }), {
      status,
      headers: { 'content-type': 'application/json', 'x-request-id': `mock-${active.unitId}` },
    })
  }
  if (!Array.isArray(selected.events)) throw new Error('successful mock response requires an events array')
  return new Response(sse(selected.events), {
    status,
    headers: { 'content-type': 'text/event-stream', 'x-request-id': `mock-${active.unitId}` },
  })
}

function errorSummary(error) {
  const failure = error?.failure
  const message = typeof failure?.message === 'string'
    ? failure.message
    : error instanceof Error ? error.message : String(error)
  return {
    name: error instanceof Error ? error.name : 'Error',
    message,
    ...(typeof failure?.code === 'string' ? { code: failure.code } : typeof error?.code === 'string' ? { code: error.code } : {}),
    ...(Number.isInteger(failure?.status) ? { status: failure.status } : {}),
    ...(typeof failure?.providerRetryAfterMs === 'number' ? { providerRetryAfterMs: failure.providerRetryAfterMs } : {}),
    ...(typeof failure?.requestId === 'string' ? { requestIdSha256: sha256(failure.requestId) } : {}),
  }
}

function failureSummary(failure) {
  return {
    message: failure.message,
    code: failure.code,
    ...(failure.status === undefined ? {} : { status: failure.status }),
    ...(failure.providerRetryAfterMs === undefined ? {} : { providerRetryAfterMs: failure.providerRetryAfterMs }),
    ...(failure.requestId === undefined ? {} : { requestIdSha256: sha256(failure.requestId) }),
  }
}

function responseSummary(assembler, thrown) {
  let blocks = []
  try {
    blocks = assembler.blocks()
  } catch (error) {
    if (thrown === undefined) thrown = error
  }
  const finish = thrown === undefined ? assembler.finish : null
  return {
    reasoning: blocks.filter(block => block.type === 'reasoning').map(block => block.text).join(''),
    text: blocks.filter(block => block.type === 'text').map(block => block.text).join(''),
    toolCalls: blocks.filter(block => block.type === 'tool-call').map(block => ({
      id: block.id,
      name: block.name,
      arguments: block.arguments,
    })),
    usage: assembler.usage ?? null,
    finish,
    error: thrown === undefined
      ? finish?.kind === 'error' || finish?.kind === 'aborted' ? failureSummary(finish.failure) : null
      : errorSummary(thrown),
  }
}

function protocolOutcome(request, response) {
  const success = request.httpStatus !== null
    && request.httpStatus >= 200
    && request.httpStatus < 300
    && response.error === null
    && response.finish !== null
    && response.finish.kind !== 'error'
    && response.finish.kind !== 'aborted'
  return {
    success,
    httpStatus: request.httpStatus,
    finishKind: response.finish?.kind ?? null,
    errorCode: response.error?.code ?? null,
  }
}

function requestSummary(capture) {
  return {
    bodySha256: sha256(capture.rawBody),
    bodyBytes: Buffer.byteLength(capture.rawBody),
    headers: summarizeReplayHeaders(capture.headers),
    httpStatus: capture.responseStatus ?? null,
    dispatched: capture.forwarded === true,
    exactPreflightMatch: capture.exactPreflightMatch ?? null,
    identityHeadersMatch: capture.identityHeadersMatch ?? null,
  }
}

function toolResultPairing(rawBody) {
  const body = JSON.parse(rawBody)
  let assistantIndex = -1
  for (let index = body.messages.length - 1; index >= 0; index -= 1) {
    if (body.messages[index]?.role === 'assistant' && Array.isArray(body.messages[index].tool_calls)) {
      assistantIndex = index
      break
    }
  }
  if (assistantIndex < 0) return { passed: false, toolCallIds: [], toolResultIds: [] }
  const toolCallIds = body.messages[assistantIndex].tool_calls.map(call => call.id)
  const toolResultIds = body.messages.slice(assistantIndex + 1)
    .filter(message => message?.role === 'tool')
    .map(message => message.tool_call_id)
  return {
    passed: toolCallIds.length > 0
      && toolCallIds.length === toolResultIds.length
      && toolCallIds.every((id, index) => id === toolResultIds[index]),
    toolCallIds,
    toolResultIds,
  }
}

function assertActualCapture(expected, actual) {
  const bodyEqual = expected.rawBody === actual.rawBody
  const urlEqual = expected.url === actual.url
  const headerDiffPaths = diffJson(expected.headers, actual.headers).map(item => item.path)
  const pairing = toolResultPairing(actual.rawBody)
  if (!bodyEqual || !urlEqual || headerDiffPaths.length > 0 || !pairing.passed) {
    throw new Error(`request2 actual/preflight mismatch: ${JSON.stringify({ bodyEqual, urlEqual, headerDiffPaths, pairingPassed: pairing.passed })}`)
  }
  return pairing
}

async function main() {
  const harnessRoot = resolve(process.argv[2] ?? '')
  const adapterUrl = pathToFileURL(resolve(harnessRoot, 'packages/llm/llm-deepseek/lib/index.js')).href
  const llmUrl = pathToFileURL(resolve(harnessRoot, 'packages/llm/llm/lib/index.js')).href
  const [{ DeepSeekAdapter, resolveAdapterOptions }, { BlockAssembler, createToolResultMessage }] = await Promise.all([
    import(adapterUrl),
    import(llmUrl),
  ])
  const protocol = JSON.parse(await readStdin())
  knownSecret = typeof protocol.apiKey === 'string' ? protocol.apiKey : ''
  if (protocol.protocolVersion !== 1) throw new Error('unsupported worker protocol')
  nonEmpty(protocol.apiKey, 'apiKey')
  nonEmpty(protocol.baseUrl, 'baseUrl')
  nonEmpty(protocol.provider, 'provider')
  nonEmpty(protocol.model, 'model')
  const fixture = validateLiveReplayFixture(protocol.fixture)
  const plan = validatePlan(protocol.plan)
  if ((protocol.mockScript !== undefined) === (protocol.allowNetwork === true)) {
    throw new Error('worker requires exactly one of mockScript or allowNetwork')
  }

  const connection = resolveAdapterOptions({
    baseURL: protocol.baseUrl,
    thinking: 'enabled',
    reasoningEffort: protocol.reasoningEffort,
    ...(protocol.maxTokens === undefined ? {} : { maxTokens: protocol.maxTokens }),
  })
  const adapter = new DeepSeekAdapter({
    options: () => connection,
    resolveApiKey: () => Promise.resolve(protocol.apiKey),
    resolveUserId: () => fixture.anonymousUserId,
  })

  let active
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    if (active === undefined) throw new Error('adapter fetch occurred outside an assigned replay phase')
    const capture = {
      id: active.variantId ?? active.kind,
      url: String(url),
      rawBody: String(init.body),
      headers: Object.fromEntries(new Headers(init.headers).entries()),
      forwarded: false,
    }
    active.capture = capture
    if (active.phase === 'preflight') {
      active.captures.push(capture)
      const response = new Response(sse([
        { choices: [{ delta: { content: 'serializer preflight only' }, finish_reason: 'stop' }], usage: { prompt_tokens: 1, completion_tokens: 1 } },
      ]), { status: 200, headers: { 'content-type': 'text/event-stream' } })
      capture.responseStatus = response.status
      return response
    }
    if (active.kind === 'request1') {
      const sessionMatches = capture.headers['x-deepseek-harness-session-id'] === active.expectedSessionId
      const userMatches = capture.headers['x-deepseek-harness-user-id'] === fixture.anonymousUserId
      if (!sessionMatches || !userMatches) {
        const error = new Error(`request1 identity-header mismatch: ${JSON.stringify({ sessionMatches, userMatches })}`)
        active.conformanceViolation = error
        capture.identityHeadersMatch = false
        throw error
      }
      capture.identityHeadersMatch = true
    }
    if (active.kind === 'request2') {
      try {
        active.pairing = assertActualCapture(active.expected, capture)
        capture.exactPreflightMatch = true
      } catch (error) {
        active.conformanceViolation = error
        capture.exactPreflightMatch = false
        throw error
      }
    }
    capture.forwarded = true
    const response = protocol.mockScript === undefined
      ? await originalFetch(url, init)
      : mockSelection(protocol.mockScript, active)
    capture.responseStatus = response.status
    return response
  }

  const stream = async options => {
    const assembler = new BlockAssembler()
    let thrown
    try {
      for await (const chunk of adapter.stream(options)) assembler.push(chunk)
    } catch (error) {
      thrown = error
    }
    let message
    if (thrown === undefined) {
      try {
        message = assembler.message({ kind: 'model', provider: protocol.provider, model: protocol.model })
      } catch (error) {
        thrown = error
      }
    }
    return { assembler, message, summary: responseSummary(assembler, thrown), thrown }
  }

  const initialOptions = sessionId => ({
    provider: protocol.provider,
    model: protocol.model,
    messages: structuredClone(fixture.messages),
    ...(fixture.system === undefined ? {} : { system: fixture.system }),
    tools: structuredClone(fixture.tools),
    reasoningEffort: protocol.reasoningEffort,
    ...(protocol.temperature === undefined ? {} : { temperature: protocol.temperature }),
    ...(protocol.maxTokens === undefined ? {} : { maxTokens: protocol.maxTokens }),
    ...(fixture.stop === undefined ? {} : { stop: structuredClone(fixture.stop) }),
    sessionId,
  })

  const runSource = async (unit, pilot = false) => {
    active = {
      phase: 'actual', kind: 'request1', unitId: unit.unitId, pilot,
      expectedSessionId: unit.sourceSessionId,
    }
    const first = await stream(initialOptions(unit.sourceSessionId))
    if (active.conformanceViolation !== undefined) throw active.conformanceViolation
    const firstCapture = active.capture
    if (firstCapture === undefined) throw new Error('request1 adapter did not reach fetch')
    const record = {
      unitId: unit.unitId,
      ...(unit.block === undefined ? {} : { block: unit.block, position: unit.position }),
      treatment: { ...unit.treatment },
      sourceSessionIdSha256: sha256(unit.sourceSessionId),
      request2SessionIdSha256: sha256(unit.treatment.session === 'same' ? unit.sourceSessionId : unit.newSessionId),
      request1: {
        request: requestSummary(firstCapture),
        response: { ...first.summary, reasoningDiagnostic: reasoningDiagnostics(first.summary.reasoning) },
      },
      eligible: false,
    }
    if (first.summary.error !== null || first.message === undefined) {
      record.sourceError = { code: 'REQUEST1_FAILED', message: 'request1 did not produce an assemblable assistant response' }
      return record
    }
    const reasoning = first.message.content.filter(block => block.type === 'reasoning' && block.text.length > 0)
    const calls = first.message.content.filter(block => block.type === 'tool-call')
    if (reasoning.length === 0 || calls.length === 0 || first.summary.finish?.kind !== 'tool-calls') {
      record.sourceError = {
        code: 'REQUEST1_NOT_REASONING_TOOL_CALL',
        message: 'request1 must finish with both non-empty reasoning and at least one tool call',
      }
      return record
    }

    const toolMessages = []
    const fixtureUses = []
    for (const call of calls) {
      const fixed = fixture.toolResultFixtures[call.name]
      if (fixed === undefined) {
        record.sourceError = { code: 'NO_SAFE_TOOL_FIXTURE', message: `no fixed fixture for requested tool ${JSON.stringify(call.name)}` }
        return record
      }
      // Arguments are deliberately never parsed or executed. Only a fixed result is paired by call id.
      toolMessages.push(createToolResultMessage({
        callId: call.id,
        content: [{ type: 'text', text: fixed.text }],
        isError: fixed.isError ?? false,
      }))
      fixtureUses.push({
        callId: call.id,
        toolName: call.name,
        resultSha256: sha256(fixed.text),
        resultChars: fixed.text.length,
        isError: fixed.isError ?? false,
      })
    }

    const matrix = buildReplayMatrix({
      provider: protocol.provider,
      model: protocol.model,
      anonymousUserId: fixture.anonymousUserId,
      originalSessionId: unit.sourceSessionId,
      newSessionId: unit.newSessionId,
      messages: [...structuredClone(fixture.messages), first.message, ...toolMessages],
      ...(fixture.system === undefined ? {} : { system: fixture.system }),
      tools: structuredClone(fixture.tools),
      reasoningEffort: protocol.reasoningEffort,
      ...(protocol.temperature === undefined ? {} : { temperature: protocol.temperature }),
      ...(protocol.maxTokens === undefined ? {} : { maxTokens: protocol.maxTokens }),
      ...(fixture.stop === undefined ? {} : { stop: structuredClone(fixture.stop) }),
    })
    const captures = []
    for (const variant of matrix.variants) {
      active = {
        phase: 'preflight', kind: 'request2', unitId: unit.unitId, pilot,
        variantId: variant.id, treatmentId: variant.id, captures,
      }
      const check = await stream(variant.options)
      if (check.thrown !== undefined) throw new Error(`serializer preflight failed for ${variant.id}: ${check.summary.error?.message ?? 'unknown error'}`)
    }
    const rawProof = analyzeReplayCaptures(matrix, captures)
    const pairing = captures.map(capture => ({ id: capture.id, ...toolResultPairing(capture.rawBody) }))
    if (!pairing.every(item => item.passed)) throw new Error('tool result call-id pairing failed before request2 transport')
    const variant = matrix.variants.find(item => item.id === unit.treatment.id)
    const expected = captures.find(item => item.id === unit.treatment.id)
    if (variant === undefined || expected === undefined) throw new Error('assigned treatment is absent from replay matrix')

    active = {
      phase: 'actual', kind: 'request2', unitId: unit.unitId, pilot,
      treatmentId: unit.treatment.id, expected,
    }
    const second = await stream(variant.options)
    if (active.conformanceViolation !== undefined) throw active.conformanceViolation
    const secondCapture = active.capture
    if (secondCapture === undefined) throw new Error('request2 adapter did not reach fetch')
    record.eligible = true
    record.fixedToolResults = fixtureUses
    record.conformance = {
      ...publicConformanceProof(rawProof, captures),
      toolResultPairing: pairing.map(item => ({
        id: item.id,
        passed: item.passed,
        toolCallIdSha256: item.toolCallIds.map(sha256),
        toolResultIdSha256: item.toolResultIds.map(sha256),
      })),
    }
    const secondRequest = requestSummary(secondCapture)
    const secondProtocol = protocolOutcome(secondRequest, second.summary)
    record.request2 = {
      request: secondRequest,
      response: { ...second.summary, reasoningDiagnostic: reasoningDiagnostics(second.summary.reasoning) },
      protocol: secondProtocol,
      score: scoreExpectedJson(second.summary.text, fixture.expectedJson, secondProtocol.success),
      toolResultPairing: {
        passed: active.pairing.passed,
        toolCallIdSha256: active.pairing.toolCallIds.map(sha256),
        toolResultIdSha256: active.pairing.toolResultIds.map(sha256),
      },
    }
    return record
  }

  let report
  try {
    const pilotUnits = []
    for (const unit of plan.pilot.allocation) pilotUnits.push(await runSource(unit, true))
    const pilotOutcome = classifyProtocolPilot(pilotUnits)
    const pilot = { units: pilotUnits, outcome: pilotOutcome }
    if (pilotOutcome.status !== 'passed') {
      report = {
        status: pilotOutcome.status,
        planSha256: publicLiveReplayPlan(plan).sha256,
        pilot,
        samples: [],
        completedSamples: 0,
        stopReason: pilotOutcome.status === 'drop-protocol-rejected'
          ? 'Both retain pilot cells succeeded and at least one drop pilot cell received HTTP 400; drop passback removal is not accepted by this protocol. No main sample was sent.'
          : 'The four-cell protocol pilot did not satisfy the preregistered identification rule; the factorial is unidentifiable and no main sample was sent.',
      }
    } else if (protocol.pilotOnly === true) {
      report = {
        status: 'pilot-passed',
        planSha256: publicLiveReplayPlan(plan).sha256,
        pilot,
        samples: [],
        completedSamples: 0,
        stopReason: '--pilot-only requested; all four protocol cells passed and no main sample was sent.',
      }
    } else {
      const samples = []
      for (const block of plan.blocks) {
        for (const unit of block.allocation) samples.push(await runSource(unit, false))
      }
      report = {
        status: 'completed',
        planSha256: publicLiveReplayPlan(plan).sha256,
        pilot,
        samples,
        completedSamples: samples.filter(sample => sample.eligible && sample.request2 !== undefined).length,
        ineligibleSources: samples.filter(sample => !sample.eligible).length,
        responseErrors: samples.filter(sample => sample.request2 !== undefined && sample.request2.response.error !== null).length,
        protocolSuccesses: samples.filter(sample => sample.request2?.protocol?.success === true).length,
        answerCorrect: samples.filter(sample => sample.request2?.score?.answerCorrect === true).length,
      }
    }
  } finally {
    globalThis.fetch = originalFetch
  }
  const identitySecrets = [
    protocol.apiKey,
    fixture.anonymousUserId,
    ...plan.pilot.allocation.flatMap(unit => [unit.sourceSessionId, unit.newSessionId]),
    ...plan.blocks.flatMap(block => block.allocation.flatMap(unit => [unit.sourceSessionId, unit.newSessionId])),
  ]
  const safe = redactValue({
    ...report,
    transportFacts: {
      baseUrl: protocol.baseUrl,
      provider: protocol.provider,
      model: protocol.model,
      mode: protocol.mockScript === undefined ? 'explicit-network' : 'in-process-mock',
      apiKeySource: 'worker stdin protocol only',
      toolExecution: 'none; fixed fixture results only',
    },
    design: {
      kind: 'blocked randomized independent-source experiment',
      repeat: plan.repeat,
      order: plan.blocks.map(block => block.allocation.map(unit => unit.treatment.id)),
      mainRequestsPerSource: 2,
      liveTreatmentsPerSource: 1,
      offlinePreflightTreatmentsPerSource: 4,
    },
    limitation: 'Transport-level DeepSeekAdapter replay, not a full Agent/Session fork. Each live treatment has an independent request1 source session to avoid stateful branch-order contamination.',
  }, identitySecrets)
  // Defensive last gate: no credential or raw session identity may reach stdout.
  const serialized = canonicalJson(safe)
  for (const secret of identitySecrets) {
    if (secret.length > 0 && serialized.includes(secret)) throw new Error('redaction invariant failed before report export')
  }
  process.stdout.write(JSON.stringify(safe) + '\n')
}

let knownSecret = ''
try {
  // The only input channel is stdin; this worker never reads environment or credential files.
  await main()
} catch (error) {
  const message = redactText(error instanceof Error ? error.stack ?? error.message : String(error), [knownSecret])
  process.stderr.write(`request2-live-replay-worker: ${message}\n`)
  process.exitCode = 1
} finally {
  knownSecret = ''
}
