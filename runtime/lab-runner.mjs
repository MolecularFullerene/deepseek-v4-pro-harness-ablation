/** Event-level one-shot driver mounted into a real DeepSeek Harness profile. */

import { createHash, randomUUID } from 'node:crypto'
import z from '@deepseek-ai/schemastery'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'dsh-lab-runner'
export const inject = ['agentDefaultModel', 'agents', 'sessions', 'agentPresets']

export const Config = z.object({
  mode: z.union(['run', 'mount']).default('run'),
  task: z.string().default(''),
  preset: z.string().required(),
  strategy: z.string().required(),
  cwd: z.string().default(process.cwd()),
  provider: z.string().required(),
  model: z.string().required(),
  reasoningEffort: z.string(),
  temperature: z.number(),
  maxTokens: z.number(),
  capture: z.union(['summary', 'trajectory', 'full']).default('trajectory'),
  stopAfterFirstAssistant: z.boolean().default(false),
})

export const internals = { stdout: process.stdout, stderr: process.stderr }
const PREFIX = 'DSH_LAB_RESULT '

function hash(value) {
  return createHash('sha256').update(value).digest('hex')
}

function scrub(text, cwd) {
  return String(text).split(cwd).join('{{workspace}}')
}

function capturedText(text, capture, cwd, retainTrajectory = false) {
  const clean = scrub(text, cwd)
  const summary = { sha256: hash(clean), chars: clean.length }
  return capture === 'full' || (capture === 'trajectory' && retainTrajectory)
    ? { ...summary, text: clean }
    : summary
}

function capturedJson(value, capture, cwd, retainTrajectory = false) {
  const text = scrub(typeof value === 'string' ? value : JSON.stringify(value), cwd)
  return capturedText(text, capture, cwd, retainTrajectory)
}

function blockSummary(block, capture, cwd, retainTrajectory) {
  if (block.type === 'text' || block.type === 'reasoning') {
    return { type: block.type, ...capturedText(block.text, capture, cwd, retainTrajectory) }
  }
  if (block.type === 'tool-call') {
    return {
      type: block.type,
      id: block.id,
      name: block.name,
      arguments: capturedJson(block.arguments, capture, cwd, retainTrajectory),
    }
  }
  return { type: block.type, value: capturedJson(block, capture, cwd, false) }
}

function requestSummary(event, capture, cwd) {
  const header = event.data.header
  const tools = (header.tools ?? []).map(tool => capture === 'full'
    ? tool
    : {
        name: tool.name,
        schemaSha256: hash(JSON.stringify(tool)),
        descriptionChars: tool.description.length,
      })
  return {
    seq: event.seq,
    time: event.time,
    reason: event.data.reason,
    config: header.config,
    adapterDefaults: header.adapterDefaults ?? null,
    system: header.system === undefined ? null : capturedText(header.system, capture, cwd, false),
    tools,
    toolNames: tools.map(tool => tool.name),
  }
}

function resultSummary(config, agent, firstSeq, startedAt) {
  const events = agent.session.events.filter(event => event.seq >= firstSeq)
  const requests = events.filter(event => event.type === 'request/header')
    .map(event => requestSummary(event, config.capture, config.cwd))
  const assistantMessages = events.filter(event => event.type === 'assistant/message').map(event => {
    const hasReasoning = event.data.message.content.some(block => block.type === 'reasoning' && block.text.length > 0)
    const hasToolCall = event.data.message.content.some(block => block.type === 'tool-call')
    return {
      seq: event.seq,
      time: event.time,
      turn: event.data.turn,
      step: event.data.step,
      usage: event.data.usage ?? null,
      // The official DeepSeek serializer replays reasoning_content only when
      // this assistant message also contains tool calls. Recording this fact
      // makes the in-context-CoT alternative explanation directly visible.
      reasoningPassbackEligible: hasReasoning && hasToolCall,
      blocks: event.data.message.content.map(block => blockSummary(block, config.capture, config.cwd, true)),
    }
  })
  const toolCalls = events.filter(event => event.type === 'tool/call').map(event => ({
    seq: event.seq,
    time: event.time,
    turn: event.data.turn,
    step: event.data.step,
    callId: event.data.callId,
    name: event.data.name,
    arguments: capturedJson(event.data.arguments, config.capture, config.cwd, config.capture !== 'summary'),
  }))
  const toolResults = events.filter(event => event.type === 'tool/result').map(event => ({
    seq: event.seq,
    time: event.time,
    turn: event.data.turn,
    step: event.data.step,
    callId: event.data.message.content.find(block => block.type === 'tool-result')?.toolCallId ?? null,
    error: event.data.error ?? null,
    blocks: event.data.message.content.map(block => blockSummary(block, config.capture, config.cwd, config.capture === 'full')),
  }))
  const userMessages = events.filter(event => event.type === 'user/message').map(event => ({
    seq: event.seq,
    time: event.time,
    source: event.data.source,
    content: config.capture === 'full'
      ? event.data.content.map(block => blockSummary(block, config.capture, config.cwd, true))
      : undefined,
  }))
  const turnEnds = events.filter(event => event.type === 'turn/end').map(event => ({
    seq: event.seq,
    time: event.time,
    turn: event.data.turn,
    reason: event.data.reason,
  }))
  return {
    schemaVersion: 1,
    mode: config.mode,
    strategy: config.strategy,
    preset: config.preset,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    sessionIdSha256: hash(String(agent.session.id)),
    startedAt,
    finishedAt: new Date().toISOString(),
    eventCount: events.length,
    requests,
    assistantMessages,
    toolCalls,
    toolResults,
    userMessages,
    turnEnds,
    promotion: {
      firstAssistantSeq: assistantMessages[0]?.seq ?? null,
      firstToolCallSeq: toolCalls[0]?.seq ?? null,
      firstChangedHeaderSeq: requests.find(request => request.reason === 'change')?.seq ?? null,
    },
  }
}

