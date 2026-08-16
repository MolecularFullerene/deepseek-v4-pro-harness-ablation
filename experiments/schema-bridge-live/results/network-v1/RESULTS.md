# Network-v1 results

Status: completed and mechanically validated.

This run executed the public
[`PREREGISTRATION.md`](../../PREREGISTRATION.md) at commit
[`e97670b`](https://github.com/MolecularFullerene/deepseek-v4-pro-harness-ablation/commit/e97670b0a875026d091b9658ced1bd4fa08d25d0),
using implementation commit
[`9de7a15`](https://github.com/MolecularFullerene/deepseek-v4-pro-harness-ablation/commit/9de7a15f927b7add7c6bcaa759460a37b228254f).
The canonical public result is the strict scorer output
[`network-v1-summary.json`](../../network-v1-summary.json); this document only
explains statistics already present in that allowlisted summary.

The four-cell protocol pilot passed before the main sample began. Pilot lexical
labels were excluded from the go/no-go rule. No model-proposed tool call was
executed.

The frozen route was `deepseek-official` / `deepseek-v4-pro` at
`https://api.deepseek.com`. `deepseek-v4-pro` is a mutable service alias; the
API exposed no immutable server-build identifier.

## Result

The main sample contained 160 first-assistant trajectories: 10 frozen public
prompts × 4 fixed runtime identities × 4 arms. Every arm therefore had 40
observations. `P` and `O` mean the persistent and one-shot schema bundle,
respectively; the two letters are `description × parameters`.

| Arm | Minimal-like | Standard-like | Ambiguous | Minimal-like rate |
| --- | ---: | ---: | ---: | ---: |
| `PP` | 26/40 | 2/40 | 12/40 | 65.0% |
| `PO` | 21/40 | 1/40 | 18/40 | 52.5% |
| `OP` | 14/40 | 3/40 | 23/40 | 35.0% |
| `OO` | 9/40 | 1/40 | 30/40 | 22.5% |
| **Overall** | **70/160** | **7/160** | **83/160** | **43.75%** |

The preregistered primary contrasts were:

| Contrast | Estimate | Two-sided Latin randomization p | Holm-adjusted p | FWER .05 |
| --- | ---: | ---: | ---: | :---: |
| Description `D` (one-shot − persistent) | −0.300 | 0.000110 | 0.000330 | reject |
| Parameters `Q` (one-shot − persistent) | −0.125 | 0.159868 | 0.319737 | do not reject |
| Interaction `I` | 0.000 | 1.000000 | 1.000000 | do not reject |

Within these frozen prompts and this harness configuration, replacing the
persistent `bash` description bundle with the one-shot description bundle
reduced the incidence of the lexical `minimal-like` endpoint by 30.0 percentage
points. This was the only primary contrast that survived the preregistered Holm
familywise correction.

The descriptive task-cluster bootstrap intervals were `[-0.4128, -0.1750]` for
`D`, `[-0.2250, -0.0250]` for `Q`, and `[-0.1750, 0.2000]` for `I`. These
intervals were explicitly preregistered as descriptive. In particular, the
`Q` interval excluding zero does **not** override its non-significant
randomization test and Holm-adjusted result; this experiment does not provide
confirmatory evidence for the parameters main effect.

The secondary `OP − PO` contrast was −0.175 (two-sided randomization
`p = 0.150818`) and was outside the Holm family. All 160 main trajectories made
at least one declared tool call, and all 160 had valid declared tool names and
arguments; these are protocol diagnostics, not task-success measurements.

## Protocol integrity

The completed artifact reconciled to all frozen integrity conditions:

- 164 accepted units: 4 pilot and 160 main;
- 164 logical model request headers and 164 assistant responses;
- zero retries, zero executor dispatches, and zero failed-unit replacements;
- a balanced 40-block task-level Latin allocation; and
- a strict scorer result with the frozen oracle, prompt set, classifier, model
  route, Harness commit, and schema hashes.

The raw artifact's allowlisted integrity digest is recorded in the public
summary. It proves internal reconciliation only: it is not a provider signature
or independent proof of external authenticity.

## Interpretation

This controlled four-arm result narrows the earlier schema-surface observation:
the model-visible `bash` description bundle was the largest measured factor in
the lexical trajectory shift, while the parameter bundle and factorial
interaction were not confirmed. The registered executor was held fixed, so the
result is not an executor-persistence effect. The manipulated descriptions are
still whole text bundles, however; this experiment does not identify a single
word, semantic feature, or token-count mechanism.

The endpoint is a lexical trajectory label. It does not measure task success,
answer quality, coding ability, or Project2 score, and it cannot establish a
binary internal route, persona, attractor, or RL-overfitting mechanism. The 160
observations come from only 10 prompt clusters, one account/cohort, one sampling
run, and a mutable model alias. Account, endpoint cohort, server shard, and time
were not randomized, so the result cannot be attributed to immutable model
weights. The high ambiguous count (83/160) is also inconsistent with treating
the observed behavior as a universal two-state switch.

## Publication boundary and provenance

- [`network-v1-summary.json`](../../network-v1-summary.json) is the only
  mechanically generated public result artifact.
- Raw trajectories, reasoning/text, tool arguments, runtime identifiers or
  their hashes, absolute paths, request bodies, and per-unit times remain local
  under ignored `runs/` storage and are not published.
- The public summary contains a deidentified primary-label matrix whose design
  ordinals are reconstructible from the public seed; it is not cryptographic
  anonymization.
- The reported Harness Git commit does not cryptographically attest ignored
  generated `lib/` or `node_modules/` bytes. This provenance limitation is
  encoded in the scorer output as
  `ignoredHarnessLibAndNodeModulesAttested: false`.
