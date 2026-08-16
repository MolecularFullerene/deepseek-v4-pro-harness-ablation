# Preregistration: request2 reasoning passback x session identity

Version: `network-v1`

Frozen before any credential is supplied to this v2 run and before any
network execution of this v2 fixture/oracle on 2026-08-16 (Asia/Shanghai).
The repository host's public record of the Git commit containing this document
establishes publication order; the author-controlled commit timestamp is not
treated as a trusted clock. The implementation under test is its parent commit,
`d070fb21924c86050320fd01b70c84e2f97c3ee4`; the preregistration commit adds
documentation only.

## Question and scope

This experiment asks whether the exact second-request tool choice changes
when two transport-visible factors are crossed:

1. retain or remove request1 `reasoning_content`; and
2. reuse the request1 session header or send a fresh session id.

Each live treatment has an independent request1 source session. Model-proposed
tool calls are captured but never executed; request1 receives only the frozen
fixture result. This is an API-level official-adapter replay, not a live DSH
Agent/Session fork and not an end-to-end coding benchmark.

The experiment does **not** test or establish a hidden persona, a discrete
internal attractor, general coding ability, or Project2 score reproduction.
`We need` and `Let me` are diagnostic labels only and never enter eligibility,
the primary endpoint, stopping, or the go/no-go decision.

## Frozen materials and controls

| Item | Frozen value |
|---|---|
| Study seed | `request2-v2-network-20260816-preregistered-v1` |
| Fixture raw SHA-256 | `f1003ff0c0597a3bc2e66e2dc487e22b568d93a35b410438a428312627b093f0` |
| Oracle raw SHA-256 | `4c95ab09260e946835695e4ae4cce97d854c6bf32e05e87cdfeb7d061b398f91` |
| Oracle canonical SHA-256 | `5bf37d3644146d26f2cba81171744626da3882be74a58da9a9dca42f1004430d` |
| DeepSeek Harness commit | `47f943859bef60e4160492346772ded9b24f765a` |
| Platform | `darwin-arm64` |
| Node observed before preregistration | `v24.18.0` |
| Provider | `deepseek-official` |
| Model alias | `deepseek-v4-pro` |
| Base URL | `https://api.deepseek.com` |
| Reasoning effort | `max` |
| Temperature | omitted, therefore `null` |
| Per-response output cap | `768` tokens |
| Main repetitions | 3 complete four-cell blocks; 12 main units |
| Exact Minimal surface SHA-256 | `0fdd6bb5e6d5c44f5292f98bca22dc6a0313e2ce645743584849b73f5223133c` |
| System SHA-256 | `5fab6e32f283d71510531ce850df2690b8fb77437d36bfabbe8c4ac862f19df9` |
| Tool schema SHA-256, in order | `fd7afc1cf7fcddd6569f0382dfd9b1a06c0b2b1e2302bd37a3927bee6959b1b1`, `0948b7082aad2c337f314df4c3e62a779d9a0fdd03f04f07811d7c13e2f2ef3b` |

The model name is a mutable service alias and the API exposes no server build
identifier. The execution report must therefore state the actual time window;
the result is evidence for that observed endpoint window, not every deployment
behind the alias.

## Primary endpoint and planned summaries

A main unit is correct only when all four frozen gates pass:

1. the source is eligible;
2. request1 has non-empty reasoning and the exact single `bash` anchor call;
3. request2 is protocol-successful; and
4. request2 contains the exact single `str_replace_editor` call and exact
   argument object specified in [`oracle.json`](./oracle.json).

Extra text, extra calls, extra or missing arguments, malformed arguments, a
wrong tool, a failed request1 anchor, or protocol failure makes the unit
incorrect. Pilot units are excluded from main estimates regardless of their
answer correctness.

For the 12 main units, report the four cell counts and rates plus these
descriptive contrasts:

- reasoning retention: one half of `(retain-same + retain-new) -
  (drop-same + drop-new)`;
- same-session header: one half of `(retain-same + drop-same) -
  (retain-new + drop-new)`; and
- interaction: `retain-same - retain-new - drop-same + drop-new`.

With only three observations per cell, the results are a small mechanistic
pilot. No significance, broad generalization, or task capability claim is
planned.

## Phase A: protocol pilot only

Run from the repository root with a clean checkout of the preregistration
commit. Both output paths must be absent before execution. Run the command in a
TTY. After all keyless preflight checks complete, the CLI places the TTY in raw
mode, displays an `input hidden` prompt, reads the one-time credential until
Enter, and restores the prior terminal mode. The value goes directly from the
TTY to process memory; it does not enter argv, a file, the process environment,
terminal scrollback, or shell history.

