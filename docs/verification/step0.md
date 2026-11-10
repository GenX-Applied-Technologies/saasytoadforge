# Step 0 (M0 hosting) verification — DRAFT, not done

Date: 2026-11-10 (America/Detroit). Branch `feature/forge-staging-host`, stacked on
`feature/router-llm-client` (PR 10). Router side: genx-router-os branch
`feature/forge-shared-spend-ledger` (stacked on PR 28), see its `docs/verification/step0-router.md`.
Status: built and unit-tested. NOT deployed, NOT paid for, NO Tester walkthrough yet, so per
the done rule this milestone is **not done**.

## What was built
- `apps/agent-service/fly.staging.toml`: one shared-cpu-1x/512 MB machine in iad, one 1 GB
  volume at /data, auto-stop, `/ready` health check, `FORGE_DEPLOY_ENV=staging`.
- Dockerfile: non-root runtime (`docker-entrypoint.sh` chowns the volume then drops root and
  all capabilities via `setpriv`), `FORGE_BUILD_SHA` build arg, direct `tsx` start (no
  corepack download at runtime).
- `assertStagingEnv` (packages/shared): staging fails closed on missing/weak config, direct
  model keys, Stripe keys, or a mock sandbox; `FORGE_DEPLOY_ENV=production` always refused.
- `/health` now reports version/deployEnv/region; new `/ready` (200 only on the Router model
  client + a real sandbox provider).
- `GENX_ROUTER_PROTECTION_BYPASS`: optional Vercel protection bypass header, sent only to the Router.
- Secret scripts (`apps/agent-service/scripts/staging/`): `new-secret.sh`,
  `import-fly-secrets.sh` (stdin only, fingerprints only, rotation guard), `deploy.sh`
  (refuses without `FORGE_STAGING_APPROVED=yes`, enforces 1 machine and no dedicated IPv4),
  `teardown.sh`.
- Token rotation: a NEW staging token was generated into
  `/workspace/forge-game-proof/.secrets/staging/GENX_ROUTER_FORGE_TOKEN` (mode 600,
  fingerprint `99f5b2b0a638`), plus `AGENT_SERVICE_SECRET` (fingerprint `87d63d9ee7ee`).
  Neither is set anywhere hosted yet. The local step-1 token is refused by hash.
- Router: shared Postgres spend ledger so the Router preview can serve a hosted Forge
  (migration 0040 prepared, not applied).

## Proven vs. not proven
| Item | Status | Evidence |
| --- | --- | --- |
| Staging env refusals (13 cases) and production refusal | proven (unit) | `packages/shared/src/env.test.ts` |
| Server refuses to boot on incomplete staging config; boots on Router client + real provider | proven (unit) | `server.test.ts` |
| Real start command (`docker-entrypoint.sh` → `tsx src/index.ts`, non-root path) boots in staging mode locally; `/health` shows the build sha; `/ready` 200; missing E2B key → exit 1 with the named refusal | proven (local process, fake values, no network calls) | command run 2026-11-10 11:2x ET |
| Secret import sends values only on stdin; refuses local token, bad modes, multi-line values, forbidden names | proven (unit, `fly` replaced by a recording stub) | `staging-scripts.test.ts` |
| Protection-bypass header sent only when configured | proven (unit, fetch mocked) | `router-llm.test.ts` |
| Docker image builds; `setpriv` drop works in the image | NOT proven (no Docker on the box; Fly remote builder needs a Fly login) | — |
| Fly app, machine, volume, secrets, TLS URL | NOT proven (paid, awaiting Ron) | — |
| Router preview with the Postgres ledger + new token | NOT proven (migration not applied, env not set) | — |
| M0 real-browser walkthrough by Tester (Rule A) | NOT run | — |

## Test-suite fix found on the way
The long-standing "runs the canonical task" failure (agent.test.ts) was not a code bug: the box
shell carries a real `GEMINI_API_KEY`, so `createLlmClient` chose the live Gemini client inside a
unit test. `apps/agent-service/vitest.setup.ts` now clears every provider key before tests, and
the full suite is green (36 files, 265 tests). Earlier full-suite runs on this box may have sent
a few real Gemini requests through that key (cost unknown, at most cents; not through the Router).

## Accounts and keys (names only, checked 2026-11-10)
- Fly: `flyctl` v0.5.6 installed on the box; `fly auth whoami` → not logged in. No `FLY_*`
  variables, no Fly org known. Fly has no free tier, no spend cap and no billing alerts.
- E2B: no `E2B_API_KEY` anywhere checked (box env, Router and Forge-web Vercel projects); no E2B CLI login.
- Router Vercel (`genx-router-os`): has `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`
  (production+preview), `ROUTER_OS_OPERATOR_TOKEN`, `VERCEL_AUTOMATION_BYPASS_SECRET`
  (production). Missing for this step: `ROUTER_OS_FORGE_APP_TOKEN`, `ROUTER_OS_FORGE_CODING_ENABLED`,
  `TOGETHER_API_KEY`, `ROUTER_OS_FORGE_SPEND_CAP_USD`, `ROUTER_OS_FORGE_SPEND_LEDGER`, `ROUTER_OS_FORGE_SPEND_SCOPE` (preview).
- Forge web Vercel (`saasytoadforge-web`): preview has only `PORT`, `AGENT_SERVICE_SECRET`.
  Missing on preview: `NEXT_PUBLIC_AGENT_SERVICE_URL`, Supabase auth variables. The
  `saasytoadforge` Supabase project is paused (INACTIVE); the walkthrough's sign-in needs it restored.

## Paid step: Fly staging host
Pricing read 2026-11-10 from fly.io/docs/about/pricing (iad):
| Item | Price | This plan |
| --- | --- | --- |
| shared-cpu-1x 512 MB, started | $3.69 per 30 days (~$0.0051/hour, billed per second) | 1 machine, auto-stops when idle |
| Stopped machine rootfs | $0.15/GB/month | image rootfs ≤ ~1 GB → ≤ $0.15 |
| Volume | $0.15/GB/month provisioned | 1 GB → $0.15 |
| Volume snapshots | first 10 GB/month free | ≈ $0 |
| Shared IPv4 + IPv6, fly.dev cert, builders/registry | free | used |
| Dedicated IPv4 | $2/month | not used (deploy.sh refuses) |
| Outbound data (North America) | $0.02/GB | a few GB at most |
| Trial credit | $1, 7 days, new accounts | may apply |
| Personal-org waiver | bills under $5/month waived | applies only to a personal org |
- Expected: about $0.30–$1.50 for a month of walkthrough use (auto-stop); worst case if
  it never stops: $3.69 + $0.15 + $0.15 + ~$0.10 egress = **$4.09 per 30 days**.
- Proposed hard cap: **$5 for 30 days**, then tear down unless Ron renews.
- Enforcement: Fly offers no spending cap, so the cap is enforced by shape and time: exactly one
  fixed-size machine (`deploy.sh` runs `fly scale count 1`, `--ha=false`), one 1 GB volume, no
  dedicated IPv4 (checked), no Managed Postgres/extensions; worst-case math above stays under
  $5; `teardown.sh destroy` on day 30 (or `stop` any time) ends all charges.
