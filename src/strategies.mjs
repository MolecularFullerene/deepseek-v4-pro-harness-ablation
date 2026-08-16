import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const PACKAGE_ROOT = fileURLToPath(new URL('../', import.meta.url))
const localPreset = path => resolve(PACKAGE_ROOT, 'experiments', 'schema-factor', 'presets', path)
const schemaBridgePreset = resolve(PACKAGE_ROOT, 'experiments', 'schema-bridge', 'preset')

/** Strategy catalog. Community paths use the sibling workspace; built-in cells use this package. */
export const STRATEGIES = Object.freeze({
  standard: Object.freeze({
    preset: 'standard',
    source: 'official',
    status: 'supported',
    evidence: 'Official full Standard preset.',
  }),
  minimal: Object.freeze({
    preset: 'minimal',
    source: 'official',
    status: 'supported',
    evidence: 'Official exact-RL Minimal preset: persistent bash + str_replace_editor.',
  }),
  'historical-anchored': Object.freeze({
    preset: 'historical-anchored',
    source: 'modeltest/tools/deepseek-harness-presets/anchored-standard',
    status: 'platform-qualified',
    evidence: 'Frozen 2026-08-14 pwsh/read -> full-catalog configuration used for the reported Project2 98/99 runs.',
    platformNote: 'The scored surface was Windows pwsh/read. On macOS/Linux this preset mounts bash/read and is not a reproduction of that scored Windows runtime.',
  }),
  'anchored-standard': Object.freeze({
    preset: 'anchored-standard',
    source: 'dsh-anchored-standard/preset',
    status: 'supported',
    evidence: 'Current exact-Minimal bootstrap followed by the narrowed resident catalog.',
  }),
  'minimal-anchored': Object.freeze({
    preset: 'minimal-anchored',
    source: 'dsh-minimal-anchored/preset',
    status: 'unsupported',
    evidence: 'Current checkout fails real DSH mount: persistent and Standard bash register the same tool name in one scope (Windows also has an unsupported process-inspector path).',
  }),
  'router-standard': Object.freeze({
    preset: 'router-standard',
    source: 'dsh-router-standard/preset/router-standard',
    status: 'known-broken',
    evidence: 'Repository state under investigation; the live plugin currently references an unimported extractText and may fail on user/message.',
  }),
  'router-spec': Object.freeze({
    preset: 'router-spec',
    source: 'dsh-router-standard/preset/router-spec',
    status: 'known-broken',
    evidence: 'Repository state under investigation; included for failure reproduction, not as a trusted baseline.',
  }),
  'schema-factor-persistent-editor': Object.freeze({
    preset: 'schema-factor-persistent-editor',
    source: localPreset('persistent-editor'),
    status: 'experimental',
    evidence: '2x2 cell: official persistent bash schema + str_replace_editor under exact Minimal system.',
  }),
  'schema-factor-persistent-read': Object.freeze({
    preset: 'schema-factor-persistent-read',
    source: localPreset('persistent-read'),
    status: 'experimental',
    evidence: '2x2 cell: official persistent bash schema + Standard read under exact Minimal system.',
  }),
  'schema-factor-oneshot-editor': Object.freeze({
    preset: 'schema-factor-oneshot-editor',
    source: localPreset('oneshot-editor'),
    status: 'experimental',
    evidence: '2x2 cell: Standard one-shot bash schema + str_replace_editor under exact Minimal system.',
  }),
  'schema-factor-oneshot-read': Object.freeze({
    preset: 'schema-factor-oneshot-read',
    source: localPreset('oneshot-read'),
    status: 'experimental',
    evidence: '2x2 cell: Standard one-shot bash schema + Standard read under exact Minimal system.',
  }),
  'schema-bridge-pp': Object.freeze({
    preset: 'schema-bridge-pp',
    source: schemaBridgePreset,
    status: 'diagnostic-only',
    evidence: 'Fixed persistent executor; persistent description × persistent parameters; execution is blocked.',
    schemaBridgeArm: 'pp',
    experimentalFactors: Object.freeze({ description: 'persistent', parameters: 'persistent' }),
  }),
  'schema-bridge-po': Object.freeze({
    preset: 'schema-bridge-po',
    source: schemaBridgePreset,
    status: 'diagnostic-only',
    evidence: 'Fixed persistent executor; persistent description × one-shot parameters; execution is blocked.',
    schemaBridgeArm: 'po',
    experimentalFactors: Object.freeze({ description: 'persistent', parameters: 'one-shot' }),
  }),
  'schema-bridge-op': Object.freeze({
    preset: 'schema-bridge-op',
    source: schemaBridgePreset,
    status: 'diagnostic-only',
    evidence: 'Fixed persistent executor; one-shot description × persistent parameters; execution is blocked.',
    schemaBridgeArm: 'op',
    experimentalFactors: Object.freeze({ description: 'one-shot', parameters: 'persistent' }),
  }),
  'schema-bridge-oo': Object.freeze({
    preset: 'schema-bridge-oo',
    source: schemaBridgePreset,
    status: 'diagnostic-only',
    evidence: 'Fixed persistent executor; one-shot description × one-shot parameters; execution is blocked.',
    schemaBridgeArm: 'oo',
    experimentalFactors: Object.freeze({ description: 'one-shot', parameters: 'one-shot' }),
  }),
})

