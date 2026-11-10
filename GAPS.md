# Gap audit (2026-06-15)

Findings from a three-lens review (security/multi-tenancy, correctness/bugs,
feature-completeness) with disposition. "Fixed" = closed + tested this pass.

## Fixed this pass
- **P0 agent-service had no auth/authz; workspaces had no owner** -> signed per-user
  tokens (HMAC, `packages/shared/src/token.ts`), an onRequest auth hook + WS `?token=`
  check, `Workspace.owner`, ownership enforced in every route (cross-tenant access now
  404s). Web mints tokens at `/api/agent-token`; the client attaches them. Tested
  (`workspace/api.test.ts` cross-tenant + 401 cases, all e2e).
- **CORS reflected any origin** -> pinned to `ALLOWED_ORIGINS` (default `localhost:3000`).
- **WebSockets had no origin/auth** -> validated via `?token=`.
- **Session cookie missing `secure`** -> set in production.
- **Spend cap keyed by workspace (bypassable via new workspaces)** -> keyed by user id.
- **Concurrent tasks corrupted session/approval state** -> a `running` guard rejects a
  second task; the loop is per-run.
- **ApprovalGate leaked pending promises on disconnect** -> `rejectAll()` on socket close.
- **Shell route: unhandled `openShell` throw** -> try/catch + clean close.
- **Sandboxes never destroyed (leak) + no workspace delete** -> `DELETE /workspaces/:id`
  wired to `destroy`, plus a delete button on the workspaces list.
- **File tree never refreshed after agent edits** -> a `fileVersion` counter re-fetches
  the root listing on each `edit`.
- **EditorPane debounced-save timers never cleared on unmount** -> cleanup effect.

## Fixed in Phase 5
- **Supabase is schema-only** -> Swapped out `DevAuthProvider` and `InMemorySessionStore` for actual `@supabase/supabase-js` implementations, querying the Postgres DB directly.
- **Stripe has no real provider** -> Wired up `stripe` Node SDK, connecting the subscriptions to the live API via `StripeBillingProvider`. Added the basic `/webhooks/stripe` POST route.
- **No rate limiting** -> Wired up `@fastify/rate-limit` on the agent-service to prevent abuse, capped at 100 requests per minute.
- **Sessions/artifacts grow unbounded** -> They are now stored in Postgres, no longer constrained by Node memory limits.

## Known gaps — honestly documented, not yet closed
These need real infra/secrets or are deliberately deferred. Do not claim them as done.
- **E2B egress is implemented but not yet proven live.** The provider uses E2B SDK 2.x
  network rules (deny all / exact-hostname allowlist, no DNS server) with read-back
  verification; tested only against a fake E2B API. The live proof is a paid step
  (docs/verification/step2.md). E2B filters by HTTP Host / TLS SNI on ports 80/443; other
  ports to an allowed name are not reachable.
- **Spend is a fixed pre-charge estimate**, never reconciled to real token usage from the
  model response. A long run can overrun the cap within one task.
- **"Fusion" deep reasoning is routing only** — it swaps the model id and inflates the cost
  estimate; there is no panel/judge multi-model orchestration.
- **Screenshots default to the simulated SVG** (`MockBrowserTool`); the real
  `PlaywrightBrowserTool` exists but is not the wired default.
- **No file CRUD in the tree** (create/delete/rename) and **no session-history browser** UI.
- **Only the E2B provider is real.** Daytona was removed from the config (it was a stub that
  silently fell back to the mock); selecting e2b without its key/cap/data dir now refuses to boot.
- **Lighthouse perf gate** runs at deploy against the real editor route.
