import Fastify, {
  type FastifyInstance,
  type FastifyReply,
  type FastifyRequest,
  type FastifyPluginAsync,
} from 'fastify'
import cors from '@fastify/cors'
import websocket from '@fastify/websocket'
import rateLimit from '@fastify/rate-limit'
import {
  parseServerEnv,
  parseEgressAllowlist,
  secretStatus,
  verifyAgentToken,
  isOwnerEmail,
  type SandboxProvider,
  type ServerEnv,
  type AgentCommand,
  type AgentEvent,
  type ConfigSummary,
  type DeployResult,
} from '@forge/shared'
import { createSandboxProvider } from './sandbox'
import { WorkspaceManager, type Workspace } from './workspace/manager'
import { assertSafePath, PathError } from './lib/paths'
import { Agent, ApprovalGate, QuestionGate } from './agent/agent'
import { createLlmClient, type LlmMessage } from './agent/llm'
import { runAgentic, DISCOVERY_DIRECTIVE } from './agent/agentic'
import { reviewWorkspace } from './agent/ronald'
import { createPlanner } from './agent/planner'
import { createToolSet, MockBrowserTool, type BrowserTool } from './agent/tools'
import { SpendLedger, costForTokens, type SpendCaps } from './lib/spend'
import { modelRouting, resolveDeepModel, DEEP_REQUEST_CAP_USD } from './agent/router'
import { logger } from './lib/logger'
import { createBillingProvider } from './billing/billing'
import { InMemorySessionStore } from './persistence/store'
import { SupabaseSessionStore } from './persistence/supabase-store'

declare module 'fastify' {
  interface FastifyRequest {
    userId?: string
    userEmail?: string
    /** Raw request body, captured for Stripe webhook signature verification. */
    rawBody?: Buffer
  }
}

export interface ServerDeps {
  provider: SandboxProvider
  browser: BrowserTool
  ledger: SpendLedger
}

// /webhooks/stripe is public to the auth hook because Stripe sends no Bearer token;
// it authenticates instead by verifying the Stripe signature against the raw body.
const PUBLIC_PATHS = new Set(['/health', '/config', '/billing/plans', '/webhooks/stripe'])
const WS_ROUTE = /\/workspaces\/[^/]+\/(shell|agent)$/

/** Estimated tokens per agent run, feeding the spend-cap pre-charge. */
const FRONTIER_EST_TOKENS = 2300
const DEEP_EST_TOKENS = 9000

/** Port the deployed app is expected to serve on, and the host E2B maps to a public URL. */
const APP_PORT = 3000
/** How long to wait for the started app to answer before calling the deploy not-live. */
const SERVE_PROBE_SECONDS = 25

/**
 * Start the built app and wait for it to actually answer on APP_PORT.
 *
 * A successful build says nothing about whether a server is listening, so this is what
 * separates "deployed" from "compiled". Already-running is fine: the probe short-circuits
 * and no second process is started.
 */
async function serveWorkspace(
  provider: SandboxProvider,
  sandboxId: string,
): Promise<{ ok: boolean; logs: string }> {
  const probe =
    `for i in $(seq 1 ${SERVE_PROBE_SECONDS}); do ` +
    `curl -sf -o /dev/null http://localhost:${APP_PORT} && exit 0; sleep 1; done; exit 1`
  const probeTimeoutMs = (SERVE_PROBE_SECONDS + 15) * 1000

  const already = await provider.exec(
    sandboxId,
    `curl -sf -o /dev/null http://localhost:${APP_PORT}`,
  )
  if (already.exitCode === 0) return { ok: true, logs: 'An app was already serving on this port.' }

  // Detached so exec returns immediately; output is kept so a failed start can be reported.
  await provider.exec(
    sandboxId,
    `nohup sh -c 'PORT=${APP_PORT} npm start || PORT=${APP_PORT} npm run dev' ` +
      `> /tmp/forge-serve.log 2>&1 & echo started`,
  )
  const up = await provider.exec(sandboxId, probe, { timeoutMs: probeTimeoutMs })
  if (up.exitCode === 0) return { ok: true, logs: 'App came up on the expected port.' }

  const tail = await provider.exec(sandboxId, 'tail -n 40 /tmp/forge-serve.log 2>/dev/null || true')
  return { ok: false, logs: tail.stdout || tail.stderr || 'No output from the start command.' }
}

