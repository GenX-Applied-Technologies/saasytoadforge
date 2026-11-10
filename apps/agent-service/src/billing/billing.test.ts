import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { parseServerEnv } from '@forge/shared'
import { SpendLedger } from '../lib/spend'
import { PLANS, MockBillingProvider, BillingNotConfiguredError, createBillingProvider } from './billing'

describe('billing plans', () => {
  it('offers flat plans with AI included and no metering', () => {
    expect(PLANS.map((p) => p.id)).toEqual(['pro', 'topup_10'])
    for (const plan of PLANS) {
      expect(plan.priceUsd).toBeGreaterThan(0)
      if (plan.interval !== 'one-time') {
        expect(plan.features.some((f) => /never metered/i.test(f))).toBe(true)
      }
    }
  })
})

describe('MockBillingProvider', () => {
  it('returns a local checkout url and never charges', async () => {
    const result = await new MockBillingProvider().createCheckout('pro', {
      customerEmail: 'me@forge.dev',
    })
    expect(result.mode).toBe('mock')
    expect(result.url).toContain('pro')
  })

  it('rejects every webhook so an unverified event is never accepted', async () => {
    await expect(new MockBillingProvider().handleWebhook('{"type":"ping"}', 't=1,v1=deadbeef')).rejects.toBeInstanceOf(
      BillingNotConfiguredError,
    )
  })
})

describe('createBillingProvider', () => {
  it('uses the mock provider without a Stripe key', () => {
    expect(createBillingProvider(parseServerEnv({})).kind).toBe('mock')
  })
})

/**
 * Stripe delivers webhooks at least once and retries on any non-2xx or timeout. Without
 * idempotency, one $10 purchase whose delivery blips grants $10 again on every redelivery.
 */
describe('top-up credit is granted once per Stripe event', () => {
  const EMAIL = 'buyer@forge.dev'
  const EVENT = 'evt_1PfakeCheckoutCompleted'

  it('ignores a redelivery of an event it already fulfilled', () => {
    const ledger = new SpendLedger()

    expect(ledger.addEmailCredits(EMAIL, 10, EVENT)).toBe(true)
    expect(ledger.emailCreditsAmount(EMAIL)).toBe(10)

    // Stripe retries the same event twice more.
    expect(ledger.addEmailCredits(EMAIL, 10, EVENT)).toBe(false)
    expect(ledger.addEmailCredits(EMAIL, 10, EVENT)).toBe(false)
    expect(ledger.emailCreditsAmount(EMAIL)).toBe(10)
  })

  it('still credits a genuine second purchase', () => {
    const ledger = new SpendLedger()
    ledger.addEmailCredits(EMAIL, 10, 'evt_first')
    expect(ledger.addEmailCredits(EMAIL, 10, 'evt_second')).toBe(true)
    expect(ledger.emailCreditsAmount(EMAIL)).toBe(20)
  })

  it('dedupes per event, not per buyer', () => {
    const ledger = new SpendLedger()
    ledger.addEmailCredits(EMAIL, 10, 'evt_a')
    expect(ledger.addEmailCredits('other@forge.dev', 10, 'evt_b')).toBe(true)
    expect(ledger.emailCreditsAmount('other@forge.dev')).toBe(10)
  })

  it('the webhook route passes the event id through', () => {
    const server = readFileSync(join(__dirname, '../server.ts'), 'utf8')
    expect(server).toMatch(/addEmailCredits\([\s\S]{0,120}fulfillment\.eventId/)
  })

  it('the Stripe provider reports the event id it verified', () => {
    const provider = readFileSync(join(__dirname, 'stripe-billing.ts'), 'utf8')
    expect(provider).toMatch(/eventId: event\.id/)
  })
})
