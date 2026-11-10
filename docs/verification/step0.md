# Step 0 (M0 hosting) verification — DRAFT, not done

Date: 2026-11-10 (America/Detroit). Branch `feature/forge-staging-host`, stacked on
`feature/router-llm-client` (PR 10). Router side: genx-router-os branch
`feature/forge-shared-spend-ledger` (stacked on PR 28), see its `docs/verification/step0-router.md`.
Status: **Fly staging host is deployed** (2026-11-10, America/Detroit). The Tester real-browser
walkthrough has not run, and hosted Forge→Router coding is not wired (migration 0040 stays off
the production Router database), so per the done rule this milestone is **not done**.

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
| Docker image builds; `setpriv` drop works in the image | image built on Fly remote builder (421 MB) and booted | deploy 2026-11-10 ~2:47 PM ET; `/health` 200 |
| Fly app, machine, volume, secrets, TLS URL | **proven live** | https://saasytoad-forge-agent-staging.fly.dev `/health` 200, `/ready` 200 |
| Router preview with the Postgres ledger + new token | NOT proven (migration not applied, env not set) | — |
| M0 real-browser walkthrough by Tester (Rule A) | NOT run | — |

## Test-suite fix found on the way
The long-standing "runs the canonical task" failure (agent.test.ts) was not a code bug: the box
shell carries a real `GEMINI_API_KEY`, so `createLlmClient` chose the live Gemini client inside a
unit test. `apps/agent-service/vitest.setup.ts` now clears every provider key before tests, and
the full suite is green (36 files, 265 tests). Earlier full-suite runs on this box may have sent
a few real Gemini requests through that key (cost unknown, at most cents; not through the Router).

## Accounts and keys (names only, checked 2026-11-10)
- Fly: `flyctl` v0.5.6; `fly auth whoami` → saasytoad@gmail.com; org **Ronald Strickland**
  (`personal`). No `FLY_*` variables in the environment. Fly has no spend cap or billing alerts.
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


## Paid deploy run log — 2026-11-10, 2:42–2:51 PM ET (America/Detroit)

Approved by Ron, 2:17 PM ET, word for word "yes run it" (E2B cap $3, Fly cap $5). Logged in
as saasytoad@gmail.com on the personal org. Migration 0040 was **not** applied to the
production Router database (`akzotzmwcaqksgwerzqb`).

Deployed app: `saasytoad-forge-agent-staging` (hostname
https://saasytoad-forge-agent-staging.fly.dev). One `shared-cpu-1x` 512 MB machine in `iad`
(`84ed415b36eed8`), one 1 GB volume `forge_staging_data` (`vol_vz86ekon8m35y8jv`),
`auto_stop_machines = "stop"`, `min_machines_running = 0`. Shared IPv4 `66.241.124.237` +
dedicated IPv6 only (no $2/month dedicated IPv4). Secrets staged by fingerprint only:
`AGENT_SERVICE_SECRET` `87d63d9ee7ee`, `GENX_ROUTER_FORGE_TOKEN` `99f5b2b0a638`,
`E2B_API_KEY` `c3f12582a24e`, `ALLOWED_ORIGINS` `b3379b368d2a`, `GENX_ROUTER_URL` `ebb320399c6f`.

Live checks (2:47 PM ET):
- `GET /health` 200: `status=ok`, `version=b8b58ffd8acd8415f9c895f05240ee38b162335e`,
  `deployEnv=staging`, `region=iad`
- `GET /ready` 200: `modelClient=genx-router`, `sandbox=real`, `sandboxLedger=ok`

Fixes found while deploying (in this commit):
- `fly.staging.toml` Dockerfile path is relative to the config file (`Dockerfile`), not the
  repo root. `apps/agent-service/Dockerfile` was resolved as a missing nested path.
- Depot builders timed out on this box; `deploy.sh` now uses `--depot=false` (Fly's own
  remote builder).
- The remote builder is a **shared-cpu-8x / 8 GB** machine (`$53.57/30 days` if left running).
  One was created at 2:45:50 PM ET, ran about 5 minutes, and was destroyed immediately after
  the deploy. `deploy.sh` now destroys leftover `fly-builder-*` apps after every deploy.

Cost so far (published iad rates, 2026-11-10; no Fly invoice pulled):
- Remote builder, ~5 minutes at `$53.57/30 days` ≈ **$0.006** (app destroyed, volume gone).
- Staging machine, started 2:47 PM ET, `shared-cpu-1x` 512 MB at `$3.69/30 days`
  (`$0.0051/hour`) while running, then auto-stops when idle.
- Staging volume, 1 GB, **$0.15/month** from creation (2:42 PM ET).
- IPs and fly.dev cert: $0.
- Estimated Fly spend so far: **a few cents**. Leftover monthly shape stays under the $5 cap
  (worst case if the staging machine never stops: $4.09/30 days). This org is `personal`;
  Fly's under-$5 waiver may apply, but the cap is still enforced by shape and teardown.

### Teardown
```
apps/agent-service/scripts/staging/teardown.sh stop      # stop compute; volume still bills ~$0.15/mo
apps/agent-service/scripts/staging/teardown.sh destroy   # delete app + volume (all staging billing ends)
# If a later deploy leaves a builder running:
fly apps destroy fly-builder-<name> --yes
```

### Not yet done (needs Ron)
- Hosted Forge→Router coding on this Fly host: the Router preview is Vercel SSO-protected,
  Vercel accepts only the Postgres ledger, and migration 0040 must not be applied to the
  production Router database. The Phaser game proof used a **local** Router with a file ledger.
- Tester real-browser walkthrough (Rule A).
- The staging `GENX_ROUTER_FORGE_TOKEN` is on Fly but not set on a working hosted Router.
- Merge of this PR, custom domains, or anything customer-facing.