export function buildServer(deps?: Partial<ServerDeps>): FastifyInstance {
  const env = parseServerEnv()
  // Fail at boot, not mid-request: a partial Router config, or no model provider in
  // production, refuses to start rather than silently running on the offline mock.
  createLlmClient(env)
  const provider = deps?.provider ?? createSandboxProvider(env)
  const browser = deps?.browser ?? new MockBrowserTool()
  const ledger = deps?.ledger ?? new SpendLedger()
  const egressAllowlist = parseEgressAllowlist(env)
  const workspaces = new WorkspaceManager(provider, egressAllowlist)

  const allowedOrigins = env.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)

  const app = Fastify({ logger: false })

  // Parse JSON ourselves so we can retain the raw bytes for Stripe webhook signature
  // verification. Empty bodies (common on POST/DELETE with no payload) parse to {}.
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    const buf = body as Buffer
    if (buf.length > 0) req.rawBody = buf
    if (buf.length === 0) {
      done(null, {})
      return
    }
    try {
      done(null, JSON.parse(buf.toString('utf8')))
    } catch (err) {
      done(err instanceof Error ? err : new Error('invalid json'), undefined)
    }
  })

  void app.register(cors, {
    origin: allowedOrigins.length > 0 ? allowedOrigins : ['http://localhost:3000'],
  })
  void app.register(rateLimit, {
    max: 100,
    timeWindow: '1 minute',
  })
  void app.register(websocket)
  void app.register(routes(provider, workspaces, env, browser, ledger))

  return app
}

/** userId for the request, guaranteed set by the auth hook for protected routes. */
function userIdOf(req: FastifyRequest): string {
  return req.userId ?? ''
}

/** Full token claims from a websocket upgrade's ?token= query, or null. */
function wsTokenClaims(req: FastifyRequest, secret: string) {
  const token = (req.query as { token?: string }).token ?? ''
  return token ? (verifyAgentToken(token, secret) ?? null) : null
}

/** userId from a websocket upgrade's ?token= query, or null. */
function wsUserId(req: FastifyRequest, secret: string): string | null {
  return wsTokenClaims(req, secret)?.userId ?? null
}

