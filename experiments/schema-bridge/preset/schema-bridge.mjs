/**
 * Diagnostic-only first-request schema bridge.
 *
 * The registered executor is always the official persistent bash tool. Only
 * its model-visible description and parameter schema are crossed. Every tool
 * execution is denied because O parameters contain controls that the
 * persistent executor would otherwise accept as unknown fields and ignore.
 */
import { createHash } from 'node:crypto'

export const name = 'schema-bridge-diagnostic'
export const inject = ['systemPrompt', 'tools']

const SYSTEM_RAW = '5fab6e32f283d71510531ce850df2690b8fb77437d36bfabbe8c4ac862f19df9'
const PERSISTENT_CANONICAL = 'b44ee1237054e485b671275dd49cda93c9a85a113be6c7be3ea3af4913f91c24'
const PERSISTENT_RAW = 'fd7afc1cf7fcddd6569f0382dfd9b1a06c0b2b1e2302bd37a3927bee6959b1b1'
const EDITOR_CANONICAL = '5120c75cebb979bfcc139e3c5739bd79112674978dc121434138161075172d7d'
const EDITOR_RAW = '0948b7082aad2c337f314df4c3e62a779d9a0fdd03f04f07811d7c13e2f2ef3b'

const ONE_SHOT_DESCRIPTION = [
  'Execute a bash command (`bash -c`) and return its stdout/stderr. ',
  'Each call runs in a fresh shell: no state (cwd, variables, functions) persists between calls — ',
  'pass `workdir` instead of using `cd`. Non-zero exits are reported as `[exit code: N]`. ',
  'Current harness environment facts are exposed through managed `$DSH_*` variables; inspect them when needed. ',
  'Commands may run under a file sandbox; a blocked file operation is reported as `[sandbox: file access denied under <mode> mode]` — a policy denial, not a bug in the command; do not retry another way. ',
  'Long output is truncated to its tail; the full output is saved to a file whose path is reported when available. ',
  'Set `run_in_background: true` for long-running commands: the call returns a job id immediately; read its output with `job_output` and stop it with `job_kill`.',
  ' Attempting a command the sandbox may deny is safe and expected: run it and read the marker rather than assuming the denial. When a command is denied and a wider mode would let it ',
  'succeed, escalate immediately in the same turn — the one sanctioned exception to a denial: retry the exact same command once with `sandbox_permissions` (the narrowest wider mode that suffices) ',
  'plus a one-sentence `justification`. Do not detour through chat to ask permission first — the approval prompt raised by that retry is how the user consents. If the session states approval ',
  'prompts are disabled, there is no exception: a denial is final — do not set `sandbox_permissions`. Never escalate speculatively: ground the request in a real denial — normally the one this command ',
  'just hit; escalating up front is fine only when this session already denied the same access. A rejected escalation is final for that command — stop and explain, never work around ',
  'it — but it does not forbid attempting or escalating other commands later.',
].join('')

const ONE_SHOT_PARAMETERS = {
  type: 'object',
  properties: {
    command: { type: 'string', description: 'The bash command to execute.' },
    description: {
      type: 'string',
      description: 'Clear, concise description of what this command does in active voice, 5-10 words (shown in the UI). Examples: "ls" → "List files in current directory"; "git status" → "Show working tree status"; "npm install" → "Install package dependencies".',
    },
    timeoutMs: {
      type: 'number',
      description: 'Timeout in milliseconds. The executor applies its configured default and cap, and kills the command on expiry.',
    },
    workdir: {
      type: 'string',
      description: 'Working directory for this command. Defaults to the session workspace; a relative path is resolved against it.',
    },
    run_in_background: {
      type: 'boolean',
      description: 'Run in the background and return a job id immediately (collect with job_output, stop with job_kill). No timeout applies.',
    },
    sandbox_permissions: {
      type: 'string',
      description: 'The wider sandbox mode this command needs. Only valid as a one-shot retry of a command the sandbox just denied; requires justification and user approval.',
      enum: ['workspace-write', 'danger-full-access'],
    },
    justification: {
      type: 'string',
      description: 'Required with sandbox_permissions: one sentence for the user explaining why this exact command needs the wider access.',
    },
  },
  required: ['command', 'description'],
}

const ARMS = Object.freeze({
  pp: Object.freeze({ description: 'persistent', parameters: 'persistent', canonical: PERSISTENT_CANONICAL, raw: PERSISTENT_RAW, chars: 849 }),
  po: Object.freeze({ description: 'persistent', parameters: 'one-shot', canonical: 'bdabadf8d3a97d145acbd9381b92dea30d3cadfb0f6433662f35718daca7519a', raw: 'b22421b472b4209f14a70aacccfc54bfc4f865a0f50fdabb250de8a1140566b2', chars: 2042 }),
  op: Object.freeze({ description: 'one-shot', parameters: 'persistent', canonical: '9ad7dc6844bda07561e546cf0d02c1c37f08577f40f40cbe01d5964a4cb84075', raw: 'fd23fda05ece071a86dfeded9de0ad09df71ff8796fbe2b3e11b36d29ccb12b3', chars: 2049 }),
  oo: Object.freeze({ description: 'one-shot', parameters: 'one-shot', canonical: 'd80d15e24dbba48476b37cebc13fff6225e805c7f0f183762ad83a609095c937', raw: 'ce6ad0324e0e05d863eae734cde4a77ade47574b4c31ed4d2665c89c711ec9e9', chars: 3242 }),
})

