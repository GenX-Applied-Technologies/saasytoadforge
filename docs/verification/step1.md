# Step 1 verification: one live Forge → Router → Together US call

Run on 2026-11-10, 09:19–09:21 America/Detroit (EST), on the shared build box.
Approved by Ron Strickland, 2026-11-10 09:08 EST (one live call, hard cap $0.10;
raised to $0.50 at 09:13 EST with the Router cap kept at ≤ $0.10). No merges, no
deploys, no production changes, no E2B, no other providers.

## Commits
| Repo | Branch | Base | Code under test |
| --- | --- | --- | --- |
| GenX-Applied-Technologies/saasytoadforge (draft PR 10) | `feature/router-llm-client` | `b8fbce6` | `5f22b2b` |
| GenX-Applied-Technologies/genx-router-os (draft PR 28) | `feature/forge-coding-complete` | `2c964f1` | `57b8b66` |

The live runs used the working trees that became those commits. After the runs, only
`scripts/step1-live.ts` changed (it now reads written files by the path the model
chose; the run looked for `src/config.js` but the model wrote
`packages/game-template/src/config.js`, so `writtenConfigJs` printed `null`).
`RouterLlmClient`, the planner, the agent loop and all Router code are unchanged.

## What runs (no mocks on the step-1 path)
`apps/agent-service/scripts/step1-live.ts` calls the real factories:
`parseServerEnv()` → `createLlmClient(env)` (must return `RouterLlmClient`, else it
throws) → `createPlanner(env, llm)` (→ `LlmPlanner`) → `Agent.run(...)`. The Router is
the real `next build` output served by `next start` on `127.0.0.1:3917`, calling the
real `https://us-api.together.ai/v1/chat/completions`.

The only stand-in is the **sandbox**: planned edits land in the in-memory
`MockSandboxProvider`. Real sandbox isolation is milestone 2 and was out of scope
(no E2B spend approved).

## Secrets handling
- Forge app token: generated with `openssl rand -base64 48` straight into
  `/workspace/forge-game-proof/.secrets/forge-app-token` (dir 700, file 600,
  outside both repos, `.secrets/.gitignore` = `*`). Read into env by the launch
  scripts with `$(cat …)`; curl reads it from a 600 header file (`-H @file`).
- `TOGETHER_API_KEY`: inherited from the bot environment; checked for presence only.
- After the runs, every evidence file and log was scanned for both values: none found.

## Commands
Launchers live in `/workspace/forge-game-proof/step1/` (not committed; they hold
box paths). Equivalent steps:
```
# Router
cd genx-router-os && npm run typecheck && npm run lint && npx vitest run && npx next build
ROUTER_OS_FORGE_APP_TOKEN=<file> ROUTER_OS_FORGE_SPEND_CAP_USD=<cap> \
ROUTER_OS_FORGE_SPEND_LEDGER_PATH=<abs path> ROUTER_OS_FORGE_UPSTREAM_TIMEOUT_MS=60000 \
VERCEL_ENV=preview ROUTER_OS_FORGE_CODING_ENABLED=<true|false> \
  npx next start -H 127.0.0.1 -p 3917          # VERCEL and TOGETHER_BASE_URL unset
# Forge
cd saasytoadforge/apps/agent-service
GENX_ROUTER_URL=http://127.0.0.1:3917 GENX_ROUTER_FORGE_TOKEN=<file> NODE_ENV=development \
  pnpm proof:step1                               # direct-provider and E2B keys unset
```
`next start` forces `NODE_ENV=production`; `VERCEL_ENV=preview` is the route's
documented non-production switch. Production mode was never used.

## Live failure paths (real local Router, free)
| Test | Setup | Result | Upstream call? |
| --- | --- | --- | --- |
| Flag off | `ROUTER_OS_FORGE_CODING_ENABLED=false` | 503 `coding_disabled` | No: no ledger file created (the ledger is written before any upstream call) |
| Wrong Forge token | bearer = fixed wrong string | 401 `unauthorized` | No |
| Missing Forge token | no `Authorization` | 401 `unauthorized` | No |
| Cap hit (curl) | cap `$0.000001` | 402 `spend_cap_exceeded`, `requiredUsd` 0.003172875, `committedUsd` 0 | No: no ledger file created |
| Cap hit (Forge loop) | same | agent events `[error, done]`: "Router coding call failed: the Router spend cap is reached, so the call was not sent (spend_cap_exceeded, HTTP 402, request 30f969db-…). No fallback or automatic retry." | No |
| Bad Together key (curl) | random `invalid-step1-test-key-…`, real US endpoint | 502 `upstream_auth_failed`, `upstreamStatus` 401, `upstreamType` `invalid_request_error`, `chargedUsd` 0 | Yes (free 401); ledger settled $0 |
| Bad Together key (Forge loop) | same | `[error, done]`: "…Together rejected the Router credential (upstream_auth_failed, HTTP 502, upstream HTTP 401, request 6fd3f63a-…)…" | Yes (free 401); ledger settled $0 |

