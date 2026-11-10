import { closeSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

/**
 * File-backed, crash-safe spend ledger (ported from GenX Router OS src/lib/forge/spend-ledger.ts).
 *
 * Amounts are integer nano-dollars (1e-9 USD). A reservation is persisted BEFORE the paid
 * action starts; an open reservation left by a crash keeps counting at its full worst-case
 * amount, so a restart can only make the cap stricter. Writes are atomic (tmp + rename) under a
 * lock file. Only numbers, ids, timestamps and outcome codes are stored.
 *
 * Scope: one host with a durable disk (on Fly: the single staging machine's volume). It is not
 * a distributed ledger; running more than one agent-service instance needs a shared ledger.
 */
export const NANO_PER_USD = 1_000_000_000
const LOCK_STALE_MS = 30_000
const LOCK_WAIT_MS = 5_000

export interface LedgerEntry {
  id: string
  /** What the reservation is for (e.g. a sandbox nonce or id). Safe identifier only. */
  ref?: string
  createdAt: string
  status: 'reserved' | 'settled'
  reservedNanoUsd: number
  settledNanoUsd?: number
  settledAt?: string
  outcome?: string
  /** Billable seconds the settlement was computed from. */
  seconds?: number
}

export interface LedgerState {
  version: 1
  entries: LedgerEntry[]
}

export class LedgerError extends Error {}

export type ReserveResult =
  | { ok: true; id: string; committedNanoUsd: number }
  | { ok: false; committedNanoUsd: number }

export const toNanoUsd = (usd: number): number => Math.ceil(usd * NANO_PER_USD - 1e-6)

const REF = /^[A-Za-z0-9_.:-]{1,80}$/
const OUTCOME = /^[a-z_]{1,32}$/

export function committedNanoUsd(state: LedgerState): number {
  return state.entries.reduce(
    (sum, e) => sum + (e.status === 'settled' ? (e.settledNanoUsd ?? e.reservedNanoUsd) : e.reservedNanoUsd),
    0,
  )
}

const isNonNegInt = (v: unknown): v is number => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0

function validate(raw: unknown): LedgerState {
  const s = raw as LedgerState
  if (!s || typeof s !== 'object' || s.version !== 1 || !Array.isArray(s.entries)) throw new LedgerError('Spend ledger is corrupt.')
  for (const e of s.entries) {
    if (
      !e || typeof e.id !== 'string' || (e.status !== 'reserved' && e.status !== 'settled') ||
      !isNonNegInt(e.reservedNanoUsd) || (e.status === 'settled' && !isNonNegInt(e.settledNanoUsd))
    )
      throw new LedgerError('Spend ledger is corrupt.')
  }
  return s
}

export class FileSpendLedger {
  private readonly lockPath: string

  constructor(private readonly path: string, private readonly now: () => number = Date.now) {
    if (!path || !path.startsWith('/')) throw new LedgerError('Spend ledger path must be absolute.')
    this.lockPath = `${path}.lock`
  }

  read(): LedgerState {
    let text: string
    try {
      text = readFileSync(this.path, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { version: 1, entries: [] }
      throw new LedgerError('Spend ledger is unreadable.')
    }
    try {
      return validate(JSON.parse(text))
    } catch (error) {
      throw error instanceof LedgerError ? error : new LedgerError('Spend ledger is corrupt.')
    }
  }

  private write(state: LedgerState): void {
    const tmp = `${this.path}.${process.pid}.${randomUUID()}.tmp`
    try {
      writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
      renameSync(tmp, this.path)
    } catch {
      rmSync(tmp, { force: true })
      throw new LedgerError('Spend ledger is not writable.')
    }
  }

  private async withLock<T>(fn: () => T): Promise<T> {
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    } catch {
      throw new LedgerError('Spend ledger directory is not writable.')
    }
    const deadline = this.now() + LOCK_WAIT_MS
    for (;;) {
      try {
        closeSync(openSync(this.lockPath, 'wx', 0o600))
        break
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw new LedgerError('Spend ledger lock failed.')
        try {
          if (this.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) {
            rmSync(this.lockPath, { force: true })
            continue
          }
        } catch {
          continue
        }
        if (this.now() > deadline) throw new LedgerError('Spend ledger is busy.')
        await new Promise((r) => setTimeout(r, 25))
      }
    }
    try {
      return fn()
    } finally {
      rmSync(this.lockPath, { force: true })
    }
  }

  /** Throws if the ledger cannot be read or written (used by readiness checks). */
  async probe(): Promise<number> {
    return this.withLock(() => committedNanoUsd(this.read()))
  }

  /** Persist a reservation, or refuse it (nothing written) when it would exceed the cap. */
  async reserve(amountNanoUsd: number, capNanoUsd: number, ref?: string): Promise<ReserveResult> {
    if (!isNonNegInt(amountNanoUsd) || !isNonNegInt(capNanoUsd)) throw new LedgerError('Invalid reservation amount.')
    return this.withLock(() => {
      const state = this.read()
      const committed = committedNanoUsd(state)
      if (committed + amountNanoUsd > capNanoUsd) return { ok: false as const, committedNanoUsd: committed }
      const id = randomUUID()
      state.entries.push({
        id,
        ...(ref && REF.test(ref) ? { ref } : {}),
        createdAt: new Date(this.now()).toISOString(),
        status: 'reserved',
        reservedNanoUsd: amountNanoUsd,
      })
      this.write(state)
      return { ok: true as const, id, committedNanoUsd: committed + amountNanoUsd }
    })
  }

  /** Replace a reservation with the real amount. Settling twice is refused. */
  async settle(id: string, actualNanoUsd: number, outcome: string, extra: { seconds?: number; ref?: string } = {}): Promise<LedgerEntry> {
    if (!isNonNegInt(actualNanoUsd)) throw new LedgerError('Invalid settlement amount.')
    if (!OUTCOME.test(outcome)) throw new LedgerError('Invalid settlement outcome.')
    return this.withLock(() => {
      const state = this.read()
      const entry = state.entries.find((e) => e.id === id)
      if (!entry || entry.status !== 'reserved') throw new LedgerError('Unknown or already settled reservation.')
      entry.status = 'settled'
      entry.settledNanoUsd = actualNanoUsd
      entry.settledAt = new Date(this.now()).toISOString()
      entry.outcome = outcome
      if (extra.seconds !== undefined && isNonNegInt(extra.seconds)) entry.seconds = extra.seconds
      if (extra.ref && REF.test(extra.ref)) entry.ref = extra.ref
      this.write(state)
      return { ...entry }
    })
  }
}