export const DEFAULT_COMPARISON = Object.freeze([
  'standard',
  'minimal',
  'historical-anchored',
  'anchored-standard',
])

/** Resolve and validate a strategy selection. */
export function resolveStrategies(names) {
  const expanded = names.flatMap(name => {
    if (name === 'all') return DEFAULT_COMPARISON
    if (name === 'all-known') return Object.keys(STRATEGIES)
    return name.split(',').filter(Boolean)
  })
  const unique = [...new Set(expanded)]
  for (const name of unique) {
    if (STRATEGIES[name] === undefined) {
      throw new Error(`unknown strategy ${JSON.stringify(name)}; run \`list\` for valid names`)
    }
  }
  return unique
}

/** Resolve a community preset source against the workspace root. */
export function strategySourcePath(workspaceRoot, strategyName) {
  const entry = STRATEGIES[strategyName]
  if (entry === undefined) throw new Error(`unknown strategy ${strategyName}`)
  return entry.source === 'official' ? undefined : resolve(workspaceRoot, entry.source)
}

/** Platform-qualified tool-surface expectation used in manifests. */
export function expectedFirstSurface(strategyName, platform = process.platform) {
  const shell = platform === 'win32' ? 'pwsh' : 'bash'
  switch (strategyName) {
    case 'standard':
      return [
        'ask_user_question', shell, 'create_goal', 'edit', 'exit_plan_mode',
        'get_goal', 'glob', 'grep', 'interrupt_agent', 'job_kill', 'job_list',
        'job_output', 'list_agents', 'ralph', 'read', 'read_image',
        'send_message', 'skill', 'subagent', 'subagent_fork', 'todo_write',
        'update_goal', 'web_search', 'workflow', 'write',
      ]
    case 'minimal':
    case 'anchored-standard':
    case 'minimal-anchored':
    case 'schema-factor-persistent-editor':
    case 'schema-factor-oneshot-editor':
    case 'schema-bridge-pp':
    case 'schema-bridge-po':
    case 'schema-bridge-op':
    case 'schema-bridge-oo':
      return ['bash', 'str_replace_editor']
    case 'historical-anchored':
      return [shell, 'read']
    case 'router-standard':
      return [shell, 'str_replace_editor']
    case 'schema-factor-persistent-read':
    case 'schema-factor-oneshot-read':
      return ['bash', 'read']
    case 'router-spec':
      // The legacy/spec surface depends on classification of the first user
      // task, so a task-free mount probe has no single expected catalog.
      return undefined
    default:
      return undefined
  }
}