export const SCHEMA_BRIDGE_SURFACE = Object.freeze({
  systemRawSha256: SYSTEM_RAW,
  orderedToolNames: Object.freeze(['bash', 'str_replace_editor']),
  editorRawSha256: EDITOR_RAW,
  armRawSha256: Object.freeze(Object.fromEntries(
    Object.entries(ARMS).map(([id, arm]) => [id, arm.raw]),
  )),
})

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

function fact(tool) {
  const raw = JSON.stringify(tool)
  return { canonical: sha256(canonical(tool)), raw: sha256(raw), chars: raw.length }
}

function assertFact(label, actual, expected) {
  for (const key of ['canonical', 'raw']) {
    if (actual[key] !== expected[key]) {
      throw new Error(`${name}: ${label} ${key} hash drifted: ${actual[key]} != ${expected[key]}`)
    }
  }
  if (expected.chars !== undefined && actual.chars !== expected.chars) {
    throw new Error(`${name}: ${label} raw chars drifted: ${actual.chars} != ${expected.chars}`)
  }
}

function selectedArm(value) {
  if (typeof value !== 'string' || !Object.hasOwn(ARMS, value)) {
    throw new Error(`${name}: arm must be one of ${Object.keys(ARMS).join(', ')}`)
  }
  return value
}

export function apply(ctx, config) {
  const armId = selectedArm(config.arm)
  const arm = ARMS[armId]
  let streamCount = 0
  const oneShot = { name: 'bash', description: ONE_SHOT_DESCRIPTION, parameters: ONE_SHOT_PARAMETERS }
  assertFact('frozen one-shot fixture', fact(oneShot), ARMS.oo)

  // A monotonic guard is evaluated after every extensible pre-execute hook;
  // another listener cannot turn this diagnostic-only denial back into allow.
  ctx.tools.guard(() => 'schema bridge is diagnostic-only; tool execution disabled')
  ctx.on('tools/execute', async () => {
    throw new Error(`${name}: invariant violation: dispatch reached the execution waterfall`)
  }, { prepend: true })

  // This is the final model-call boundary, after request reconstruction and
  // before adapter transport. It prevents a same-step recovery attempt from
  // bypassing the assembly-time second-request check.
  ctx.on('llm/stream', (options, next) => {
    streamCount += 1
    if (streamCount !== 1) throw new Error(`${name}: a second model stream is forbidden`)
    if (sha256(options.system ?? '') !== SYSTEM_RAW) {
      throw new Error(`${name}: outbound Minimal system hash drifted`)
    }
    if (options.provider !== 'deepseek-official' || options.model !== 'deepseek-v4-pro'
      || options.reasoningEffort !== 'max' || options.temperature !== undefined
      || options.maxTokens !== 768 || options.stop !== undefined) {
      throw new Error(`${name}: outbound provider/model/sampling controls drifted`)
    }
    if (!Array.isArray(options.tools) || options.tools.length !== 2) {
      throw new Error(`${name}: outbound tool count drifted`)
    }
    if (JSON.stringify(options.tools.map(tool => tool.name)) !== JSON.stringify(SCHEMA_BRIDGE_SURFACE.orderedToolNames)) {
      throw new Error(`${name}: outbound tool order drifted`)
    }
    assertFact(`outbound arm ${armId}`, fact(options.tools[0]), arm)
    assertFact('outbound fixed editor', fact(options.tools[1]), { canonical: EDITOR_CANONICAL, raw: EDITOR_RAW })
    return next()
  }, { prepend: true })

  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const assembled = await next()
    const agent = context.agent
    if (agent === undefined) throw new Error(`${name}: assembly has no agent scope`)
    if (agent.session.events.some(event => event.type === 'request/header')) {
      throw new Error(`${name}: a second model request is forbidden in diagnostic mode`)
    }
    // A complete persona is restored by the system-prompt service only after
    // this entire waterfall returns. The exact final system is therefore
    // locked at llm/stream above (and by the caller's keyless mount report),
    // rather than against this intentionally intermediate assembly value.
    if (assembled.contexts.length !== 0) {
      throw new Error(`${name}: exact Minimal context surface drifted: expected zero contexts, got ${assembled.contexts.length}`)
    }
    if (assembled.tools.length !== 2) {
      throw new Error(`${name}: expected exactly two registered schemas, got ${assembled.tools.length}`)
    }
    const orderedNames = assembled.tools.map(tool => tool.name)
    if (JSON.stringify(orderedNames) !== JSON.stringify(SCHEMA_BRIDGE_SURFACE.orderedToolNames)) {
      throw new Error(`${name}: exact Minimal tool order drifted: ${JSON.stringify(orderedNames)}`)
    }
    const byName = new Map(assembled.tools.map(tool => [tool.name, tool]))
    const bash = byName.get('bash')
    const editor = byName.get('str_replace_editor')
    if (bash === undefined || editor === undefined) {
      throw new Error(`${name}: expected bash and str_replace_editor, got ${JSON.stringify([...byName.keys()])}`)
    }
    assertFact('runtime persistent bash', fact(bash), ARMS.pp)
    assertFact('fixed editor', fact(editor), { canonical: EDITOR_CANONICAL, raw: EDITOR_RAW })

    const bridged = {
      ...structuredClone(bash),
      description: arm.description === 'persistent' ? bash.description : ONE_SHOT_DESCRIPTION,
      parameters: structuredClone(arm.parameters === 'persistent' ? bash.parameters : ONE_SHOT_PARAMETERS),
    }
    assertFact(`arm ${armId}`, fact(bridged), arm)
    return {
      ...assembled,
      tools: [bridged, structuredClone(editor)],
    }
  })
}
