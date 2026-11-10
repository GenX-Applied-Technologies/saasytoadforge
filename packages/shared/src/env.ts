import { z } from 'zod'
import { OWNER_EMAILS as DEFAULT_OWNER_EMAILS } from './owners'

const DEFAULT_OWNERS_CSV = DEFAULT_OWNER_EMAILS.join(',')

/** Shared secret between the web app and agent-service for signed user tokens. */
export const DEFAULT_AGENT_SERVICE_SECRET = 'forge-dev-insecure-secret-change-in-prod'

/**
 * Server-side configuration. Secret values are OPTIONAL at boot so the app runs
 * with mock providers in development and never hard-blocks (see DECISIONS.md).
 * Secrets are required only when their feature is actually exercised.
 */
export const serverEnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  /**
   * Where this agent-service runs. 'staging' turns on the fail-closed hosted checks in
   * assertStagingEnv. 'production' is refused until Ron approves a production launch.
   */
  FORGE_DEPLOY_ENV: z.enum(['local', 'staging', 'production']).default('local'),
  /** Git commit the image was built from (Docker build arg). Shown by /health. */
  FORGE_BUILD_SHA: z
    .string()
    .regex(/^[0-9a-f]{7,40}$/)
    .optional(),
  PORT: z.coerce.number().int().positive().default(8787),

  // Secrets (optional at boot; features degrade to mocks when absent).
  OPENROUTER_API_KEY: z.string().optional(),
  /** Server-side Anthropic key; when set, Claude drives the agent directly (no OpenRouter). */
  ANTHROPIC_API_KEY: z.string().optional(),
  /** Server-side Google Gemini key; used as a model fallback after OpenRouter. */
  GEMINI_API_KEY: z.string().optional(),
  /** Agent-service-only Router origin and scoped app credential. Never expose to web. */
  GENX_ROUTER_URL: z.string().url().optional(),
  GENX_ROUTER_FORGE_TOKEN: z.string().min(32).optional(),
  /**
   * Vercel Deployment Protection bypass for a protected Router PREVIEW. Sent only to
   * GENX_ROUTER_URL as x-vercel-protection-bypass; never logged or exposed to web.
   */
  GENX_ROUTER_PROTECTION_BYPASS: z.string().min(16).optional(),
  E2B_API_KEY: z.string().optional(),
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().optional(),
  STRIPE_SECRET_KEY: z.string().optional(),
  STRIPE_WEBHOOK_SECRET: z.string().optional(),
  /** Stripe Price ids for the live checkout. Fall back to mock ids in dev. */
  STRIPE_PRICE_PRO: z.string().optional(),
  STRIPE_PRICE_TOPUP_10: z.string().optional(),
  /** Public web origin used for Stripe success/cancel redirects. */
  PUBLIC_URL: z.string().optional(),
  UPSTASH_REDIS_REST_URL: z.string().optional(),
  RESEND_API_KEY: z.string().optional(),
  VERCEL_TOKEN: z.string().optional(),
  ZAPIER_API_KEY: z.string().optional(),

  // Shared secret for web <-> agent-service signed tokens.
  AGENT_SERVICE_SECRET: z.string().default(DEFAULT_AGENT_SERVICE_SECRET),
  /** Comma-separated list of admin emails (access to /admin/stats). Owners are admins too. */
  ADMIN_EMAILS: z.string().default(DEFAULT_OWNERS_CSV),
  /**
   * Comma-separated list of owner/founder emails.
   * Owners bypass ALL spend caps, have unlimited agent access, and are the only
   * accounts that can create or remove admin users. Defaults from the shared owners list.
   */
  OWNER_EMAILS: z.string().default(DEFAULT_OWNERS_CSV),
  /** Allowed browser origin(s) for CORS + websocket, comma-separated. Empty = localhost dev. */
  ALLOWED_ORIGINS: z.string().default(''),

  // Sandbox + egress safety.
  /** 'mock' is in-memory (dev/tests only; refused when NODE_ENV=production). 'e2b' is a real microVM. */
  SANDBOX_PROVIDER: z.enum(['mock', 'e2b']).default('mock'),
  /** E2B template name or id. Staging must name the Forge template explicitly. */
  E2B_TEMPLATE: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/).default('base'),
  /** Fail-closed cap (USD) on total E2B sandbox time recorded in the durable ledger. Required for e2b. */
  FORGE_SANDBOX_SPEND_CAP_USD: z.coerce.number().positive().max(10).optional(),
  /** Absolute directory for durable state (sandbox spend ledger). On Fly: the volume mount. */
  FORGE_DATA_DIR: z.string().regex(/^\/[^\0]*$/).optional(),
  /** Sandbox lifetime; E2B kills it at this point and the ledger reserves exactly this much. */
  FORGE_SANDBOX_TIMEOUT_MS: z.coerce.number().int().min(60_000).max(3_600_000).default(600_000),
  /** Most sandboxes this process will run at once. */
  FORGE_SANDBOX_MAX_CONCURRENT: z.coerce.number().int().min(1).max(10).default(2),
  /** Sandbox size the spend cap is priced at; a sandbox reporting more is killed. */
  FORGE_SANDBOX_VCPU: z.coerce.number().int().min(1).max(8).default(2),
  FORGE_SANDBOX_MEMORY_MB: z.coerce.number().int().min(512).max(8192).default(4096),
  /** Comma-separated egress allowlist applied to every sandbox (default-deny). */
  EGRESS_ALLOWLIST: z.string().default(''),

  // Spend control (USD).
  SPEND_CAP_USER_USD: z.coerce.number().nonnegative().default(5),
  SPEND_CAP_GLOBAL_USD: z.coerce.number().nonnegative().default(100),

  // Model routing. Overridable via env, never hardcoded in business logic.
  MODEL_FAST: z.string().default('openai/gpt-4o-mini'),
  MODEL_FRONTIER: z.string().default('anthropic/claude-sonnet-4'),
  MODEL_DEEP: z.string().default('openrouter/fusion'),
  /**
   * Bare Claude model id used when driving Anthropic directly (BYO key or ANTHROPIC_API_KEY).
   * Must support adaptive thinking; never a legacy claude-3-* id.
   */
  ANTHROPIC_MODEL: z.string().default('claude-sonnet-4-5'),
  /** Bare Gemini model id used when driving Google directly (BYO key). */
  GOOGLE_MODEL: z.string().default('gemini-2.5-pro'),
})

