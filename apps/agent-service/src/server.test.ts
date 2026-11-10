import { afterEach, describe, it, expect, vi } from 'vitest'
import { buildServer } from './server'

describe('agent-service health', () => {
  it('responds ok on /health', async () => {
    const app = buildServer()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ status: 'ok', service: 'agent-service', version: 'dev', deployEnv: 'local', region: null })
    await app.close()
  })

  it('is ready locally on mocks, and reports what it would use without secrets', async () => {
    for (const k of ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'OPENROUTER_API_KEY', 'E2B_API_KEY', 'GENX_ROUTER_URL', 'GENX_ROUTER_FORGE_TOKEN']) vi.stubEnv(k, '')
    const app = buildServer()
    const res = await app.inject({ method: 'GET', url: '/ready' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toEqual({ ready: true, deployEnv: 'local', checks: { modelClient: 'mock', sandbox: 'mock' } })
    await app.close()
    vi.unstubAllEnvs()
  })
})

describe('hosted staging boot', () => {
  const staging = {
    NODE_ENV: 'production', FORGE_DEPLOY_ENV: 'staging', AGENT_SERVICE_SECRET: 's'.repeat(48),
    ALLOWED_ORIGINS: 'https://forge-web-git-staging.vercel.app', GENX_ROUTER_URL: 'https://router-git-forge.vercel.app',
    GENX_ROUTER_FORGE_TOKEN: 't'.repeat(64), SANDBOX_PROVIDER: 'e2b', E2B_API_KEY: 'e2b_placeholder', FORGE_BUILD_SHA: 'abc1234',
    // The host shell may carry direct provider keys; staging must not see them.
    GEMINI_API_KEY: '', ANTHROPIC_API_KEY: '', OPENROUTER_API_KEY: '',
  }
  afterEach(() => vi.unstubAllEnvs())
  it('refuses to boot with an incomplete staging config (no mock fallback)', () => {
    for (const [k, v] of Object.entries({ ...staging, E2B_API_KEY: '' })) vi.stubEnv(k, v)
    expect(() => buildServer()).toThrow('Staging configuration refused')
  })
  it('boots on the Router client and a real sandbox provider and reports the build', async () => {
    for (const [k, v] of Object.entries(staging)) vi.stubEnv(k, v)
    const app = buildServer()
    const health = await app.inject({ method: 'GET', url: '/health' })
    expect(health.json()).toMatchObject({ status: 'ok', version: 'abc1234', deployEnv: 'staging' })
    const ready = await app.inject({ method: 'GET', url: '/ready' })
    expect(ready.statusCode).toBe(200)
    expect(ready.json()).toEqual({ ready: true, deployEnv: 'staging', checks: { modelClient: 'genx-router', sandbox: 'real' } })
    expect(ready.body).not.toContain('t'.repeat(64))
    await app.close()
  })
})

describe('protected routes', () => {
  it('rejects unauthenticated REST calls with 401', async () => {
    const app = buildServer()
    const ws = await app.inject({ method: 'GET', url: '/workspaces' })
    expect(ws.statusCode).toBe(401)
    const admin = await app.inject({ method: 'GET', url: '/admin/stats' })
    expect(admin.statusCode).toBe(401)
    await app.close()
  })
})

describe('stripe webhook', () => {
  // The webhook is public to the auth hook (Stripe sends no Bearer token) but must
  // reject anything without a valid signature, so it never grants credit on a forged event.
  it('reaches the handler and rejects a missing signature with 400, not 401', async () => {
    const app = buildServer()
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: { type: 'checkout.session.completed' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'missing signature or body' })
    await app.close()
  })
})
