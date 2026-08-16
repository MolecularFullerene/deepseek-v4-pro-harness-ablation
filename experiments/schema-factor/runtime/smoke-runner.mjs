/** Real-DSH assembly probe for one schema-factor preset. */
import { createHash, randomUUID } from 'node:crypto'
import { installModelSelection } from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'

export const name = 'schema-factor-smoke-runner'
export const inject = ['agents', 'agentPresets', 'systemPrompt']

const PREFIX = 'DSH_SCHEMA_FACTOR_RESULT '
const MINIMAL_SYSTEM = 'You are a helpful software engineer assistant.'

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function toolFact(tool) {
  const parameters = canonical(tool.parameters)
  const schema = canonical({ name: tool.name, description: tool.description, parameters: tool.parameters })
  return {
    name: tool.name,
    schemaSha256: sha256(schema),
    schemaChars: schema.length,
    descriptionSha256: sha256(tool.description),
    descriptionChars: tool.description.length,
    parametersSha256: sha256(parameters),
    parametersChars: parameters.length,
  }
}

async function run(ctx, config, exit) {
  await ctx.get('loader')?.await()
  const expectedTools = config.expectedTools
  const selection = { provider: 'deepseek-official', model: 'deepseek-v4-pro', reasoningEffort: 'max' }
  const { agent } = await ctx.agents.create({
    sessionId: SessionId(`schema-factor-${randomUUID()}`),
    meta: { cwd: config.cwd, agentPreset: config.preset },
    agentOptions: { provider: selection.provider, model: selection.model },
    setup: async (agentCtx) => {
      installModelSelection(agentCtx, { current: selection, assembled: undefined })
      await ctx.agentPresets.mount(agentCtx, config.preset)
    },
  })
  await agent.whenIdle()
  const assembly = await ctx.systemPrompt.assemble({ scope: agent, agent })
  const system = assembly.sections.map(section => section.text).join('\n\n')
  const actualTools = assembly.tools.map(tool => tool.name)
  const report = {
    schemaVersion: 1,
    preset: config.preset,
    factors: { shellSchema: config.shellSchema, fileSchema: config.fileSchema },
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    sessionIdSha256: sha256(String(agent.session.id)),
    firstRequest: {
      system: { sha256: sha256(system), chars: system.length, text: system },
      contextsCount: assembly.contexts.length,
      toolCount: assembly.tools.length,
      toolNames: actualTools,
      tools: assembly.tools.map(toolFact),
    },
    checks: {
      exactMinimalSystem: system === MINIMAL_SYSTEM,
      noContexts: assembly.contexts.length === 0,
      exactlyTwoTools: assembly.tools.length === 2,
      expectedToolNames: JSON.stringify(actualTools) === JSON.stringify(expectedTools),
    },
  }
  const passed = Object.values(report.checks).every(Boolean)
  process.stdout.write(`${PREFIX}${JSON.stringify(report)}\n`)
  exit(passed ? 0 : 1)
}

export function apply(ctx, config) {
  const exit = ctx.get('appExit')
  if (exit === undefined) throw new Error(`${name}: launcher did not provide appExit`)
  void run(ctx, config, exit).catch((error) => {
    process.stderr.write(`${name}: ${error instanceof Error ? error.message : String(error)}\n`)
    exit(1)
  })
}
