# Staging HTTP QA fixes (Tester run 1, F-1 through F-6)

Branch `feature/forge-e2b-sandbox`, PR #12. Not merged.

Tester's zero-spend report: `/workspace/tester/forge/staging-run1-backend.md` against
image `ef6b943`. These fixes close F-1 through F-6.

## Fixes

- **F-1 MAJOR.** `MockBillingProvider.handleWebhook` now throws `BillingNotConfiguredError`
  instead of returning `null` (which made `POST /webhooks/stripe` answer `200 {received:true}`
  for a fake signature). The route answers **501** `{error:'billing not configured'}` when
  billing is mock/unconfigured, and **400** `{error:'invalid signature'}` when a live Stripe
  provider is configured but the signature is bad. No unverified billing route accepts an
  event. **Ron uses Square, not Stripe.** The path is still Stripe-named; a Square provider
  is not built here.
- **F-2.** Malformed JSON on `/webhooks/stripe` and other JSON POSTs maps to
  **400** `{error:'invalid json'}`. The raw parser message is never returned.
- **F-3.** A known path with the wrong method returns **405** and an `Allow` header. Unknown
  paths stay 404.
- **F-4.** Full `GET /config` (model IDs, spend caps, secret-present flags) requires a signed
  agent token. `GET /config/public` is the harmless subset
  `{service, billingConfigured}` for anything the web app needs without auth. The web client
  `getConfig()` now uses the authenticated call.
- **F-5.** `@fastify/helmet` **13.2.0** (MIT) sets HSTS, `X-Content-Type-Options: nosniff`,
  CSP (`default-src 'none'`, `frame-ancestors 'none'`), `Referrer-Policy: no-referrer`, and
  `X-Frame-Options: DENY`.
- **F-6.** Fastify `routerOptions.ignoreTrailingSlash` so `GET /health/` matches `/health`.

## Tests

`pnpm` / `vitest run --project agent-service`: **29 files, 257 tests, all passed**.
`pnpm --filter @forge/agent-service typecheck` and `@forge/web typecheck` passed.

Failure-path coverage includes: mock webhook 501 (including `t=1,v1=deadbeef`), live Stripe
provider with a forged signature 400, missing signature on mock 501, malformed JSON 400 on
the webhook and on `POST /health`, 405 + Allow on `POST /health` and `GET /webhooks/stripe`,
404 without Allow on an unknown path, unauthenticated `/config` 401, public subset only,
security headers on `/health`, and `/health/` 200.

Shipped code contains no test mocks. The mock billing provider is the unconfigured fallback
and now refuses webhooks.

## Staging

Redeployed 2026-11-10, 3:05–3:08 PM ET (America/Detroit) with
`apps/agent-service/scripts/staging/deploy.sh` (`--depot=false`). Builder
`fly-builder-marbled-island-924` was destroyed after the deploy. No leftover
builders. Image version **889060626a4b6efc3aebdc99947c72ab935c26cb**.
URL: https://saasytoad-forge-agent-staging.fly.dev

`GET /health` 200: `version=889060626a4b6efc3aebdc99947c72ab935c26cb`,
`deployEnv=staging`, `region=iad`. `GET /ready` 200, ready true (genx-router, real, ledger ok).

### Per-fix curl (2026-11-10, ~3:08 PM ET)

- **F-1** `POST /webhooks/stripe` with `stripe-signature: t=1,v1=deadbeef` → **501**
  `{"error":"billing not configured"}` (not 200 `{received:true}`).
- **F-2** malformed JSON on `POST /webhooks/stripe` and `POST /health` → **400**
  `{"error":"invalid json"}` (no raw parser message).
- **F-3** `POST /health` → **405**, `Allow: GET, HEAD`. `GET /webhooks/stripe` → **405**,
  `Allow: POST`.
- **F-4** `GET /config` unauthenticated → **401** `{"error":"unauthorized"}` (no model IDs,
  caps, or secret flags). `GET /config/public` → **200**
  `{"service":"agent-service","billingConfigured":false}`.
- **F-5** headers on `/health`: `strict-transport-security: max-age=31536000; includeSubDomains`,
  `x-content-type-options: nosniff`, CSP includes `default-src 'none'` and
  `frame-ancestors 'none'`, `referrer-policy: no-referrer`, `x-frame-options: DENY`.
- **F-6** `GET /health/` → **200**, same body as `/health`.

Raw transcript (no secrets): `/workspace/forge-game-proof/step2-run/http-qa-curl.txt`.

### Added Fly cost for this redeploy

Builder was a shared-cpu-8x / 8 GB machine for about 2 min 50 s
($53.57 / 30 days ≈ $0.0000207/s) ≈ **$0.0035**. Staging machine ran a few minutes
for health/curl at $0.0051/hour ≈ **$0.0002**. Volume was already allocated
($0.15/month, unchanged). **Added this deploy: about $0.004.** Still inside the
approved $5 Fly cap. Monthly shape unchanged (worst case never-stop ≈ $4.09 / 30 days).
