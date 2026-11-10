import { afterEach, describe, it, expect, vi } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
    expect(res.json()).toEqual({ ready: true, deployEnv: 'local', checks: { modelClient: 'mock', sandbox: 'mock', sandboxLedger: 'n/a' } })
    await app.close()
    vi.unstubAllEnvs()
  })
})

describe('hosted staging boot', () => {
  const dataDir = mkdtempSync(join(tmpdir(), 'forge-staging-'))
  const staging = {
    NODE_ENV: 'production', FORGE_DEPLOY_ENV: 'staging', AGENT_SERVICE_SECRET: 's'.repeat(48),
    ALLOWED_ORIGINS: 'https://forge-web-git-staging.vercel.app', GENX_ROUTER_URL: 'https://router-git-forge.vercel.app',
    GENX_ROUTER_FORGE_TOKEN: 't'.repeat(64), SANDBOX_PROVIDER: 'e2b', E2B_API_KEY: 'e2b_placeholder', FORGE_BUILD_SHA: 'abc1234',
    E2B_TEMPLATE: 'forge-node22-phaser', FORGE_SANDBOX_SPEND_CAP_USD: '3', FORGE_DATA_DIR: dataDir,
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
    expect(ready.json()).toEqual({ ready: true, deployEnv: 'staging', checks: { modelClient: 'genx-router', sandbox: 'real', sandboxLedger: 'ok' } })
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
  // The webhook is public to the auth hook (a billing provider sends no Bearer token)
  // but must never accept an unverified event. Mock/unconfigured answers 501.
  it('rejects an unconfigured billing webhook with 501, not 200 or 401', async () => {
    const app = buildServer()
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      payload: { type: 'checkout.session.completed' },
    })
    expect(res.statusCode).toBe(501)
    expect(res.json()).toEqual({ error: 'billing not configured' })
    expect(res.body).not.toContain('received')
    await app.close()
  })

  it('still answers 501 when the signature header is missing on the mock provider', async () => {
    const app = buildServer()
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json' },
      payload: { type: 'checkout.session.completed' },
    })
    expect(res.statusCode).toBe(501)
    expect(res.json()).toEqual({ error: 'billing not configured' })
    await app.close()
  })

  it('rejects a forged signature with 400 when a live Stripe provider is configured', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_not_a_real_key')
    vi.stubEnv('STRIPE_WEBHOOK_SECRET', 'whsec_test_not_a_real_secret')
    const app = buildServer()
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      payload: { type: 'checkout.session.completed' },
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid signature' })
    expect(res.body).not.toContain('received')
    await app.close()
    vi.unstubAllEnvs()
  })
})

describe('invalid JSON bodies', () => {
  it('maps malformed JSON on the webhook to 400 {error:invalid json}, not a raw parser message', async () => {
    const app = buildServer()
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/stripe',
      headers: { 'content-type': 'application/json', 'stripe-signature': 't=1,v1=deadbeef' },
      payload: '{not-json',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid json' })
    expect(res.body.toLowerCase()).not.toContain('unexpected')
    expect(res.body.toLowerCase()).not.toContain('syntaxerror')
    await app.close()
  })

  it('maps malformed JSON on POST /health to 400 {error:invalid json}', async () => {
    const app = buildServer()
    const res = await app.inject({
      method: 'POST',
      url: '/health',
      headers: { 'content-type': 'application/json' },
      payload: '{not-json',
    })
    expect(res.statusCode).toBe(400)
    expect(res.json()).toEqual({ error: 'invalid json' })
    expect(res.body.toLowerCase()).not.toContain('unexpected')
    await app.close()
  })
})

describe('wrong methods', () => {
  it('returns 405 and an Allow header for POST /health', async () => {
    const app = buildServer()
    const res = await app.inject({ method: 'POST', url: '/health' })
    expect(res.statusCode).toBe(405)
    expect(res.headers.allow).toMatch(/GET/)
    expect(res.json()).toEqual({ error: 'method not allowed' })
    await app.close()
  })

  it('returns 405 and an Allow header for GET /webhooks/stripe', async () => {
    const app = buildServer()
    const res = await app.inject({ method: 'GET', url: '/webhooks/stripe' })
    expect(res.statusCode).toBe(405)
    expect(res.headers.allow).toMatch(/POST/)
    expect(res.json()).toEqual({ error: 'method not allowed' })
    await app.close()
  })

  it('still returns 404 for a path that does not exist', async () => {
    const app = buildServer()
    const res = await app.inject({ method: 'GET', url: '/no-such-route' })
    expect(res.statusCode).toBe(404)
    expect(res.headers.allow).toBeUndefined()
    await app.close()
  })
})

