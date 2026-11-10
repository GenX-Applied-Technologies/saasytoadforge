# Forge Architecture

Living document. Updated as the system takes shape.

## System shape

```
                 +-------------------------------------------+
   Browser  <->  |  apps/web  (Next.js 15 App Router, Vercel)|
                 |  3-pane IDE: tree | Monaco | xterm | agent |
                 +----------------------+--------------------+
                          REST + WebSocket (ws)
                                        |
                 +----------------------v--------------------+
                 |  apps/agent-service (Fastify, Railway/Fly)|
                 |  websockets, agent loop, sandbox orchestr.|
                 +-----+-------------------+-----------------+
                       |                   |
            ModelRouter|                   | SandboxProvider
        (OpenRouter)   |                   | (E2B microVM / mock)     
                       v                   v
                 +-----------+      +----------------------+
                 | OpenRouter|      | Isolated sandbox     |
                 | fast /    |      | - file system (truth)|
                 | frontier /|      | - shell (pty)        |
                 | fusion    |      | - egress allowlist   |
                 +-----------+      +----------------------+

   Persistence: Supabase Postgres (users, workspaces, sessions, artifacts,
   spend ledger) + Supabase Auth + RLS.
```

## Workspaces (pnpm)
- `apps/web` - Next.js 15 (App Router), TypeScript strict, Tailwind v4. Deploys to Vercel.
- `apps/agent-service` - Fastify service for websockets, the agent loop, and sandbox
  orchestration. Vercel functions are too short-lived for long agent runs, so this is a
  separate long-lived host (Railway/Fly).
- `packages/shared` - cross-cutting TypeScript: env schema (zod), `SandboxProvider`
  interface, shared domain types. Consumed as source.

## Key interface: SandboxProvider
`packages/shared/src/sandbox.ts`. Untrusted/agent-generated code runs ONLY through this
abstraction. Implementations: `mock` (dev/tests only; refused when NODE_ENV=production) and `e2b`
(Firecracker microVM, SDK 2.x network rules, fail-closed sandbox-time cap; see
docs/verification/step2.md). Callers never touch a provider SDK directly.

## Security model (see Hard Constraints, mission section 6)
- **Isolation**: host never runs untrusted code; microVM/gVisor only. Plain Docker is not an
  acceptable boundary.
- **Egress**: default-deny per sandbox; allowlist = package registries + user-declared domains.
- **Side-effect approvals**: read/plan/edit/test run freely in-sandbox; `git push`, deploy,
  global installs, out-of-allowlist network, deletes, and payments require explicit approval.
- **Secrets**: env-only, never in repo/prompts/logs; injected into sandboxes only as
  allowlisted vars.
- **Spend**: per-user + global caps checked before each model call, backed by a Postgres ledger.

## Model routing (`ModelRouter`)
Config-driven (env-overridable, never hardcoded in logic):
- fast - inline edits, routine steps
- frontier - planning, multi-file work, review
- deep (gated) - OpenRouter Fusion; user-triggered only, capped, degrades to frontier.

## Build/verify
- `pnpm lint` (eslint flat) · `pnpm test` (vitest workspace) · `pnpm build` (`-r`, topological).
- `pnpm test:e2e` (Playwright) from Phase 1.
- CI: `.github/workflows/ci.yml` runs lint + test + build on push/PR.

## Layers (built, verified on mocks)
- **Auth** (`apps/web/src/lib/auth`): `AuthProvider` interface + `DevAuthProvider` (scrypt +
  cookie sessions) + middleware gate. Supabase Auth is the drop-in.
- **Agent runtime** (`apps/agent-service/src/agent`): `Planner` + `LlmClient` (mock +
  streaming OpenRouter) + `Agent` loop + scoped `ToolSet` (fs/terminal/browser).
- **Safety/cost** (`apps/agent-service/src/lib`): egress default-deny, spend ledger + caps,
  secret-redacting logger.
- **Billing** (`apps/agent-service/src/billing`): `BillingProvider` + flat `PLANS`. Stripe drop-in.
- **Persistence**: in-memory today; Supabase schema + RLS in `supabase/migrations/0001_init.sql`.

## Status
Phases 0-4 complete and verified on mocks. Phase 5 scaffolded (auth flow works on the dev
provider; deploy configs + schema + billing + smoke test in place). Stops before real
SUPABASE_*/STRIPE_* wiring and the first prod deploy (mission section 2.4). See PROGRESS.md.