```sh
mkdir -p runs
node src/cli.mjs request2-live-replay \
  --fixture experiments/request2-live-replay-v2/fixtures/request1.json \
  --oracle experiments/request2-live-replay-v2/oracle.json \
  --provider deepseek-official \
  --model deepseek-v4-pro \
  --base-url https://api.deepseek.com \
  --reasoning-effort max \
  --max-tokens 768 \
  --repeat 3 \
  --seed request2-v2-network-20260816-preregistered-v1 \
  --pilot-only \
  --out runs/request2-v2-network-pilot.json \
  --api-key-stdin \
  --allow-network \
  --harness-root ../deepseek-harness \
  --timeout-ms 900000
```

This phase makes four independent treatment units, each consisting of one
request1 and, only when that source is eligible, one request2. A passing gate
therefore has exactly eight API requests; a failed gate can have fewer. Offline
serializer preflights are not network requests.

### Frozen go/no-go rule

Proceed to Phase B only if the completed pilot artifact reports all of the
following without manual reinterpretation:

- top-level status `pilot-passed`;
- pilot outcome status `passed`;
- `allProtocolSuccess=true`; and
- all four treatment-specific protocol-success values are `true`.

The pilot's exact-call correctness is diagnostic and cannot affect this
decision. A `drop-protocol-rejected`, `factorial-pilot-unidentifiable`,
`worker-failed`, timeout, malformed artifact, integrity mismatch, or any other
outcome stops the study. There is no treatment-level retry, replacement, seed
change, or alternate key. A local failure proven to occur before the first
outbound request requires a new public preregistration revision before trying
again.

The sole mechanical Phase A gate is:

```sh
node experiments/request2-live-replay-v2/score-artifact.mjs \
  --pilot-gate \
  runs/request2-v2-network-pilot.json \
  experiments/request2-live-replay-v2/oracle.json \
  > runs/request2-v2-network-pilot-receipt.json
```

Phase B is allowed only when this command exits zero and its sanitized output
contains `decision: "GO"`. The gate validates the sealed artifact, frozen
oracle and controls, deterministic plan, exact four treatment records and
outcome, `pilotOnly=true`, zero main samples, and the process result. It emits
only the receipt allowlist defined below.

## Phase B: blocked main sample

If and only if Phase A passes, run the following with the same API key,
checkout, machine, and endpoint. Phase B must begin within 30 minutes after
Phase A finishes; otherwise stop and report the study as aborted:

```sh
node src/cli.mjs request2-live-replay \
  --fixture experiments/request2-live-replay-v2/fixtures/request1.json \
  --oracle experiments/request2-live-replay-v2/oracle.json \
  --provider deepseek-official \
  --model deepseek-v4-pro \
  --base-url https://api.deepseek.com \
  --reasoning-effort max \
  --max-tokens 768 \
  --repeat 3 \
  --seed request2-v2-network-20260816-preregistered-v1 \
  --out runs/request2-v2-network-main.json \
  --api-key-stdin \
  --allow-network \
  --harness-root ../deepseek-harness \
  --timeout-ms 900000
```

The main command intentionally performs a fresh four-cell protocol pilot
before its 12 main units. If that gate passes, Phase B makes eight gate
requests, 12 main request1 calls, and `E` main request2 calls, where `E` is the
number of eligible main sources (`0 <= E <= 12`): `20 + E`, or 20–32 requests.
After a passing Phase A, both phases therefore make 28–40 requests when the
Phase B gate also passes. The worst-case generated-token cap remains
`40 * 768 = 30,720`.

If the Phase B gate fails, its built-in stop rule prevents main sampling. If a
main unit later fails or becomes ineligible, retain that outcome; do not rerun
or replace it.

## Integrity, scoring, and publication boundary

Both output files under `runs/` are local sensitive artifacts created with
mode `0600`; the CLI refuses an already existing output path. They may contain
raw reasoning, tool-call ids and arguments, and session-derived hashes. They
must never be committed, uploaded, pasted into an issue, or treated as public
supplements.

For a `pilot-passed` or `completed` artifact, immediately run the frozen
mechanical verifier before qualitative inspection. Publish a small receipt
using only this allowlist: preregistration and implementation commit ids; the
opaque artifact `integritySha256`; fixture, oracle, and Harness hashes; public
model controls; transport; seed; repeat; phase status; gate decision; and
timestamps. Do **not** publish `configFingerprint`, `planSha256`, anonymous,
session, request, header, body, call-id, argument, or reasoning hashes or raw
values. The artifact digest is not a signature; the repository host's public
record of the receipt establishes ordering relative to any later replacement.

A preflight or worker failure may have no sealed artifact. In that case,
publish only the preregistration commit, phase, coarse failure category, exit
status, and timestamps; do not claim or invent an integrity receipt.

Only a completed Phase B artifact is scored with the frozen supplemental
scorer:

```sh
node experiments/request2-live-replay-v2/score-artifact.mjs \
  runs/request2-v2-network-main.json \
  experiments/request2-live-replay-v2/oracle.json \
  > runs/request2-v2-network-main-score.json
```

Publish only the mechanically validated, sanitized score summary, receipt,
methods, and limitations after an independent leakage scan. Preserve the raw
artifacts locally for audit, but do not publish them. A failed or stopped run
must be reported as such rather than silently omitted.
