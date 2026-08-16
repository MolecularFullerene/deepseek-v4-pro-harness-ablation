# Preregistration: schema-bridge-live-v1

Status: **frozen before live sampling**

Freeze date: 2026-08-17 (Asia/Shanghai)

Implementation parent: `9de7a15f927b7add7c6bcaa759460a37b228254f`

This document was added after the implementation parent above and before any
credential was supplied to `schema-bridge-live-v1` or any external provider
request was made under this oracle/protocol. Earlier experiments in this
repository and local official-adapter tests with an intercepted, no-network
transport are outside that statement.

## Question and interpretation boundary

The study tests whether the model-visible `bash` **description** and
**parameters** bundles are associated with the lexical style of the first
assistant trajectory when every arm uses the same registered official
persistent `bash` executor.

The primary endpoint is the frozen `minimal-like` trajectory label. It is a
lexical diagnostic only. It is not a measure of task completion, answer quality,
general coding ability, or a direct observation of an internal model route or
“persona”. `We need`/`Let me` are trajectory features, not mechanisms.

## Frozen provenance

| Item | Frozen value |
| --- | --- |
| Research implementation parent | `9de7a15f927b7add7c6bcaa759460a37b228254f` |
| DeepSeek Harness tracked commit | `47f943859bef60e4160492346772ded9b24f765a` |
| Protocol closure SHA-256 | `139ca77386f782bd7368eccecadc31ca2937b40d6f6fe12e6e1aa4d328c5eacb` |
| Oracle raw / canonical SHA-256 | `6434319f0c549a479489e0864f03cc92b1cc7e2607e9df1f77dee229f803b8bb` / `02cd87c686ce4385d2413f0a0d3bba4bf4df7b3d6b4c0c0544a3e96fedd97821` |
| Prompt fixture raw / canonical SHA-256 | `7b84405592762432ef7eb8a92a44716fa4d0071689432e3fd84ff11566994060` / `d861a78fdd9126471e3e73a0820920dc2262a8b2741f5a142aea5fa777f0f481` |
| Classifier bytes SHA-256 | `0e6a7b575c3f658b537c75b5070645377b43649f26d154b51471e9cdf59a0b7a` |
| Classifier source | `xiaobright/modeltest@04255b55f16c4439e538239fb9783070c4165081`, `evaluator/trigger_probe/src/classifier.mjs` |
| Enforced platform | `darwin-arm64` |
| Node observed at freeze | `v24.18.0` (reported environment target, not an oracle exclusion gate) |
| Provider / model alias | `deepseek-official` / `deepseek-v4-pro` |
| Base URL | `https://api.deepseek.com` |

The model name is a mutable service alias, and this protocol does not capture an
immutable server-build identifier. Results therefore identify the observed
model–harness–account configuration, not immutable weights. Per-request times
and any response identifiers that happen to be captured remain private; the
protocol does not guarantee capture of a provider request identifier, and the
strict public summary intentionally omits both categories.

The Harness commit check covers Git-visible bytes. Ignored generated `lib/` and
`node_modules/` bytes used by the built launcher are not cryptographically
attested to that commit. This limitation must remain in every public summary.

## Arms and fixed controls

The arm code is `description × parameters`:

| Arm | Description | Parameters |
| --- | --- | --- |
| `PP` | persistent | persistent |
| `PO` | persistent | one-shot |
| `OP` | one-shot | persistent |
| `OO` | one-shot | one-shot |

All arms keep the official persistent executor, `str_replace_editor`, exact
Minimal system prompt, tool order, provider/model, `reasoningEffort=max`, omitted
temperature, `maxTokens=768`, `read-only` permission mode, and first-assistant
stop fixed. Automatic LLM retry is disabled. A monotonic guard, execute tripwire,
and synchronous cancellation prevent any tool executor body from running.

The command requires a clean research worktree and clean Git-visible Harness
worktree, the frozen Harness commit, built-JS launcher, fixed platform, exact
system/tool schema hashes, a minimal allowlisted child environment, and a single
pre-credential protocol snapshot used for every unit.

## Allocation and stopping rule

The sample size is fixed before credential input:

1. Protocol pilot: one request for each arm, using each of four fixed runtime
   homes once (`n=4`). The pilot passes only if all four cells satisfy the
   protocol/surface/one-assistant/no-retry/no-dispatch checks. Lexical labels and
   exact task behavior cannot affect this gate.
