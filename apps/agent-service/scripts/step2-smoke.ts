/**
 * Step 2 smoke test on REAL E2B through the same provider, spend guard and ledger the server
 * uses. No mocks: the only wrapper around the real E2B API records what the ledger held at the
 * instant `create` was called (to prove the reserve happens first).
 *
 * Phases:
 *  free  (no sandbox ever runs, $0):
 *    402  cap below one reservation -> refused before E2B is called; ledger unchanged
 *    503  unknown template -> E2B refuses; reservation released to $0; nothing left on E2B
 *  paid  (ONE sandbox, 10-minute timeout, ledger cap FORGE_SMOKE_CAP_USD, default and max 0.50):
 *    reserve-before-create: ledger holds exactly the worst case ($0.0276 per 10 min at
 *        2 vCPU / 4 GiB) when create is called
 *    deny-all by default: HTTPS to example.com and a raw IP get no response; DNS fails
 *    no host secrets inside the sandbox (envs:{})
 *    allow rule [registry.npmjs.org]: registry answers 200, example.com + raw IP still blocked
 *    tighten back to deny-all: registry blocked again
 *    429  second create while one runs (max 1) -> refused before E2B; ledger unchanged
 *    410  sandbox killed out of band on E2B -> next command says gone; ledger settled
 *    504  create with a 1 ms request timeout -> create timeout; any VM that booted is found by
 *         its nonce and killed
 *    end: no open reservations, E2B lists nothing for this deployment tag
 *
 *   FORGE_E2B_PAID_APPROVED=step2-smoke  (paid phase; without it only the free phase runs)
 * Needs E2B_API_KEY in the environment; never prints it. Writes the ledger under FORGE_DATA_DIR.
 */
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { E2BSandboxProvider, realE2BApi, SANDBOX_LEDGER_FILE } from '../src/sandbox/index'
import type { E2BApi } from '../src/sandbox/e2b-provider'
import { SandboxSpendGuard } from '../src/sandbox/spend-guard'
import { SandboxError } from '../src/sandbox/errors'
import { FileSpendLedger, committedNanoUsd } from '../src/lib/file-spend-ledger'
import { sandboxCostNanoUsd } from '../src/sandbox/e2b-pricing'

