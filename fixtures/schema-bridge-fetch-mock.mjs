import { appendFileSync } from 'node:fs'

const capturePath = process.env.DSH_WIRE_CAPTURE
const forbiddenMarker = process.env.DSH_WIRE_MARKER
const status = Number(process.env.DSH_WIRE_STATUS ?? '200')

if (capturePath !== undefined && forbiddenMarker !== undefined) {
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.url
    const headers = new Headers(init.headers ?? (typeof input === 'string' ? undefined : input.headers))
    const bodyText = typeof init.body === 'string' ? init.body : await new Response(init.body).text()
    appendFileSync(capturePath, `${JSON.stringify({
      url,
      method: init.method ?? 'GET',
      headerNames: [...headers.keys()].sort(),
      authorizationPresent: headers.has('authorization'),
      body: JSON.parse(bodyText),
    })}\n`, { mode: 0o600 })
    if (status !== 200) {
      return new Response(JSON.stringify({ error: { message: 'fixed retryable mock failure' } }), {
        status,
        headers: { 'content-type': 'application/json' },
      })
    }
    const events = [
      '{"choices":[{"delta":{"role":"assistant","content":null,"reasoning_content":""}}]}',
      '{"choices":[{"delta":{"reasoning_content":"Inspect repository safely."}}]}',
      JSON.stringify({ choices: [{ delta: { tool_calls: [{
        index: 0,
        id: 'call_schema_bridge_wire_mock',
        type: 'function',
        function: {
          name: 'bash',
          arguments: JSON.stringify({ command: `touch ${forbiddenMarker}`, description: 'Create forbidden dispatch marker' }),
        },
      }] } }] }),
      '{"choices":[{"delta":{"content":""},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":11,"completion_tokens":7,"reasoning_tokens":3}}',
      '[DONE]',
    ]
    return new Response(events.map(event => `data: ${event}\n\n`).join(''), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    })
  }
}
