import { describe, it, expect } from 'vitest'
import {
  parseServerEnv,
  secretStatus,
  parseEgressAllowlist,
  DEFAULT_AGENT_SERVICE_SECRET,
} from './env'

describe('serverEnv', () => {
  it('applies safe defaults when secrets are absent', () => {
    const env = parseServerEnv({})
    expect(env.NODE_ENV).toBe('development')
    expect(env.SANDBOX_PROVIDER).toBe('mock')
    expect(env.SPEND_CAP_USER_USD).toBe(5)
    expect(env.SPEND_CAP_GLOBAL_USD).toBe(100)
    expect(secretStatus(env).openrouter).toBe(false)
    expect(secretStatus(env).supabase).toBe(false)
  })

  it('coerces numeric values and reflects provided secrets', () => {
    const env = parseServerEnv({
      PORT: '9000',
      OPENROUTER_API_KEY: 'sk-test',
      SUPABASE_URL: 'https://x.supabase.co',
      SUPABASE_ANON_KEY: 'anon',
      SUPABASE_SERVICE_ROLE_KEY: 'svc',
    } as NodeJS.ProcessEnv)
    expect(env.PORT).toBe(9000)
    expect(secretStatus(env).openrouter).toBe(true)
    expect(secretStatus(env).supabase).toBe(true)
    expect(secretStatus(env).stripe).toBe(false)
  })

  it('rejects an invalid SUPABASE_URL', () => {
    expect(() =>
      parseServerEnv({ SUPABASE_URL: 'not-a-url' } as NodeJS.ProcessEnv),
    ).toThrow()
  })

  it('parses a comma-separated egress allowlist into clean domains', () => {
    const env = parseServerEnv({
      EGRESS_ALLOWLIST: 'registry.npmjs.org, , pypi.org ,docs.example.com',
    } as NodeJS.ProcessEnv)
    expect(parseEgressAllowlist(env)).toEqual([
      'registry.npmjs.org',
      'pypi.org',
      'docs.example.com',
    ])
  })

  it('defaults the egress allowlist to empty (default-deny)', () => {
    expect(parseEgressAllowlist(parseServerEnv({}))).toEqual([])
  })

  it('refuses the public default AGENT_SERVICE_SECRET in production', () => {
    expect(() => parseServerEnv({ NODE_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow(
      /AGENT_SERVICE_SECRET/,
    )
    expect(() =>
      parseServerEnv({
        NODE_ENV: 'production',
        AGENT_SERVICE_SECRET: DEFAULT_AGENT_SERVICE_SECRET,
      } as NodeJS.ProcessEnv),
    ).toThrow(/AGENT_SERVICE_SECRET/)
  })

  it('accepts a custom secret in production', () => {
    const env = parseServerEnv({
      NODE_ENV: 'production',
      AGENT_SERVICE_SECRET: 'a-strong-unique-secret',
      ALLOWED_ORIGINS: 'https://forge.example.com',
    } as NodeJS.ProcessEnv)
    expect(env.AGENT_SERVICE_SECRET).toBe('a-strong-unique-secret')
  })
})

describe('hosted staging fails closed', () => {
  const staging = {
    NODE_ENV: 'production', FORGE_DEPLOY_ENV: 'staging', AGENT_SERVICE_SECRET: 's'.repeat(48),
    ALLOWED_ORIGINS: 'https://forge-web-git-staging.vercel.app', GENX_ROUTER_URL: 'https://router-git-forge.vercel.app',
    GENX_ROUTER_FORGE_TOKEN: 't'.repeat(64), SANDBOX_PROVIDER: 'e2b', E2B_API_KEY: 'e2b_placeholder',
    E2B_TEMPLATE: 'forge-node22-phaser', FORGE_SANDBOX_SPEND_CAP_USD: '3', FORGE_DATA_DIR: '/data',
  }
  it('accepts a complete staging configuration', () => {
    expect(parseServerEnv(staging as NodeJS.ProcessEnv).FORGE_DEPLOY_ENV).toBe('staging')
  })
  it('refuses production outright', () => {
    expect(() => parseServerEnv({ ...staging, FORGE_DEPLOY_ENV: 'production' } as NodeJS.ProcessEnv)).toThrow('not approved')
  })
  it.each([
    [{ NODE_ENV: 'development' }, 'NODE_ENV'],
    [{ AGENT_SERVICE_SECRET: DEFAULT_AGENT_SERVICE_SECRET }, 'AGENT_SERVICE_SECRET'],
    [{ AGENT_SERVICE_SECRET: 'short-but-not-default' }, 'AGENT_SERVICE_SECRET'],
    [{ ALLOWED_ORIGINS: '' }, 'ALLOWED_ORIGINS'],
    [{ ALLOWED_ORIGINS: 'http://forge.example' }, 'ALLOWED_ORIGINS'],
    [{ ALLOWED_ORIGINS: 'https://*.vercel.app' }, 'ALLOWED_ORIGINS'],
    [{ GENX_ROUTER_URL: undefined }, 'GENX_ROUTER_URL'],
    [{ GENX_ROUTER_URL: 'http://router.example' }, 'https'],
    [{ ANTHROPIC_API_KEY: 'sk-x' }, 'ANTHROPIC_API_KEY'],
    [{ OPENROUTER_API_KEY: 'sk-x' }, 'OPENROUTER_API_KEY'],
    [{ STRIPE_SECRET_KEY: 'sk_test_x' }, 'Stripe'],
    [{ SANDBOX_PROVIDER: 'mock' }, 'E2B_API_KEY'],
    [{ E2B_API_KEY: undefined }, 'E2B_API_KEY'],
    [{ FORGE_SANDBOX_SPEND_CAP_USD: undefined }, 'FORGE_SANDBOX_SPEND_CAP_USD'],
    [{ FORGE_DATA_DIR: undefined }, 'FORGE_DATA_DIR'],
    [{ E2B_TEMPLATE: undefined }, 'E2B_TEMPLATE'],
  ])('refuses %j', (patch, name) => {
    let message = ''
    try { parseServerEnv({ ...staging, ...patch } as NodeJS.ProcessEnv) } catch (e) { message = (e as Error).message }
    expect(message).toContain('Staging configuration refused')
    expect(message).toContain(name)
    // Names only: no secret value ever appears in the error.
    expect(message).not.toContain('t'.repeat(64)); expect(message).not.toContain('s'.repeat(48))
  })
  it('leaves local development untouched', () => {
    expect(() => parseServerEnv({})).not.toThrow()
  })
})
