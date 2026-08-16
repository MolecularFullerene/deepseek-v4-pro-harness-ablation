/** First-request schema lock shared by the 2x2 factor presets. */
export const name = 'schema-factor-first-request-lock'
export const inject = ['systemPrompt']

function names(value) {
  if (!Array.isArray(value) || value.length !== 2 || value.some(item => typeof item !== 'string')) {
    throw new TypeError(`${name}: expectedTools must contain exactly two names`)
  }
  return value
}

export function apply(ctx, config) {
  const expected = names(config.expectedTools)
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined || agent.session.events.some(event => event.type === 'tool/call')) return assembled
    const byName = new Map(assembled.tools.map(tool => [tool.name, tool]))
    const missing = expected.filter(toolName => !byName.has(toolName))
    if (missing.length > 0) throw new Error(`${name}: missing first-request schemas ${JSON.stringify(missing)}`)
    return {
      ...assembled,
      contexts: [],
      tools: expected.map(toolName => byName.get(toolName)),
    }
  })
}