describe('config exposure', () => {
  it('keeps the full /config payload behind auth', async () => {
    const app = buildServer()
    const anon = await app.inject({ method: 'GET', url: '/config' })
    expect(anon.statusCode).toBe(401)
    expect(anon.body).not.toContain('perUserUsd')
    expect(anon.body).not.toContain('openrouter')
    const { mintAgentToken, DEFAULT_AGENT_SERVICE_SECRET } = await import('@forge/shared')
    const auth = { authorization: `Bearer ${mintAgentToken('alice', DEFAULT_AGENT_SERVICE_SECRET)}` }
    const ok = await app.inject({ method: 'GET', url: '/config', headers: auth })
    expect(ok.statusCode).toBe(200)
    const body = ok.json()
    expect(body).toHaveProperty('models')
    expect(body).toHaveProperty('caps')
    expect(body).toHaveProperty('secrets')
    await app.close()
  })

  it('serves only a harmless public subset at /config/public', async () => {
    const app = buildServer()
    const res = await app.inject({ method: 'GET', url: '/config/public' })
    expect(res.statusCode).toBe(200)
    const body = res.json() as Record<string, unknown>
    expect(body).toEqual({ service: 'agent-service', billingConfigured: false })
    expect(JSON.stringify(body)).not.toMatch(/model|cap|secret|openrouter|e2b|perUser/i)
    await app.close()
  })
})

describe('security headers and trailing slash', () => {
  it('sends HSTS, nosniff, CSP, Referrer-Policy, and frame-ancestors on /health', async () => {
    const app = buildServer()
    const res = await app.inject({ method: 'GET', url: '/health' })
    expect(res.statusCode).toBe(200)
    const h = res.headers
    expect(String(h['strict-transport-security'] ?? '')).toMatch(/max-age=\d+/)
    expect(h['x-content-type-options']).toBe('nosniff')
    expect(String(h['content-security-policy'] ?? '')).toMatch(/frame-ancestors\s+'none'/)
    expect(h['referrer-policy']).toBe('no-referrer')
    const frame = String(h['x-frame-options'] ?? '').toLowerCase()
    expect(frame === 'deny' || String(h['content-security-policy']).includes("frame-ancestors 'none'")).toBe(true)
    await app.close()
  })

  it('answers GET /health/ the same as /health', async () => {
    const app = buildServer()
    const res = await app.inject({ method: 'GET', url: '/health/' })
    expect(res.statusCode).toBe(200)
    expect(res.json()).toMatchObject({ status: 'ok', service: 'agent-service' })
    await app.close()
  })
})

describe('sandbox failures over HTTP', () => {
  it('maps typed sandbox errors to stable codes and statuses, never provider text', async () => {
    const { mintAgentToken, DEFAULT_AGENT_SERVICE_SECRET } = await import('@forge/shared')
    const { MockSandboxProvider, SandboxError } = await import('./sandbox')
    const auth = { authorization: `Bearer ${mintAgentToken('alice', DEFAULT_AGENT_SERVICE_SECRET)}` }
    const cases = [
      ['sandbox_spend_cap_reached', 402],
      ['sandbox_limit_reached', 429],
      ['sandbox_create_failed', 503],
      ['sandbox_create_timeout', 504],
      ['sandbox_egress_unverified', 503],
    ] as const
    for (const [code, status] of cases) {
      const provider = new MockSandboxProvider()
      provider.create = async () => { throw new SandboxError(code) }
      const app = buildServer({ provider })
      const res = await app.inject({ method: 'POST', url: '/workspaces', headers: auth })
      expect(res.statusCode).toBe(status)
      expect(res.json()).toMatchObject({ error: code })
      await app.close()
    }
  })
})
