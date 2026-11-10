import type { ServerEnv, Plan, CheckoutResult } from '@forge/shared'

/**
 * Flat pricing. AI is included on every plan, never metered, never a surprise bill
 * (brand rule). The internal spend caps are an operator cost control, not a customer charge.
 */
export const PLANS: readonly Plan[] = [
  {
    id: 'pro',
    name: 'Pro Builder Plan',
    priceUsd: 29,
    interval: 'month',
    blurb: 'Complete AI-powered visual development workspace.',
    features: [
      'AI included, never metered',
      'Unlimited microVM sandboxes',
      'One-click deployments',
      'Zapier, GitHub, Supabase integration',
    ],
  },
  {
    id: 'topup_10',
    name: 'Cap Extension ($10)',
    priceUsd: 10,
    interval: 'one-time',
    blurb: 'Increase your deep reasoning spend limit by $10.00.',
    features: ['Adds $10.00 to session limit', 'Supports more Fusion model calls', 'No expiration'],
  },
]

/** What a verified, paid webhook event should fulfil. */
export interface WebhookFulfillment {
  planId: string
  customerEmail?: string
  /** USD of credit to grant (one-time top-ups); 0 for recurring subscriptions. */
  creditUsd: number
  /**
   * The provider's event id. Stripe delivers at least once and retries on any non-2xx or
   * timeout, so the caller keys idempotency off this and grants a given event only once.
   */
  eventId?: string
}

/** Credit granted by a one-time plan. Subscriptions grant 0 (access, not credit). */
export function creditUsdForPlan(planId: string): number {
  const plan = PLANS.find((p) => p.id === planId)
  if (!plan || plan.interval !== 'one-time') return 0
  return plan.priceUsd
}

export interface BillingProvider {
  plans(): readonly Plan[]
  createCheckout(planId: string, opts: { customerEmail: string }): Promise<CheckoutResult>
  /** Verify and interpret a webhook. Returns null if not actionable; throws on a bad signature. */
  handleWebhook(rawBody: string, signature: string): Promise<WebhookFulfillment | null>
  readonly kind: 'mock' | 'stripe'
}

/**
 * Thrown when a webhook arrives but no live billing provider is configured.
 * The HTTP route maps this to 501 so an unverified event is never accepted.
 *
 * Naming note: the live provider today is Stripe-shaped, but Ron bills with
 * Square. Do not treat a mock or unconfigured webhook as paid. A Square
 * provider is not built here.
 */
export class BillingNotConfiguredError extends Error {
  readonly code = 'billing_not_configured'
  constructor() {
    super('billing not configured')
    this.name = 'BillingNotConfiguredError'
  }
}

/** No live charge: returns a local URL. Used until a live billing provider is supplied. */
export class MockBillingProvider implements BillingProvider {
  readonly kind = 'mock' as const

  plans(): readonly Plan[] {
    return PLANS
  }

  async createCheckout(planId: string, _opts: { customerEmail: string }): Promise<CheckoutResult> {
    return { url: `/pricing?selected=${encodeURIComponent(planId)}`, mode: 'mock' }
  }

  /**
   * Always throws. The mock must never return null (the route would answer 200
   * {received:true}) and must never grant credit. A forged signature is still
   * rejected because this path never verifies or fulfils.
   */
  async handleWebhook(_rawBody: string, _signature: string): Promise<WebhookFulfillment | null> {
    throw new BillingNotConfiguredError()
  }
}

import { StripeBillingProvider } from './stripe-billing'

export function createBillingProvider(env: ServerEnv): BillingProvider {
  if (env.STRIPE_SECRET_KEY && env.STRIPE_WEBHOOK_SECRET) {
    return new StripeBillingProvider(env.STRIPE_SECRET_KEY, {
      webhookSecret: env.STRIPE_WEBHOOK_SECRET,
      pricePro: env.STRIPE_PRICE_PRO,
      priceTopup10: env.STRIPE_PRICE_TOPUP_10,
      publicUrl: env.PUBLIC_URL,
    })
  }
  return new MockBillingProvider()
}