export type ServerEnv = z.infer<typeof serverEnvSchema>

export function parseServerEnv(raw: NodeJS.ProcessEnv = process.env): ServerEnv {
  // Treat empty-string env vars (common in .env files) as unset so optional fields work.
  const cleaned: Record<string, string | undefined> = {}
  for (const [key, value] of Object.entries(raw)) {
    cleaned[key] = value === '' ? undefined : value
  }
  const env = serverEnvSchema.parse(cleaned)

  if (env.FORGE_DEPLOY_ENV === 'production') {
    throw new Error(
      'FORGE_DEPLOY_ENV=production is not approved. Forge runs on staging only until a production launch is approved.',
    )
  }
  if (env.FORGE_DEPLOY_ENV === 'staging') assertStagingEnv(env)

  // Refuse to boot with the public dev secret in production - it would let anyone forge
  // a token for any user and defeat tenant isolation.
  if (env.NODE_ENV === 'production') {
    if (env.AGENT_SERVICE_SECRET === DEFAULT_AGENT_SERVICE_SECRET) {
      throw new Error(
        'AGENT_SERVICE_SECRET must be set to a strong, unique value in production (the default is public).',
      )
    }
    if (env.ALLOWED_ORIGINS.trim() === '') {
      console.warn(
        '[env] ALLOWED_ORIGINS is empty in production; CORS will reject the deployed web app. Set it to the web origin.',
      )
    }
  }
  return env
}

/** Exact HTTPS origin (no path, no wildcard). */
function isHttpsOrigin(value: string): boolean {
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && url.origin === value && !value.includes('*')
  } catch {
    return false
  }
}

/**
 * Hosted staging must fail closed instead of degrading to mocks or direct providers.
 * Every problem is listed at once, by variable NAME only (never a value).
 */