function emit(io, report, code) {
  io.stdout.write(`${PREFIX}${JSON.stringify(report)}\n`)
  io.exit(code)
}

async function run(ctx, config, io) {
  const startedAt = new Date().toISOString()
  await ctx.get('loader')?.await()
  const agents = ctx.get('agents')
  const sessions = ctx.get('sessions')
  const presets = ctx.get('agentPresets')
  if (agents === undefined || sessions === undefined || presets === undefined) {
    throw new Error('dsh-lab-runner: required services are not composed')
  }

  const selection = {
    provider: config.provider,
    model: config.model,
    ...(config.reasoningEffort === undefined ? {} : { reasoningEffort: config.reasoningEffort }),
    ...(config.temperature === undefined ? {} : { temperature: config.temperature }),
    ...(config.maxTokens === undefined ? {} : { maxTokens: config.maxTokens }),
  }
  const handle = await agents.create({
    sessionId: SessionId(`dsh-lab-${randomUUID()}`),
    meta: { cwd: config.cwd, agentPreset: config.preset },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async agentCtx => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      await presets.mount(agentCtx, config.preset)
    },
  })
  const { agent } = handle
  await agent.whenIdle()
  const firstSeq = agent.session.seq

  if (config.mode === 'mount') {
    const systemPrompt = ctx.get('systemPrompt')
    if (systemPrompt === undefined) throw new Error('dsh-lab-runner: systemPrompt service is not composed')
    const assembly = await systemPrompt.assemble({ scope: agent, agent })
    const tools = assembly.tools.map(tool => tool.name)
    const toolSchemas = assembly.tools.map(tool => config.capture === 'full'
      ? tool
      : {
          name: tool.name,
          schemaSha256: hash(JSON.stringify(tool)),
          descriptionChars: tool.description.length,
        })
    emit(io, {
      schemaVersion: 1,
      mode: 'mount',
      strategy: config.strategy,
      preset: config.preset,
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      sessionIdSha256: hash(String(agent.session.id)),
      startedAt,
      finishedAt: new Date().toISOString(),
      mountTools: tools,
      mountToolSchemas: toolSchemas,
      mountSystem: capturedText(
        assembly.sections.map(section => section.text).join('\n\n'),
        config.capture,
        config.cwd,
        false,
      ),
    }, 0)
    return
  }
  if (config.task.trim() === '') throw new Error('dsh-lab-runner: task is empty')

  // Cancellation is attached to the synchronous session publication point.
  // The agent loop appends assistant/message before it dispatches tool calls;
  // cancelling here makes executeToolCalls emit skipped results without ever
  // entering a tool executor. A polling timer has a write-capable race window.
  let stopTriggered = false
  const stopListener = config.stopAfterFirstAssistant
    ? ctx.on('session/event', (session, event) => {
        if (session !== agent.session || stopTriggered || event.seq < firstSeq) return
        if (event.type !== 'assistant/message') return
        stopTriggered = true
        agent.cancel({ kind: 'user' })
      })
    : undefined
  try {
    agent.followup(createUserMessage({
      content: [{ type: 'text', text: config.task }],
      source: { kind: 'user' },
    }))
    await agent.whenIdle()
  } finally {
    stopListener?.()
  }
  await sessions.flush(agent.session)
  const report = resultSummary(config, agent, firstSeq, startedAt)
  const completed = report.turnEnds.at(-1)?.reason?.kind === 'completed'
  const stoppedAfterAssistant = config.stopAfterFirstAssistant && report.assistantMessages.length > 0
  emit(io, report, completed || stoppedAfterAssistant ? 0 : 1)
}

export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error('dsh-lab-runner: launcher must provide appExit')
  const io = { stdout: internals.stdout, stderr: internals.stderr, exit }
  void run(ctx, config, io).catch(error => {
    io.stderr.write(`dsh-lab-runner: ${error instanceof Error ? error.message : String(error)}\n`)
    io.exit(1)
  })
}
