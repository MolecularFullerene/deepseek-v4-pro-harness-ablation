# Guarded request #2 transport replay

This command tests explicit `reasoning_content` passback and the
`x-deepseek-harness-session-id` header at the real official `DeepSeekAdapter`
transport boundary. It is **not** a DSH Agent/Session fork and it never
executes a model-proposed tool command.

## Design

- A four-cell protocol pilot runs first, using four independent request1
  sources and one live treatment per source. Main sampling starts only if all
  four cells succeed. Only both retain controls succeeding plus at least one
  drop cell returning HTTP 400 is classified `drop-protocol-rejected`; every
  other failure is `factorial-pilot-unidentifiable`.
- The main design has `--repeat K` randomized blocks. Every block contains
  `retain-same`, `retain-new`, `drop-same`, and `drop-new` once. Default `K=3`.
- Every treatment gets an independent request1 source session. A source sends
  exactly one live request2, preventing branch order from contaminating a
  stateful server-side session. A `new` treatment always gets a previously
  unused session id.
- For each eligible source, all four request2 variants are first serialized
  through the official adapter into an in-memory no-network preflight. The
  existing byte/header conformance proof must pass. The assigned live request
  is regenerated and compared byte-for-byte with its preflight capture before
  fetch is allowed to continue.
- Request1 must return non-empty reasoning plus a tool call and finish with
  `tool_calls`. Each call receives a fixed fixture string paired by call id;
  arguments are never parsed or executed.
- `expectedJson` is preregistered in the planned manifest before the key is
  read. Request2 correctness requires exactly one extractable JSON object with
  exact fields and values. Transport/protocol success and answer correctness
  are separate outcomes. `We need` / `Let me` prefixes are diagnostics only.
- The request surface is not hand-authored: `request1.json` contains the full
  system and both schemas exported by a real official `minimal` mount at the
  locked Harness commit. Before reading stdin, every invocation performs a
  fresh keyless Minimal mount and requires exact system text, tool order,
  full-schema bytes, per-tool SHA-256, platform, commit, and whole-surface SHA.
  Any mismatch stops before credential read or transport.

## Offline end-to-end mock

The mock still exercises the built official adapter and SSE parser, but its
fetch is satisfied in-process:

```sh
printf '%s' 'offline-memory-only-sentinel' | node src/cli.mjs request2-live-replay \
  --fixture experiments/request2-live-replay/fixtures/request1.json \
  --mock-script experiments/request2-live-replay/fixtures/mock-success.json \
  --repeat 1 \
  --seed mock-e2e-v1 \
  --out experiments/request2-live-replay/artifacts/mock-latest.json \
  --api-key-stdin
```

The `mock-pilot-400.json` fixture verifies the stop rule.
Add `--pilot-only` to run the four protocol cells and stop even when all pass;
this is the required first-network-run mode before authorizing the main sample.

## Explicit network run

There is no key value flag and this command never reads `DEEPSEEK_API_KEY`.
Paste/read the one-shot key into a non-exported shell variable, pipe it to
stdin, and clear it afterwards. Network is additionally gated by the literal
`--allow-network` flag and requires an explicit output-token cost bound:

```sh
read -rs DSH_LAB_ONESHOT_KEY
printf '%s' "$DSH_LAB_ONESHOT_KEY" | node src/cli.mjs request2-live-replay \
  --fixture experiments/request2-live-replay/fixtures/request1.json \
  --repeat 3 \
  --max-tokens 4096 \
  --pilot-only \
  --out runs/request2-live-replay.json \
  --api-key-stdin \
  --allow-network
unset DSH_LAB_ONESHOT_KEY
```

Before reading the key, the CLI writes a mode-0600 planned manifest containing
the frozen seed, block order, `K`, hashed session identities, and stop rule.
Final artifacts contain response reasoning/text/tool calls/usage/errors,
request-body hashes, and hashed/redacted header summaries. They contain no raw
request body, Authorization value/hash, API key, anonymous user id, or session
id.