export function assertStagingEnv(env: ServerEnv): void {
  const problems: string[] = []
  if (env.NODE_ENV !== 'production') problems.push('NODE_ENV must be production on staging')
  if (
    env.AGENT_SERVICE_SECRET === DEFAULT_AGENT_SERVICE_SECRET ||
    env.AGENT_SERVICE_SECRET.length < 32
  )
    problems.push('AGENT_SERVICE_SECRET must be a unique 32+ character secret')
  const origins = env.ALLOWED_ORIGINS.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  if (origins.length === 0 || !origins.every(isHttpsOrigin))
    problems.push('ALLOWED_ORIGINS must list exact https:// web origins')
  if (!env.GENX_ROUTER_URL || !env.GENX_ROUTER_FORGE_TOKEN)
    problems.push('GENX_ROUTER_URL and GENX_ROUTER_FORGE_TOKEN are required (every model call goes through GenX Router OS)')
  else if (!isHttpsOrigin(env.GENX_ROUTER_URL.replace(/\/$/, '')))
    problems.push('GENX_ROUTER_URL must be an https:// origin')
  for (const name of ['OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'] as const) {
    if (env[name]) problems.push(`${name} must not be set on staging (direct provider keys bypass the Router)`)
  }
  if (env.STRIPE_SECRET_KEY || env.STRIPE_WEBHOOK_SECRET)
    problems.push('Stripe keys must not be set on staging (billing is tested separately)')
  if (env.SANDBOX_PROVIDER !== 'e2b' || !env.E2B_API_KEY)
    problems.push('SANDBOX_PROVIDER=e2b and E2B_API_KEY are required on staging (no mock sandbox)')
  if (!env.FORGE_SANDBOX_SPEND_CAP_USD)
    problems.push('FORGE_SANDBOX_SPEND_CAP_USD is required on staging (fail-closed sandbox-time cap)')
  if (!env.FORGE_DATA_DIR) problems.push('FORGE_DATA_DIR is required on staging (durable spend ledger)')
  if (env.E2B_TEMPLATE === 'base')
    problems.push('E2B_TEMPLATE must name the Forge template on staging (the base template has no toolchain)')
  if (problems.length > 0) {
    throw new Error(`Staging configuration refused: ${problems.join('; ')}.`)
  }
}

export interface SecretStatus {
  openrouter: boolean
  e2b: boolean
  supabase: boolean
  stripe: boolean
  upstashRedis: boolean
  resend: boolean
  vercel: boolean
  zapier: boolean
}

/** Which secret-backed features are live vs running on mocks. */
export function secretStatus(env: ServerEnv): SecretStatus {
  return {
    openrouter: Boolean(env.OPENROUTER_API_KEY),
    e2b: Boolean(env.E2B_API_KEY),
    supabase: Boolean(
      env.SUPABASE_URL && env.SUPABASE_ANON_KEY && env.SUPABASE_SERVICE_ROLE_KEY,
    ),
    stripe: Boolean(env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET),
    upstashRedis: Boolean(env.UPSTASH_REDIS_REST_URL),
    resend: Boolean(env.RESEND_API_KEY),
    vercel: Boolean(env.VERCEL_TOKEN),
    zapier: Boolean(env.ZAPIER_API_KEY),
  }
}

/** Parse the comma-separated allowlist into a clean domain array. */
export function parseEgressAllowlist(env: ServerEnv): string[] {
  return env.EGRESS_ALLOWLIST.split(',')
    .map((d) => d.trim())
    .filter((d) => d.length > 0)
}

/** Check if the user email is an authorized administrator. */
export function isAdminEmail(email: string | undefined, adminEmailsStr: string): boolean {
  if (!email) return false
  const admins = adminEmailsStr.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
  return admins.includes(email.toLowerCase())
}

/**
 * Check if the user email is a company owner.
 * Owners bypass all spend caps — unlimited agent access.
 */
export function isOwnerEmail(email: string | undefined, ownerEmailsStr: string): boolean {
  if (!email) return false
  const owners = ownerEmailsStr.split(',').map((e) => e.trim().toLowerCase()).filter(Boolean)
  return owners.includes(email.toLowerCase())
}
