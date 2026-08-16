# Network-v1 results

Status: completed and mechanically validated.

This run executed the public
[`PREREGISTRATION.md`](../../PREREGISTRATION.md) at commit
[`f4f8d4e`](https://github.com/MolecularFullerene/deepseek-v4-pro-harness-ablation/commit/f4f8d4ef9340a74abef39a5945aba48a58cbaa83),
using implementation commit
[`d070fb2`](https://github.com/MolecularFullerene/deepseek-v4-pro-harness-ablation/commit/d070fb21924c86050320fd01b70c84e2f97c3ee4).
The observed endpoint window was 2026-08-16 14:46:44–14:50:09 UTC
(22:46:44–22:50:09 Asia/Shanghai).

No model-proposed tool call was executed. The runner supplied only the frozen,
read-only fixture results. The API key was accepted through hidden TTY input and
was absent from the artifacts under a post-run credential scan.

## Result

Phase A passed the frozen protocol gate: request2 was accepted in all four
`retain/drop reasoning_content × same/new session id` cells. The mechanical
gate returned `GO`, so Phase B began within the preregistered 30-minute window.

All 12 main sources were eligible, all 12 produced the exact request1 anchor,
and all 12 request2 calls were protocol-successful. Eleven request2 responses
matched the exact target tool and argument object.

| Treatment | Correct | Rate |
|---|---:|---:|
| retain reasoning + same session | 3/3 | 100% |
| retain reasoning + new session | 3/3 | 100% |
| drop reasoning + same session | 3/3 | 100% |
| drop reasoning + new session | 2/3 | 66.7% |
| **Overall** | **11/12** | **91.7%** |

The sole main failure occurred in the third `drop reasoning + new session`
unit: the request was protocol-successful and selected the expected tool, but
its argument object was not an exact match. No raw argument is published.

The preregistered descriptive contrasts were:

- retain minus drop: `+1/6` (`+0.1667`);
- same session minus new session: `+1/6` (`+0.1667`); and
- difference in differences: `-1/3` (`-0.3333`).

Every non-zero contrast is produced by that one failure. The independent
four-cell pilot's exact-call diagnostic failed in a different cell
(`retain + new`), while remaining protocol-successful, so the observed
treatment direction was not stable across the pilot and main sample.

## Interpretation

For this one fixed continuation and endpoint window, removing request1
`reasoning_content` was accepted by the API and did not deterministically erase
the target request2 behavior. Replacing the session header with a fresh id also
did not deterministically erase it. This rules out a strict claim that either
passback or same-session identity was necessary for this exact transition.

It does not establish that the factors have zero effect. With only three main
observations per cell and a near-ceiling outcome, the experiment cannot
separate a modest reasoning effect, session effect, interaction, or ordinary
sampling variation. No significance test or broad capability claim is made.

The result also does not prove or disprove a hidden persona, a discrete
internal attractor, general coding ability, or Project2 score reproduction. It
cannot be generalized to other tasks, prompts, accounts, server revisions, or
harnesses. `deepseek-v4-pro` is a mutable service alias and the API exposed no
server build id.

## Publication boundary

- [`PUBLIC_RECEIPT.json`](./PUBLIC_RECEIPT.json) contains only the fields
  allowed by the preregistration publication boundary.
- [`PUBLIC_SCORE_SUMMARY.json`](./PUBLIC_SCORE_SUMMARY.json) contains the
  mechanically verified aggregate result.
- Raw artifacts, reasoning, tool arguments, call ids, request bodies, and
  session- or identity-derived values remain local and are not published.

An independent allowlist review found no credential, Authorization value, raw
reasoning, raw tool argument, call id, or prohibited identity/request hash in
the public materials.
