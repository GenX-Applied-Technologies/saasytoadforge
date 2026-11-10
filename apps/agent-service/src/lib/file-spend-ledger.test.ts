import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { FileSpendLedger, LedgerError, committedNanoUsd, toNanoUsd } from './file-spend-ledger'

const fresh = () => new FileSpendLedger(join(mkdtempSync(join(tmpdir(), 'forge-ledger-')), 'l.json'))

describe('FileSpendLedger', () => {
  it('reserves, refuses over cap, and settles down to the real amount', async () => {
    const l = fresh()
    const a = await l.reserve(600, 1000)
    expect(a.ok).toBe(true)
    expect((await l.reserve(500, 1000)).ok).toBe(false)
    if (!a.ok) throw new Error('unreachable')
    await l.settle(a.id, 100, 'destroyed', { seconds: 3 })
    expect(committedNanoUsd(l.read())).toBe(100)
    expect((await l.reserve(500, 1000)).ok).toBe(true)
  })
  it('refuses double settle, bad amounts and bad outcomes', async () => {
    const l = fresh()
    const a = await l.reserve(10, 100)
    if (!a.ok) throw new Error('unreachable')
    await expect(l.settle(a.id, 1, 'Bad Outcome')).rejects.toBeInstanceOf(LedgerError)
    await l.settle(a.id, 1, 'ok')
    await expect(l.settle(a.id, 1, 'ok')).rejects.toThrow('Unknown or already settled reservation.')
    await expect(l.reserve(-1, 100)).rejects.toThrow('Invalid reservation amount.')
    await expect(l.reserve(1.5, 100)).rejects.toThrow('Invalid reservation amount.')
  })
  it('serializes concurrent reservations: never over the cap', async () => {
    const l = fresh()
    const results = await Promise.all(Array.from({ length: 20 }, () => l.reserve(100, 1000)))
    expect(results.filter((r) => r.ok)).toHaveLength(10)
    expect(committedNanoUsd(l.read())).toBe(1000)
  })
  it('a corrupt ledger fails closed', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-ledger-'))
    writeFileSync(join(dir, 'l.json'), '{"version":1,"entries":[{"id":"x","status":"reserved","reservedNanoUsd":-5}]}')
    const l = new FileSpendLedger(join(dir, 'l.json'))
    await expect(l.reserve(1, 100)).rejects.toThrow('Spend ledger is corrupt.')
    writeFileSync(join(dir, 'l.json'), 'not json')
    await expect(l.probe()).rejects.toThrow('Spend ledger is corrupt.')
  })
  it('requires an absolute path and converts USD to nano', () => {
    expect(() => new FileSpendLedger('rel/l.json')).toThrow(LedgerError)
    expect(toNanoUsd(3)).toBe(3_000_000_000)
    expect(toNanoUsd(0.0276)).toBe(27_600_000)
  })
})
