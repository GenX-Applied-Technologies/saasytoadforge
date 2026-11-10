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

Redeployed with `apps/agent-service/scripts/staging/deploy.sh` (`--depot=false`, builders
destroyed after). Curl evidence and added Fly cost are recorded after that deploy.
