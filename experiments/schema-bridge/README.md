# First-request bash schema bridge (diagnostic only)

The earlier 2×2 screening changed the entire persistent/one-shot `bash` schema
bundle. Because every captured first response was cancelled before tool
dispatch, executor persistence itself cannot explain that first-response
association. This bridge fixes the real registered executor to official
persistent bash and crosses only the two model-visible components:

| strategy | description | parameters | canonical SHA-256 | raw JSON SHA-256 | raw chars |
| --- | --- | --- | --- | --- | ---: |
| `schema-bridge-pp` | persistent | persistent | `b44ee1237054e485b671275dd49cda93c9a85a113be6c7be3ea3af4913f91c24` | `fd7afc1cf7fcddd6569f0382dfd9b1a06c0b2b1e2302bd37a3927bee6959b1b1` | 849 |
| `schema-bridge-po` | persistent | one-shot | `bdabadf8d3a97d145acbd9381b92dea30d3cadfb0f6433662f35718daca7519a` | `b22421b472b4209f14a70aacccfc54bfc4f865a0f50fdabb250de8a1140566b2` | 2042 |
| `schema-bridge-op` | one-shot | persistent | `9ad7dc6844bda07561e546cf0d02c1c37f08577f40f40cbe01d5964a4cb84075` | `fd23fda05ece071a86dfeded9de0ad09df71ff8796fbe2b3e11b36d29ccb12b3` | 2049 |
| `schema-bridge-oo` | one-shot | one-shot | `d80d15e24dbba48476b37cebc13fff6225e805c7f0f183762ad83a609095c937` | `ce6ad0324e0e05d863eae734cde4a77ade47574b4c31ed4d2665c89c711ec9e9` | 3242 |

`P/O` means the exact surface assembled by Harness commit
`47f943859bef60e4160492346772ded9b24f765a`. The fixed editor canonical/raw
hashes are respectively `5120c75c…` and `0948b708…`. All arms also lock the
Minimal system hash `5fab6e32…`, `contexts=[]`, and tool order
`bash, str_replace_editor`. Both canonical and raw-order hashes are checked:
canonicalization alone would hide property-order drift that remains visible on
the serialized request.

## Why execution is forbidden

The assembly sent to the model can differ from the registered runtime tool.
The persistent tool's argument object is open, so one-shot-only fields such as
`workdir` or `sandbox_permissions` would pass its runtime validation and then
be ignored. That is unsafe and invalidates a multi-step comparison.

The preset therefore has three independent controls:

1. the normal lab runner cancels synchronously when the first
   `assistant/message` is published, before dispatch;
2. a scoped monotonic tool guard denies every call even if another
   `tools/pre-execute` listener tries to allow it;
3. a prepended `tools/execute` tripwire throws if dispatch is ever reached.

Consequently these strategies are suitable only for a first-response
diagnostic. They must never be used as a general coding agent or as evidence
that an arm improves end-to-end task ability. A future multi-step experiment
needs an explicit argument facade that faithfully implements or rejects every
advertised field.

## Offline real-DSH verification

No key or network is needed:

```sh
node src/cli.mjs smoke \
  --strategy schema-bridge-pp,schema-bridge-po,schema-bridge-op,schema-bridge-oo \
  --order grouped \
  --capture full \
  --out ./runs/schema-bridge-smoke
```

Each strategy copies the same preset. The launcher supplies the public arm id
through `DSH_SCHEMA_BRIDGE_ARM`; the plugin rejects missing/unknown ids and
fails on any runtime, editor, arm, system, context, count, order, or raw-schema
drift before a model request can be sent.

## Future first-response pilot

If live sampling is authorized later, every job must use
`--stop-after-first-assistant`. Run complete four-arm blocks in randomized
order with a fresh session per trajectory and a fixed anonymous identity per
batch. Freeze the existing `minimal-like` classifier before sampling and use it
only as a trajectory-style endpoint; `startsWeNeed`, `startsLetMe`, reasoning
length, first action validity, advertised-schema argument validity, provider
token counts, latency, and cost are diagnostics.

For two already frozen prompt templates, `n=5` per prompt/arm is only a pilot
(40 additional trajectories). A stronger lexical confirmation would use
`n=10` per prompt/arm (80 trajectories) and a blocked randomization test that
preserves each prompt × repetition four-arm block. It still would not establish
task ability or an internal two-attractor mechanism.

The factorial contrasts, with arm means written as `PP`, `PO`, `OP`, `OO`, are:

```text
description = 1/2 * ((OP + OO) - (PP + PO))
parameters  = 1/2 * ((PO + OO) - (PP + OP))
interaction = OO - OP - PO + PP
```

`PO` and `OP` differ by only seven raw schema characters, making them a useful
near-mass-matched comparison. Provider-reported prompt tokens must still be
recorded; schema length is not token length, and no padding is semantically
neutral by definition.
