import { FileSpendLedger, LedgerError, toNanoUsd } from '../lib/file-spend-ledger'
import { HARD_MAX_SANDBOX_CAP_USD, sandboxCostNanoUsd, type SandboxResources } from './e2b-pricing'
import { SandboxError } from './errors'

export interface SandboxReservation {
  id: string
  ref: string
  resources: SandboxResources
  maxSeconds: number
  reservedNanoUsd: number
  startedAtMs: number
}

/**
 * Fail-closed spend cap for sandbox time. Before a sandbox is created, its WORST case (the
 * full sandbox timeout at the configured size) is reserved in a durable ledger; if that would
 * exceed the cap, nothing is created. When the sandbox ends, the reservation is settled to the
 * real billable seconds (never more than the timeout, after which E2B kills it). A ledger that
 * cannot be read or written refuses the sandbox.
 */
export class SandboxSpendGuard {
  readonly capNanoUsd: number

  constructor(
    private readonly ledger: FileSpendLedger,
    capUsd: number,
    private readonly now: () => number = Date.now,
  ) {
    if (!Number.isFinite(capUsd) || capUsd <= 0 || capUsd > HARD_MAX_SANDBOX_CAP_USD)
      throw new SandboxError('sandbox_spend_ledger_unavailable', `cap must be > 0 and <= ${HARD_MAX_SANDBOX_CAP_USD} USD`)
    this.capNanoUsd = toNanoUsd(capUsd)
  }

  async reserve(ref: string, resources: SandboxResources, maxSeconds: number): Promise<SandboxReservation> {
    const reservedNanoUsd = sandboxCostNanoUsd(resources, maxSeconds)
    let result: Awaited<ReturnType<FileSpendLedger['reserve']>>
    try {
      result = await this.ledger.reserve(reservedNanoUsd, this.capNanoUsd, ref)
    } catch (err) {
      throw new SandboxError('sandbox_spend_ledger_unavailable', err instanceof LedgerError ? err.message : undefined)
    }
    if (!result.ok) throw new SandboxError('sandbox_spend_cap_reached')
    return { id: result.id, ref, resources, maxSeconds, reservedNanoUsd, startedAtMs: this.now() }
  }

  /** Settle to elapsed billable seconds (capped at the reservation's timeout). */
  async settleElapsed(r: SandboxReservation, outcome: string, ref?: string): Promise<number> {
    const seconds = Math.min(r.maxSeconds, Math.ceil((this.now() - r.startedAtMs) / 1000))
    return this.settle(r, seconds, outcome, ref)
  }

  async settle(r: SandboxReservation, seconds: number, outcome: string, ref?: string): Promise<number> {
    const s = Math.max(0, Math.min(r.maxSeconds, Math.ceil(seconds)))
    const nano = sandboxCostNanoUsd(r.resources, s)
    await this.ledger.settle(r.id, nano, outcome, { seconds: s, ref })
    return nano
  }

  async committedNanoUsd(): Promise<number> {
    return this.ledger.probe()
  }
}
