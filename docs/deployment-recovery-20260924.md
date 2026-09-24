# Forge backend deployment recovery

## Confirmed failure

The latest production attempt for the Vercel project `saasytoadforge-agent-service` built the Next.js web app and then failed looking for `/vercel/path0/apps/agent-service/apps/web/.next`. This project inherited the website build settings while its root was the agent-service directory. A successful website build does not start the Fastify backend.

The existing backend is a long-running Fastify server with WebSocket agent/shell connections. Its intended targets are Railway or Fly. The repository already has `railway.json` and `apps/agent-service/Dockerfile`; Fly now selects that same lean Dockerfile. Use the repository root as Docker build context so packages/shared and the workspace lockfile are present.

## Ready configuration

- Railway: root directory `/`, Dockerfile `apps/agent-service/Dockerfile`, health path `/health`, port 8787 (or supplied PORT).
- Fly: `fly.toml` selects that Dockerfile and forwards to port 8787.
- Web on Vercel: use repository root with root `vercel.json`, or root `apps/web` with its own `vercel.json`. Point NEXT_PUBLIC_AGENT_SERVICE_URL at the actual backend origin and rebuild the web app after changing it.
- Set a strong shared AGENT_SERVICE_SECRET on web and backend, and ALLOWED_ORIGINS to the exact web origin. Configure the intended Supabase project on both services. Keep Stripe disabled until a separate billing test.
- For a real coding session, configure E2B_API_KEY and a supported model provider, then set SANDBOX_PROVIDER=e2b. An empty EGRESS_ALLOWLIST denies internet in the current E2B adapter. A nonempty list enables internet broadly; it does not enforce individual domains. Do not treat it as a verified domain firewall.

## Checks completed

Frozen pnpm install, workspace typecheck, and all 202 tests across 33 files passed. This proves the existing code/tests compile and run. No live E2B coding session or hosted backend was verified. Neither Railway nor Fly CLI/account access is configured on the connected Mac, and no new paid service was created.

## First hosted check

1. Deploy this existing backend configuration through the chosen connected Railway/Fly account.
2. Verify /health and /config identify the intended backend, real sandbox/model providers and storage configuration.
3. Confirm requests without a signed user token are refused. Sign in through the web app and create a disposable workspace.
4. Run one small file edit, a shell command and its tests through the WebSocket session. Verify the diff belongs to that workspace and reconnect after a page reload.
5. Stop the test workspace and verify cleanup and retained activity records.

Do not delete or repurpose the duplicate Vercel backend projects as part of this patch. They remain evidence of the failed configuration until the replacement backend is verified.