const results: Array<{ check: string; pass: boolean; detail?: string }> = []
const check = (name: string, pass: boolean, detail?: string) => {
  results.push({ check: name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`)
}
const curl = (url: string) => `curl -s -o /dev/null -m 8 -w '%{http_code}' ${url} || true`
const code = async (p: Promise<unknown>) => {
  try { await p; return 'ok' } catch (e) { return e instanceof SandboxError ? e.code : `untyped:${(e as Error)?.name}` }
}

const RES = { cpuCount: 2, memoryMB: 4096 }
const TIMEOUT_MS = 600_000
const WORST = sandboxCostNanoUsd(RES, TIMEOUT_MS / 1000)

async function main() {
  const apiKey = process.env.E2B_API_KEY
  if (!apiKey) throw new Error('Refused: E2B_API_KEY is not set.')
  const leaked = ['GEMINI_API_KEY', 'ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEY_NEW', 'OPENAI_API_KEY', 'XAI_API_KEY', 'TOGETHER_API_KEY', 'MINIMAX_API_KEY', 'GENX_ROUTER_FORGE_TOKEN'].filter((k) => process.env[k])
  if (leaked.length) throw new Error(`Refused: provider keys present in env: ${leaked.join(', ')}`)
  const paid = process.env.FORGE_E2B_PAID_APPROVED === 'step2-smoke'
  const capUsd = Number(process.env.FORGE_SMOKE_CAP_USD ?? '0.5')
  if (!(capUsd > 0 && capUsd <= 0.5)) throw new Error('Refused: FORGE_SMOKE_CAP_USD must be > 0 and <= 0.50')
  const dataDir = process.env.FORGE_DATA_DIR
  if (!dataDir) throw new Error('Refused: FORGE_DATA_DIR is not set.')
  mkdirSync(dataDir, { recursive: true })
  const deployment = `forge-smoke-${Date.now().toString(36)}`
  const real = realE2BApi(apiKey)
  const ledger = new FileSpendLedger(join(dataDir, SANDBOX_LEDGER_FILE))
  const tinyLedger = new FileSpendLedger(join(dataDir, 'smoke-402-ledger.json'))
  let createCalls = 0
  const committedAtCreate: number[] = []
  const api: E2BApi = {
    ...real,
    create: (t, o) => { createCalls++; committedAtCreate.push(committedNanoUsd(ledger.read())); return real.create(t, o) },
  }
  const mk = (o: Partial<ConstructorParameters<typeof E2BSandboxProvider>[0]> = {}) => new E2BSandboxProvider({
    api, guard: new SandboxSpendGuard(ledger, capUsd), template: 'base', resources: RES,
    timeoutMs: TIMEOUT_MS, maxConcurrent: 1, deployment, ...o,
  })

  console.log(JSON.stringify({ phase: 'free', deployment, capUsd, worstCasePerSandboxUsd: WORST / 1e9 }))
  // 402: cap $0.001 < $0.0276 worst case
  {
    const before = createCalls
    const p = mk({ guard: new SandboxSpendGuard(tinyLedger, 0.001) })
    const c = await code(p.create({ template: 'node', envAllowlist: [] }))
    check('402 cap reached refuses before E2B', c === 'sandbox_spend_cap_reached' && createCalls === before && tinyLedger.read().entries.length === 0, `code=${c} e2bCreateCalls=${createCalls - before}`)
  }
  // 503: unknown template
  {
    const p = mk({ template: 'forge-template-that-does-not-exist-0' })
    const c = await code(p.create({ template: 'node', envAllowlist: [] }))
    const st = ledger.read()
    const last = st.entries[st.entries.length - 1]
    const left = await real.list({ forgeDeployment: deployment })
    check('503 create failed releases the reservation', c === 'sandbox_create_failed' && last?.status !== 'reserved' && (last?.settledNanoUsd ?? -1) === 0 && left.length === 0, `code=${c} reservedAtCreate=${committedAtCreate.at(-1)} settled=${last?.settledNanoUsd} leftover=${left.length}`)
  }
  if (!paid) {
    console.log('Paid phase skipped (FORGE_E2B_PAID_APPROVED is not step2-smoke).')
    return summary(ledger)
  }

  console.log(JSON.stringify({ phase: 'paid' }))
  const p = mk()
  const base = committedNanoUsd(ledger.read())
  const t0 = Date.now()
  const a = await p.create({ template: 'node', envAllowlist: [] })
  console.log(JSON.stringify({ sandboxId: a.id, createMs: Date.now() - t0 }))
  check('reserve before create ($0.0276 / 10 min held when E2B create was called)', committedAtCreate.at(-1)! - base === WORST && WORST === 27_600_000, `heldNano=${committedAtCreate.at(-1)! - base}`)
  let killedOutOfBand = false
  try {
    check('deny-all: https://example.com blocked', (await p.exec(a.id, curl('https://example.com'))).stdout.trim() === '000')
    check('deny-all: raw IP http://1.1.1.1 blocked', (await p.exec(a.id, curl('http://1.1.1.1'))).stdout.trim() === '000')
    const dns = await p.exec(a.id, 'getent hosts example.com || echo NXDOMAIN')
    check('deny-all: no DNS', dns.stdout.includes('NXDOMAIN'))
    const envs = await p.exec(a.id, "env | grep -ciE 'api_key|token|secret' || true")
    check('no host secrets in sandbox env', envs.stdout.trim() === '0', `matches=${envs.stdout.trim()}`)
    await p.setEgressAllowlist(a.id, ['registry.npmjs.org'])
    check('allow rule: registry.npmjs.org answers', (await p.exec(a.id, curl('https://registry.npmjs.org/phaser'))).stdout.trim() === '200')
    check('allow rule: example.com still blocked', (await p.exec(a.id, curl('https://example.com'))).stdout.trim() === '000')
    check('allow rule: raw IP still blocked', (await p.exec(a.id, curl('http://1.1.1.1'))).stdout.trim() === '000')
    await p.setEgressAllowlist(a.id, [])
    check('tightened to deny-all: registry blocked', (await p.exec(a.id, curl('https://registry.npmjs.org/phaser'))).stdout.trim() === '000')
    // 429
    const before = createCalls
    const committed429 = committedNanoUsd(ledger.read())
    const c429 = await code(p.create({ template: 'node', envAllowlist: [] }))
    check('429 limit refuses before E2B and reserves nothing', c429 === 'sandbox_limit_reached' && createCalls === before && committedNanoUsd(ledger.read()) === committed429, `code=${c429}`)
    // 410: kill on E2B directly, then use it
    await real.kill(a.id)
    killedOutOfBand = true
    const c410 = await code(p.exec(a.id, 'true'))
    const open = ledger.read().entries.filter((e) => e.status === 'reserved').length
    check('410 gone after out-of-band kill; reservation settled', c410 === 'sandbox_gone' && open === 0 && p.size === 0, `code=${c410} open=${open}`)
  } finally {
    if (!killedOutOfBand) await p.destroy(a.id).catch(() => undefined)
  }
  // 504: request timeout far below boot time
  {
    const q = mk({ createTimeoutMs: 1 })
    const c = await code(q.create({ template: 'node', envAllowlist: [] }))
    await new Promise((r) => setTimeout(r, 5000))
    // a VM may finish booting after the client gave up; reap anything with this deployment tag
    const reaped = await q.reapOrphans()
    check('504 create timeout; orphan (if any) killed', c === 'sandbox_create_timeout', `code=${c} lateOrphansReaped=${reaped}`)
  }
  return summary(ledger, real, deployment)
}

async function summary(ledger: FileSpendLedger, real?: E2BApi, deployment?: string) {
  const st = ledger.read()
  check('ledger has no open reservations', st.entries.every((e) => e.status !== 'reserved'), `${st.entries.length} entries`)
  if (real && deployment) {
    await new Promise((r) => setTimeout(r, 3000))
    const left = await real.list({ forgeDeployment: deployment })
    check('E2B lists no sandboxes for this run', left.length === 0)
  }
  const spent = st.entries.reduce((s, e) => s + (e.settledNanoUsd ?? e.reservedNanoUsd), 0)
  console.log(JSON.stringify({ ledgerCommittedUsd: spent / 1e9, entries: st.entries.map((e) => ({ status: e.status, reservedUsd: e.reservedNanoUsd / 1e9, settledUsd: (e.settledNanoUsd ?? null) === null ? null : e.settledNanoUsd! / 1e9, outcome: e.outcome, ref: e.ref })), passed: results.filter((r) => r.pass).length, total: results.length }))
  if (results.some((r) => !r.pass)) process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof SandboxError ? `${err.code}: ${err.message}` : err instanceof Error ? err.message : 'step2-smoke failed')
  process.exitCode = 1
})
