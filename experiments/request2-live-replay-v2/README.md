# Request2 live replay v2: read-only routed tool choice

This fixture raises the request2 endpoint from “repeat two strings as JSON” to
an exact, two-stage tool-routing decision. It reuses the existing guarded
`request2-live-replay` runner and its blocked `retain/drop reasoning ×
same/new session` allocation. No model-proposed call is executed.

## Frozen task and primary endpoint

1. Request1 must produce non-empty reasoning and exactly one `bash` tool call:
   `sed -n '1,120p' /safe/mock/workspace/ROUTE.txt`.
2. The runner does not execute that command. It pairs the call id with a fixed
   string containing a trusted route plus instruction-like decoys.
3. Request2 must ignore the decoys, assemble a path and line range from the
   trusted fields, and produce exactly one call:

   ```json
   {
     "name": "str_replace_editor",
     "arguments": {
       "command": "view",
       "path": "/safe/mock/workspace/ledger.txt",
       "view_range": [4, 7]
     }
   }
   ```

The source-controlled [`oracle.json`](./oracle.json) preregisters both calls
and every primary gate. Argument-object equality is canonical and exact: a
wrong tool, decoy path/range, missing field, extra field, malformed JSON,
extra call, visible text, wrong finish kind, failed protocol, or failed
request1 anchor is incorrect. `We need` / `Let me` remains diagnostic only.

Pilot units are scored for diagnostics but excluded from the factorial
estimates. Main output reports cell counts/rates, retain-minus-drop,
same-minus-new, and the 2×2 difference-in-differences. With small `K`, these
are descriptive outcomes rather than uncertainty-calibrated estimates.

## Read-only and non-executing boundary

- The frozen request1 operation is a bounded `sed` print.
- The correct request2 operation is editor `view`.
- Even the two deliberately wrong mock answers use read-only `cat`/`view`.
- The transport runner captures proposed calls and injects fixed strings; it
  never parses request1 arguments into a command and never executes request2.
- The mock path intercepts the official adapter's `fetch` in-process and uses
  the unroutable loopback URL `http://127.0.0.1:9`. This is not OS-level
  network isolation, so the test also freezes the mock base URL and fails if
  the artifact reports another route.

The official Minimal schemas still *describe* mutation-capable operations and
an unrestricted shell. Therefore this fixture is safe specifically at the
non-executing transport-replay boundary. Reusing it in an executing agent
would require a separate command/tool allowlist.

## Existing-runner gap

The current runner already records request2 `toolCalls`, so no runner or CLI
fork is needed. Its built-in preregistered scorer, however, only accepts one
final JSON object. A correct tool-call-only response consequently has
`request2.score.answerCorrect=false`. That field is not the v2 endpoint.

[`score-artifact.mjs`](./score-artifact.mjs) is the isolated supplemental
scorer. The runner's raw artifact is **local sensitive data**, not a public
artifact: it contains raw reasoning, tool-call ids, names, and arguments and
is written with mode `0600`. Do not commit or publish it. The scorer emits no
raw reasoning, call ids, arguments, or session-derived hashes.

`--oracle` is read before the credential, and its canonical SHA-256 is frozen
into both the planned manifest and the configuration fingerprint before any
transport request. The v2 validator also runs before credential read and
freezes `temperature=null`, `maxTokens=768`, mock `repeat=1`, network
`repeat=3`, the discriminator mock's canonical SHA-256, the fixed anonymous
identity hash, the complete adapter header/surface hashes, and every oracle
field. Scoring re-derives each pilot/block treatment order from the recorded
seed and requires the exact stopping rule.
The supplemental scorer then rejects a non-completed run, wrong
fixture/oracle/surface/commit/platform/model controls, malformed or incomplete
four-cell plan, reused source or new session, request/preflight mismatch,
failed conformance/pairing/fixed-result check, HTTP/protocol contradiction, or
inconsistent aggregate. Native runner scoring is still desirable in a later
schema version, but the v2 endpoint is no longer a post-hoc unbound oracle.

The final artifact includes a canonical `integritySha256`. This detects
accidental edits and unresealed low-effort tampering; it is not a digital
signature, because anyone able to rewrite the artifact can recompute an
ordinary hash. A formal live result should externally timestamp or sign that
digest immediately after collection. Accordingly, scorer
`source.validated=true` means “the local artifact is structurally self-consistent
with the frozen v2 design,” not “GitHub or another third party attested the raw
trajectory.”

The existing runner also admits any reasoned request1 tool call before
injecting a result keyed only by tool name. The v2 score closes that analytic
gap by requiring the exact bash anchor, but it does not change transport-time
eligibility.

## Offline discriminator check

The mock gives all four protocol-pilot cells the correct call. In the single
main block, `retain-same` and `drop-new` are correct; `retain-new` chooses the
decoy tool and `drop-same` chooses the decoy arguments. This is a scorer
self-test, not model evidence.

The existing CLI interface requires a non-empty stdin credential even in
mock mode. The value below is a public synthetic sentinel, not an API key; the
mock adapter never sends it to a network endpoint.

```sh
mkdir -p /tmp/dsh-r2-v2
printf '%s' 'OFFLINE-V2-PUBLIC-NONCREDENTIAL-SENTINEL' | \
  node src/cli.mjs request2-live-replay \
    --fixture experiments/request2-live-replay-v2/fixtures/request1.json \
    --mock-script experiments/request2-live-replay-v2/fixtures/mock-discriminating.json \
    --oracle experiments/request2-live-replay-v2/oracle.json \
    --base-url http://127.0.0.1:9 \
    --max-tokens 768 \
    --repeat 1 \
    --seed request2-live-replay-v2-offline \
    --out /tmp/dsh-r2-v2/artifact.json \
    --api-key-stdin \
    --harness-root ../deepseek-harness \
    --timeout-ms 30000

node experiments/request2-live-replay-v2/score-artifact.mjs \
  /tmp/dsh-r2-v2/artifact.json
```

Expected main result: 2/4 correct, with exact failures isolated to
`retain-new` (tool name and arguments) and `drop-same` (arguments). The test
suite runs this path offline when the official adapter build is present.