2. Main sample: 10 public read-only prompts × 4 fixed runtime homes × 4 arms
   (`n=160`, 40 observations per arm).
3. Maximum logical provider attempts: `4 + 160 = 164`. Every accepted unit must
   have exactly one request header and the adapter tests establish one transport
   fetch. Failed, timed-out, interrupted, or aborted units are never retried,
   replaced, or supplemented.
4. If the pilot fails, no main request is sent. A rejected main observation
   produces terminal `aborted`; a lifecycle or runner exception may instead
   produce `runner-failed`. Neither terminal state is scoreable, and no
   confirmatory summary is produced under this preregistration.

The per-request output ceiling is 768 tokens, so the sum of requested ceilings
is at most `164 × 768 = 125,952` generated tokens. This is a protocol ceiling,
not an estimate of actual usage, billing, or reasoning-token accounting.

## Randomization

Design seed: `schema-bridge-live-main-20260816-v1`.

- For each task, a seeded shuffle produces one four-arm Latin base.
- The four runtime homes receive rotations 0, 1, 2, and 3 of that base, so every
  arm occupies every serial position exactly once within each task.
- Each runtime-home × task block contains four consecutive calls. The 40 complete
  blocks are then shuffled; calls are never interleaved within a block.
- The validator reconstructs the entire allocation from the public seed and
  requires canonical equality.

The four runtime homes stabilize the anonymous DSH identity within a block
series. They do not randomize API account, endpoint cohort, server shard, or
time. Those remain limitations rather than estimated causal factors.

## Outcomes and analysis

The frozen classifier assigns `minimal-like`, `standard-like`, or `ambiguous`.
The main arm rates use only the 160 main observations; pilot labels are excluded.

Primary contrasts, with arm symbols denoting `minimal-like` rates:

- `D = 0.5 × ((OP + OO) - (PP + PO))`
- `Q = 0.5 × ((PO + OO) - (PP + OP))`
- `I = OO - OP - PO + PP`

Analysis seed: `schema-bridge-live-analysis-20260816-v1`.

- Two-sided Monte Carlo randomization tests use 100,000 draws. Each draw samples
  a new Latin base independently within every task and preserves the four
  positional outcome rows. P values use `(extreme + 1) / (draws + 1)`.
- Holm correction controls familywise alpha 0.05 across `D`, `Q`, and `I` only.
- Descriptive 95% uncertainty intervals use 20,000 task-cluster bootstrap draws:
  ten whole tasks are sampled with replacement and all 16 observations of every
  selected task are retained.

Secondary, outside the Holm family: `OP − PO`; full three-label distributions;
`startsWeNeed`/`startsLetMe`; conditional declared-tool and argument validity;
and provider-reported prompt/reasoning/output token aggregates. These are
descriptive or exploratory and cannot replace the primary family.

No result-dependent stopping, extra sampling, prompt deletion, task weighting,
classifier revision, endpoint switching, or post-hoc arm regrouping is allowed.
Any changed protocol requires a new version and a new preregistration before
credentials or live requests for that version.

## Execution and publication

After this docs-only preregistration commit is publicly available and verified,
the live command is:

```sh
node src/cli.mjs schema-bridge-live \
  --oracle experiments/schema-bridge-live/oracle.json \
  --out runs/schema-bridge-live/network-v1-private.json \
  --api-key-stdin \
  --allow-network \
  --max-tokens 768
```

For this formal run, the operator must invoke the command from an interactive
TTY; `readSecret` then disables echo while the temporary key is entered. The key
is sent to each child via stdin only. It must not appear in argv, environment,
patch files, artifacts, or version control.

Only a `completed` raw artifact may be transformed:

```sh
node experiments/schema-bridge-live/score-artifact.mjs \
  --artifact runs/schema-bridge-live/network-v1-private.json \
  --oracle experiments/schema-bridge-live/oracle.json \
  --out experiments/schema-bridge-live/network-v1-summary.json
```

The raw artifact is private and must never be published or committed. Only the
strict scorer output and a report derived from it may be published. The summary
excludes raw reasoning/text/tool arguments, real identity/session/request/call
identifiers or hashes, absolute paths, and per-request timestamps.

The allowed raw-artifact integrity digest establishes internal consistency and
result reconciliation only. It is not a provider signature and cannot establish
external authenticity. The public summary must also retain the explicit false
attestation flag for ignored Harness runtime bytes.
