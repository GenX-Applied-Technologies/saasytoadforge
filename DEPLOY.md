# Deploying SaaSyToad Forge

This is a pnpm monorepo with two apps:

- `apps/web` — the Next.js front end. **This is what Vercel deploys.**
- `apps/agent-service` — a long-running Fastify WebSocket server. **Vercel cannot host this**
  (it is not serverless). Run it on Railway, Fly, Render, or a VM via the included Dockerfile,
  and point the web app at it via `NEXT_PUBLIC_AGENT_SERVICE_URL`.

## Hosting the agent-service (Docker)

`apps/agent-service/Dockerfile` builds the server. The build context MUST be the repo root
(it needs `packages/shared` and the workspace lockfile). It runs on port `8787` and exposes
`/health`.

Local sanity check:

```
docker build -f apps/agent-service/Dockerfile -t forge-agent .
docker run -p 8787:8787 --env-file apps/agent-service/.env forge-agent
# then: curl http://localhost:8787/health  ->  {"status":"ok","service":"agent-service"}
```

### Fly.io

> Staging host for the Forge program: use `apps/agent-service/fly.staging.toml` and the
> scripts in `apps/agent-service/scripts/staging/` (see `docs/staging-hosting.md`). The
> commands below are the older generic path.

```
fly launch --no-deploy --config apps/agent-service/fly.toml   # pick a unique app name
fly secrets set OPENROUTER_API_KEY=... SUPABASE_URL=... SUPABASE_SERVICE_ROLE_KEY=... \
  STRIPE_SECRET_KEY=... STRIPE_WEBHOOK_SECRET=... AGENT_SERVICE_SECRET=... E2B_API_KEY=... \
  ALLOWED_ORIGINS=https://YOUR-forge-web.vercel.app --config apps/agent-service/fly.toml
fly deploy --config apps/agent-service/fly.toml
```

Run these from the repo root so the Docker context is correct.

### Railway / Render

- **Root Directory: the repo root** (NOT `apps/agent-service` — the build needs `packages/shared`).
- **Dockerfile path:** `apps/agent-service/Dockerfile`.
- **Health check path:** `/health`. **Port:** `8787`.
- Add the same env vars as above as service variables.

### After it is hosted

1. Set `NEXT_PUBLIC_AGENT_SERVICE_URL` in the Forge web (Vercel) project to the agent-service URL.
2. Set `ALLOWED_ORIGINS` on the agent-service to the Forge web origin (CORS + websocket).
3. Use the SAME `AGENT_SERVICE_SECRET` on both the web app and the agent-service.

## Vercel: pick ONE root-directory pattern

The deploy fails with `output directory ... was not found` when the Vercel project's
**Root Directory** does not match where the build writes `.next`. Two clean options:

### Option A — Root Directory = `apps/web` (recommended)

In the Vercel project: Settings -> Build and Deployment -> Root Directory -> set to `apps/web`.
Vercel reads `apps/web/vercel.json`, auto-detects Next.js, runs `next build`, and serves `.next`.
The pnpm workspace (including `@forge/shared`) installs from the repo root automatically.

### Option B — Root Directory = empty (repo root)

Leave Root Directory blank. Vercel reads the repo-root `vercel.json`, which runs
`pnpm --filter @forge/web build` and serves `apps/web/.next`.

Either works; do not mix them. If you switch to Option A you can ignore the root `vercel.json`
(it is only read when Root Directory is the repo root).

## Required environment variables (Vercel, Forge web project)

- `OWNER_SETUP_SECRET` — required for owner first-login in production. Pick a strong value.
- `NEXT_PUBLIC_AGENT_SERVICE_URL` — the hosted agent-service URL.
- `ADMIN_SESSION_SECRET` — optional; if unset, a key is derived from `SUPABASE_SERVICE_ROLE_KEY`.
- Supabase + Stripe + model keys as documented in `.env.example`.

## Marketing site

The marketing site (separate repo `iamjoejack/saasytoad`) needs `NEXT_PUBLIC_FORGE_URL`
set to this app's domain so its "sign in" links resolve.