The bad key's value did not appear in any response or log.

## The live call (1 paid call; limit was 3)
Router cap `$0.05`. Prompt: plan one tiny change to the Phaser template (add
`src/config.js` exporting `PLAYER_SPEED = 200`, `SEED_COUNT = 8`), one edit only.

| Field | Value |
| --- | --- |
| Result | `ok: true`, 3.0 s end to end |
| Planner / client | `llm` / `genx-router` |
| Agent events | message "Add config.js exporting PLAYER_SPEED and SEED_COUNT constants.", plan (1 step), edit `packages/game-template/src/config.js` (7 diff lines), done |
| Model (pinned / reported by Together) | `deepseek-ai/DeepSeek-V4.1-Flash-1017` / `deepseek-ai/DeepSeek-V4.1-Flash-1017` |
| Together completion id | `21a0839b-aws_ue1` |
| Router request id | `fcef42c7-9148-4460-a711-7c4fe1efd027` |
| Usage | 266 input, 105 output, 0 cached tokens |
| Cost from real usage | 266 × $0.375/M + 105 × $1.50/M = **$0.00025725** |
| Reserved before the call | $0.003477375 (worst case) |
| Ledger | one entry, `status: settled`, `outcome: ok`, `fromUsage: true`, `settledNanoUsd: 257250` |

The Together dashboard was not checked (no login, as instructed). The completion id
above is what to match against Together's usage records.

## Total real spend
**$0.00025725** (one paid call). The two bad-key calls were refused with 401 and are
not billed. Well under the $0.10 approval and the $0.05 Router cap.

## Unit and suite results
| Repo | Typecheck | Lint | Tests |
| --- | --- | --- | --- |
| Forge | pass (shared, agent-service incl. scripts, web) | pass | 231 passed, 1 failed (`src/workspace/agent.test.ts` "runs the canonical task…"; fails identically at base `b8fbce6`, pre-existing and unrelated) |
| Forge game | — | — | `pnpm test:game`: 1 passed (real Chromium playtest) |
| Router | pass | pass | 3437 passed, 0 failed (172 files); `next build` pass |

Unit tests mock `fetch` or the transport **in test files only**: pricing, ledger
(reserve/refuse/settle/restart/crash/corrupt/stale lock), config fail-closed, every
error mapping (401/403/404/429/400/500, timeout, network, malformed with and without
usage, truncated, model mismatch), cap across calls, flag off, tokens, production,
Vercel; Forge client code mapping, usage validation, cancellation, unreachable,
production refusal of the mock, and an agent-loop test that a Router 402 surfaces as
one clean error event.

## Proven live vs. mocked
Proven live:
- Forge's real factory → `RouterLlmClient` → `LlmPlanner` → `Agent.run` reaching the
  built Router over HTTP, and the Router reaching Together US with the pinned model.
- Together reported the same model id; a parsable plan came back and the loop applied it.
- Worst-case reservation before the call, settlement to Together's real usage, the
  persisted ledger, and the cost maths.
- Flag off, cap hit, wrong/missing Forge token: refused with no upstream call.
- Bad Together key against the real endpoint: clean 502/401 mapping, $0 settled, no leak.
- Errors reach the agent loop as one readable error event, with no fallback.

Mocked in tests only (not proven live): Together timeouts, network failure, 403/404/
429/5xx, malformed or truncated bodies, model mismatch, corrupt ledger, stale lock.

Not in step 1: real sandbox execution (the edit went to the in-memory mock sandbox),
browser UI, hosting.

## Why there is no browser walkthrough
Joe's rule needs a real browser on a hosted preview. Forge is not hosted yet (step 0),
and step 1's subject is the server-to-server model call, which has no UI. The proof is
the live agent-loop run above. The browser walkthrough starts at step 0/M1 once Forge
has a URL.

## Remaining gaps
- The file ledger is single-host. Hosted/Vercel use needs a durable distributed
  ledger; until then the route refuses to run on Vercel and in production.
- Call limits (1 in flight, 3/min, 3 per process) are per process.
- Router rates are constants checked 2026-11-10; they need re-checking before raising caps.
- Byte-based input bounds are deliberately pessimistic (about 10x over at this size).
- Forge's own per-user `SpendLedger` still pre-charges an estimate; it does not yet use
  the Router's `usage.costUsd` (`RouterLlmClient.lastCall` now exposes it, for M3).
- The server's WebSocket path for non-mock clients uses `runAgentic`, not `LlmPlanner`.
  Step 1 proved the `LlmPlanner` loop; `runAgentic` over the Router is not yet proven live.
- Pre-existing failing test `src/workspace/agent.test.ts` (on base and main).
- Before any hosted use, revoke or rotate the step-1 Forge app token.