function routes(
  provider: SandboxProvider,
  workspaces: WorkspaceManager,
  env: ServerEnv,
  browser: BrowserTool,
  ledger: SpendLedger,
): FastifyPluginAsync {
  const caps: SpendCaps = {
    perUserUsd: env.SPEND_CAP_USER_USD,
    globalUsd: env.SPEND_CAP_GLOBAL_USD,
    unlimitedMode: false, // toggled per-user via spend_topup_mode command; global default=off
    approvalBlockUsd: 5,
  }
  const secrets = secretStatus(env)
  // Live integrations the agent can wire up, surfaced to the model so it uses the right one.
  const liveConnectors = [
    secrets.supabase && 'Supabase (Postgres database and auth)',
    secrets.stripe && 'Stripe (payments and billing)',
    secrets.resend && 'Resend (transactional email)',
    secrets.zapier && 'Zapier (automation and webhooks)',
    secrets.vercel && 'Vercel (hosting and deploys)',
    secrets.upstashRedis && 'Upstash Redis (cache and queues)',
  ].filter((c): c is string => Boolean(c))
  const billing = createBillingProvider(env)
  const sessionStore =
    env.SUPABASE_URL && env.SUPABASE_SERVICE_ROLE_KEY
      ? new SupabaseSessionStore(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY)
      : new InMemorySessionStore()

  return async (app) => {
    // Auth: every REST route except PUBLIC_PATHS requires a valid signed token.
    // Websocket upgrades authenticate via ?token= in their own handlers.
    app.addHook('onRequest', async (req, reply) => {
      if (req.method === 'OPTIONS') return // CORS preflight
      const path = req.url.split('?')[0] ?? ''
      // Skip ONLY a genuine websocket upgrade to a websocket route (it authenticates via
      // ?token= in its handler). A spoofed Upgrade header on a REST route must still auth.
      if (WS_ROUTE.test(path) && (req.headers.upgrade ?? '').toLowerCase() === 'websocket') return
      if (PUBLIC_PATHS.has(path)) return
      const header = req.headers.authorization ?? ''
      const token = header.startsWith('Bearer ') ? header.slice(7) : ''
      const claims = token ? verifyAgentToken(token, env.AGENT_SERVICE_SECRET) : null
      if (!claims) {
        return reply.code(401).send({ error: 'unauthorized' })
      }
      req.userId = claims.userId
      req.userEmail = claims.email
    })

    app.get('/health', async () => ({ status: 'ok', service: 'agent-service' }))

    app.get('/admin/stats', async (req, reply) => {
      const email = req.userEmail
      const { isAdminEmail } = await import('@forge/shared')
      if (!isAdminEmail(email, env.ADMIN_EMAILS)) {
        return reply.code(403).send({ error: 'forbidden' })
      }
      return {
        workspaces: workspaces.listAll(),
        globalSpend: ledger.globalSpend(),
        caps,
        users: ledger.allSpends(),
      }
    })

    app.get(
      '/config',
      async (): Promise<ConfigSummary> => ({
        models: modelRouting(env),
        sandboxProvider: env.SANDBOX_PROVIDER,
        egressAllowlist: parseEgressAllowlist(env),
        caps: {
          perUserUsd: caps.perUserUsd,
          globalUsd: caps.globalUsd,
          unlimitedMode: caps.unlimitedMode,
          approvalBlockUsd: caps.approvalBlockUsd,
        },
        secrets,
      }),
    )

    app.get('/billing/plans', async () => billing.plans())

    app.post('/billing/checkout', async (req, reply) => {
      const body = req.body as { planId?: unknown; email?: unknown }
      if (typeof body.planId !== 'string' || !billing.plans().some((p) => p.id === body.planId)) {
        return reply.code(400).send({ error: 'unknown planId' })
      }
      // Prefer the verified token email over any client-supplied value.
      const email =
        req.userEmail ?? (typeof body.email === 'string' ? body.email : 'unknown@forge.dev')
      // Credits are NEVER granted here. They are granted only by a verified, paid webhook
      // (see /webhooks/stripe). This route just starts checkout.
      return billing.createCheckout(body.planId, { customerEmail: email })
    })

    app.post('/webhooks/stripe', async (req, reply) => {
      const signature = req.headers['stripe-signature']
      if (typeof signature !== 'string' || !req.rawBody) {
        return reply.code(400).send({ error: 'missing signature or body' })
      }
      let fulfillment
      try {
        fulfillment = await billing.handleWebhook(req.rawBody.toString('utf8'), signature)
      } catch (err) {
        // Bad/forged signature, or webhook secret missing. Refuse, do not fulfil.
        logger.warn('stripe webhook rejected', {
          error: err instanceof Error ? err.message : String(err),
        })
        return reply.code(400).send({ error: 'invalid signature' })
      }
      if (fulfillment?.customerEmail && fulfillment.creditUsd > 0) {
        // Keyed on the Stripe event id: a redelivery of an already-fulfilled event must not
        // grant the credit a second time. Still answer 200 so Stripe stops retrying.
        const granted = ledger.addEmailCredits(
          fulfillment.customerEmail,
          fulfillment.creditUsd,
          fulfillment.eventId,
        )
        logger.info(granted ? 'stripe top-up fulfilled' : 'stripe top-up already fulfilled', {
          email: fulfillment.customerEmail,
          creditUsd: fulfillment.creditUsd,
          plan: fulfillment.planId,
          eventId: fulfillment.eventId,
        })
      }
      return reply.code(200).send({ received: true })
    })

    app.post('/workspaces', async (req) => workspaces.create(userIdOf(req)))

    app.get('/workspaces', async (req) => workspaces.list(userIdOf(req)))

    app.delete('/workspaces/:id', async (req, reply) => {
      const id = (req.params as { id: string }).id
      const ok = await workspaces.destroy(id, userIdOf(req))
      if (!ok) return reply.code(404).send({ error: 'workspace not found' })
      return { ok: true }
    })

    app.get('/workspaces/:id/files', async (req, reply) => {
      const ws = requireWorkspace(workspaces, req, reply)
      if (!ws) return
      const dir = (req.query as { dir?: string }).dir ?? ''
      return provider.listFiles(ws.sandboxId, dir)
    })

    app.get('/workspaces/:id/file', async (req, reply) => {
      const ws = requireWorkspace(workspaces, req, reply)
      if (!ws) return
      const rawPath = (req.query as { path?: string }).path
      if (typeof rawPath !== 'string') {
        return reply.code(400).send({ error: 'path query param is required' })
      }
      try {
        const path = assertSafePath(rawPath)
        const contents = await provider.readFile(ws.sandboxId, path)
        return { path, contents }
      } catch (err) {
        if (err instanceof PathError) return reply.code(400).send({ error: err.message })
        return reply.code(404).send({ error: 'file not found' })
      }
    })

    app.put('/workspaces/:id/file', async (req, reply) => {
      const ws = requireWorkspace(workspaces, req, reply)
      if (!ws) return
      const body = req.body as { path?: unknown; contents?: unknown }
      if (typeof body.path !== 'string' || typeof body.contents !== 'string') {
        return reply.code(400).send({ error: 'path and contents must be strings' })
      }
      try {
        const path = assertSafePath(body.path)
        await provider.writeFile(ws.sandboxId, path, body.contents)
        return { ok: true, path }
      } catch (err) {
        if (err instanceof PathError) return reply.code(400).send({ error: err.message })
        throw err
      }
    })

    app.delete('/workspaces/:id/file', async (req, reply) => {
      const ws = requireWorkspace(workspaces, req, reply)
      if (!ws) return
      const rawPath = (req.query as { path?: string }).path
      if (typeof rawPath !== 'string') {
        return reply.code(400).send({ error: 'path query param is required' })
      }
      try {
        const path = assertSafePath(rawPath)
        await provider.deleteFile(ws.sandboxId, path)
        return { ok: true, path }
      } catch (err) {
        if (err instanceof PathError) return reply.code(400).send({ error: err.message })
        throw err
      }
    })

    app.get('/workspaces/:id/spend', async (req, reply) => {
      const ws = requireWorkspace(workspaces, req, reply)
      if (!ws) return
      return ledger.summary(userIdOf(req), caps, req.userEmail)
    })

    app.get('/workspaces/:id/sessions', async (req, reply) => {
      const ws = requireWorkspace(workspaces, req, reply)
      if (!ws) return
      return sessionStore.listSessions(ws.id)
    })

    app.post('/workspaces/:id/exec', async (req, reply) => {
      const ws = requireWorkspace(workspaces, req, reply)
      if (!ws) return
      const body = req.body as { cmd?: unknown }
      if (typeof body.cmd !== 'string') {
        return reply.code(400).send({ error: 'cmd must be a string' })
      }
      return provider.exec(ws.sandboxId, body.cmd)
    })

    // Ronald reviews the workspace and returns an honest, overridable verdict.
    app.post('/workspaces/:id/review', async (req, reply) => {
      const ws = requireWorkspace(workspaces, req, reply)
      if (!ws) return
      const llm = createLlmClient(env)
      return reviewWorkspace(provider, ws.sandboxId, {
        llm,
        model: modelRouting(env).frontier,
        simulated: ws.sandboxId.startsWith('mock_'),
      })
    })

    // Deploy gated by Ronald's review. The user can force a deploy past a not-ready verdict.
    app.post('/workspaces/:id/deploy', async (req, reply): Promise<DeployResult | undefined> => {
      const ws = requireWorkspace(workspaces, req, reply)
      if (!ws) return
      const body = (req.body ?? {}) as { force?: unknown }
      const force = body.force === true
      const simulated = ws.sandboxId.startsWith('mock_')

      const llm = createLlmClient(env)
      const verdict = await reviewWorkspace(provider, ws.sandboxId, {
        llm,
        model: modelRouting(env).frontier,
        simulated,
      })

      // Held back: review is not ready and the user did not force it.
      if (!verdict.ready && !force) {
        return { deployed: false, blocked: true, simulated, verdict }
      }

      // Mock sandbox has no real hosting. Be honest rather than faking a success.
      if (simulated) {
        return {
          deployed: false,
          blocked: false,
          simulated: true,
          verdict,
          logs:
            'Mock sandbox: the review ran, but no real deployment was performed. ' +
            'Connect a real sandbox (E2B) to build and host this workspace.',
        }
      }

      // Real build + deploy.
      const buildRes = await provider.exec(ws.sandboxId, 'pnpm run build || npm run build')
      if (buildRes.exitCode !== 0) {
        return {
          deployed: false,
          blocked: false,
          simulated: false,
          verdict,
          logs: buildRes.stderr || buildRes.stdout || `Build failed (exit ${buildRes.exitCode}).`,
        }
      }

      // A green build is not a running app. Start the server and confirm the port answers
      // before calling anything live, otherwise the "Open app" link hands the user a dead URL.
      const serving = await serveWorkspace(provider, ws.sandboxId)
      if (!serving.ok) {
        return {
          deployed: false,
          blocked: false,
          simulated: false,
          verdict,
          logs:
            `${buildRes.stdout}\nBuild succeeded, but nothing answered on port ${APP_PORT} ` +
            `within ${SERVE_PROBE_SECONDS}s, so this is not live yet.\n${serving.logs}`,
        }
      }
      return {
        deployed: true,
        blocked: false,
        simulated: false,
        verdict,
        url: `https://${APP_PORT}-${ws.sandboxId}.e2b.dev`,
        logs: `${buildRes.stdout}\nBuild verified and the app is answering on port ${APP_PORT}.`,
      }
    })

    // Streamed shell bridged to the editor terminal (xterm).
    app.get('/workspaces/:id/shell', { websocket: true }, (socket, req) => {
      const userId = wsUserId(req, env.AGENT_SERVICE_SECRET)
      if (!userId) {
        socket.close(1008, 'unauthorized')
        return
      }
      const ws = workspaces.get((req.params as { id: string }).id, userId)
      if (!ws) {
        socket.close(1008, 'workspace not found')
        return
      }
      let shell
      try {
        shell = provider.openShell(ws.sandboxId)
      } catch {
        socket.close(1011, 'could not open shell')
        return
      }
      socket.on('message', (data: Buffer) => void shell.write(data.toString()))
      socket.on('close', () => void shell.close())
      void (async () => {
        for await (const chunk of shell.output) {
          if (socket.readyState === socket.OPEN) socket.send(chunk)
        }
      })()
    })

    // Streamed agent loop: client sends AgentCommand, server streams AgentEvent.
    app.get('/workspaces/:id/agent', { websocket: true }, (socket, req) => {
      const claims = wsTokenClaims(req, env.AGENT_SERVICE_SECRET)
      const userId = claims?.userId ?? null
      if (!userId) {
        socket.close(1008, 'unauthorized')
        return
      }
      const ws = workspaces.get((req.params as { id: string }).id, userId)
      if (!ws) {
        socket.close(1008, 'workspace not found')
        return
      }

      /** Owner accounts (e.g. company founder) bypass ALL spend caps. */
      const isOwner = isOwnerEmail(claims?.email, env.OWNER_EMAILS)

      const approvals = new ApprovalGate()
      const questions = new QuestionGate()
      const spendApprovals = new ApprovalGate() // separate gate for spend confirmations
      const tools = createToolSet(provider, ws.sandboxId, browser)
      const agent = new Agent(tools)
      /** Rolling chat history for this connection, so the window behaves like a chat. */
      const chatHistory: LlmMessage[] = []
      let activeSessionId: string | null = null
      let running = false
      let abort: AbortController | null = null
      /** Per-connection unlimited mode toggle (user sets via Settings UI). */
      let userUnlimitedMode = false

      const send = (event: AgentEvent) => {
        if (activeSessionId) void sessionStore.appendArtifact(activeSessionId, event)
        if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event))
      }

      // On disconnect: stop the in-flight run and unblock any pending approval/question.
      socket.on('close', () => {
        abort?.abort()
        approvals.rejectAll()
        questions.rejectAll()
      })

      socket.on('message', async (data: Buffer) => {
        let cmd: AgentCommand
        try {
          cmd = JSON.parse(data.toString()) as AgentCommand
        } catch {
          return
        }

        if (cmd.type === 'cancel') {
          abort?.abort()
          approvals.rejectAll()
          spendApprovals.rejectAll()
          return
        }
        if (cmd.type === 'approve') {
          approvals.resolve(cmd.id, true)
          return
        }
        if (cmd.type === 'reject') {
          approvals.resolve(cmd.id, false)
          return
        }
        if (cmd.type === 'answer') {
          questions.resolve(cmd.id, cmd.selection)
          return
        }
        // Toggle unlimited mode for this connection (persisted in agent-service memory).
        if (cmd.type === 'spend_topup_mode') {
          userUnlimitedMode = cmd.enabled
          send({
            type: 'message',
            text: userUnlimitedMode
              ? 'Unlimited top-up mode is on. You will be asked before each credit block.'
              : 'Spend cap mode is on. Runs will stop at your credit limit.',
          })
          return
        }
        // Spend top-up approval response: user confirmed a credit extension.
        if (cmd.type === 'spend_topup') {
          const blockUsd = cmd.blockUsd
          ledger.addExtraCredits(userId, blockUsd)
          spendApprovals.resolve(cmd.approvalId, true)
          return
        }
        if (cmd.type !== 'task') return

        if (typeof cmd.task !== 'string' || cmd.task.trim() === '') {
          send({ type: 'error', message: 'task must be a non-empty string' })
          send({ type: 'done', ok: false })
          return
        }
        if (running) {
          send({ type: 'error', message: 'a task is already running' })
          send({ type: 'done', ok: false })
          return
        }

        // Resolve the model client before any spend is recorded. A misconfigured
        // Router (or no provider in production) fails closed with a clear error.
        let llmClient: ReturnType<typeof createLlmClient>
        try {
          llmClient = createLlmClient(env, cmd.customKeys)
        } catch (err) {
          send({ type: 'error', message: err instanceof Error ? err.message : String(err) })
          send({ type: 'done', ok: false })
          return
        }

        // ── Model tier resolution (fusion-safe) ──────────────────────────────
        // modelTier is the new field; deep is kept for backward compat.
        //   fast     → MODEL_FAST      (cheapest, free models)
        //   frontier → MODEL_FRONTIER  (claude-sonnet-4 etc)
        //   fusion   → MODEL_DEEP      (openrouter/fusion — 3 model panel)
        //   custom   → user-provided customModelId
        const tier = cmd.modelTier ?? (cmd.deep ? 'fusion' : 'frontier')
        const routing = modelRouting(env)
        let model: string
        let isFusion = false
        switch (tier) {
          case 'fast':
            model = routing.fast
            break
          case 'frontier':
            model = routing.frontier
            break
          case 'fusion':
            model = resolveDeepModel(env, { fusionAvailable: secrets.openrouter })
            isFusion = true
            break
          case 'custom':
            model = cmd.customModelId ?? routing.frontier
            break
          default:
            model = routing.frontier
        }
        const estUsd = costForTokens(model, isFusion ? DEEP_EST_TOKENS : FRONTIER_EST_TOKENS)

        // Gated deep reasoning is capped per request.
        if (isFusion && estUsd > DEEP_REQUEST_CAP_USD) {
          send({ type: 'error', message: 'Deep reasoning exceeds the per-request cap.' })
          send({ type: 'done', ok: false })
          return
        }
        // Enforce the per-user spend cap         // ── Owner bypass: company accounts get unlimited, uncapped access. ──────
        if (!isOwner) {
          const effectiveCaps: SpendCaps = { ...caps, unlimitedMode: userUnlimitedMode }
          const check = ledger.check(userId, estUsd, effectiveCaps, claims?.email)
          if (!check.allowed) {
            if (check.needsApproval) {
              // Unlimited mode: ask the user before adding a credit block.
              const spendApprovalId = `spend_${Date.now()}`
              const blockUsd = effectiveCaps.approvalBlockUsd ?? 5
              send({
                type: 'approval',
                id: spendApprovalId,
                action: 'Spend credit extension',
                detail:
                  check.approvalDetail ?? `Approve a $${blockUsd.toFixed(2)} credit extension?`,
              })
              const approved = await spendApprovals.request(spendApprovalId)
              if (!approved) {
                send({ type: 'error', message: 'Credit extension declined. Run cancelled.' })
                send({ type: 'done', ok: false })
                return
              }
              const recheck = ledger.check(userId, estUsd, effectiveCaps, claims?.email)
              if (!recheck.allowed && !recheck.needsApproval) {
                send({ type: 'error', message: `Spend cap reached: ${recheck.reason}.` })
                send({ type: 'done', ok: false })
                return
              }
            } else {
              send({ type: 'error', message: `Spend cap reached: ${check.reason}.` })
              send({ type: 'done', ok: false })
              return
            }
          }
        }
        ledger.record(userId, isOwner ? 0 : estUsd)
        running = true
        abort = new AbortController()
        const session = await sessionStore.createSession(ws.id, cmd.task)
        activeSessionId = session.id
        logger.info('agent run', {
          workspace: ws.id,
          session: activeSessionId,
          model,
          tier,
          estUsd,
          owner: isOwner,
        })

        // The built-in /schedule and /grill-me flows are handled by Agent.run regardless
        // of model. Every other task runs the real tool-use loop when a model is available,
        // and the deterministic planner when running on mocks.
        const isSpecial = cmd.task.startsWith('/schedule') || cmd.task.startsWith('/grill-me')
        if (!isSpecial && llmClient.kind !== 'mock') {
          // Discovery interview: only on the first turn of a fresh conversation.
          const interviewing = cmd.interview === true && chatHistory.length === 0
          const task = interviewing
            ? `${DISCOVERY_DIRECTIVE}\n\nUser request: ${cmd.task}`
            : cmd.task
          // On a real sandbox, Ronald reviews the workspace before the agent is allowed to
          // finish. On the mock sandbox the build cannot really run, so skip it rather than
          // spend a review call that can only ever say "could not verify".
          const reviewSimulated = ws.sandboxId.startsWith('mock_')
          void runAgentic(
            {
              task,
              llm: llmClient,
              model,
              tools,
              approvals,
              questions,
              connectors: liveConnectors,
              requireWriteApproval: cmd.requireWriteApproval,
              signal: abort.signal,
              history: chatHistory,
              verify: reviewSimulated
                ? undefined
                : async () => {
                    const verdict = await reviewWorkspace(provider, ws.sandboxId, {
                      llm: llmClient,
                      model: modelRouting(env).frontier,
                      simulated: false,
                    })
                    return { ok: verdict.ready, summary: verdict.summary }
                  },
            },
            send,
          ).finally(() => {
            running = false
          })
        } else {
          const planner = createPlanner(env, llmClient)
          void agent
            .run(
              {
                task: cmd.task,
                planner,
                approvals,
                questions,
                requireWriteApproval: cmd.requireWriteApproval,
                signal: abort.signal,
              },
              send,
            )
            .finally(() => {
              running = false
            })
        }
      })
    })
  }
}

function requireWorkspace(
  workspaces: WorkspaceManager,
  req: FastifyRequest,
  reply: FastifyReply,
): Workspace | undefined {
  const id = (req.params as { id?: string }).id ?? ''
  const ws = workspaces.get(id, userIdOf(req))
  if (!ws) {
    void reply.code(404).send({ error: 'workspace not found' })
    return undefined
  }
  return ws
}
