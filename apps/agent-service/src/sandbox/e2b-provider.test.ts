import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { CommandExitError, SandboxNotFoundError, TimeoutError, type SandboxOpts } from 'e2b'
import { E2BSandboxProvider, type E2BApi, type E2BSandboxHandle } from './e2b-provider'
import { SandboxSpendGuard } from './spend-guard'
import { FileSpendLedger } from '../lib/file-spend-ledger'
import { SandboxError } from './errors'
import { sandboxCostNanoUsd } from './e2b-pricing'

// Fake E2B control plane + sandboxes. No network, no E2B account: everything here is free.
interface FakeSbx {
  id: string
  opts: SandboxOpts
  network: { allowOut: string[]; denyOut: string[]; dnsServers?: string[] }
  allowInternetAccess: boolean
  cpuCount: number
  memoryMB: number
  killed: boolean
  files: Map<string, string>
  rootCmds: string[]
  updateNetworkCalls: unknown[]
}

class FakeE2B implements E2BApi {
  sandboxes: FakeSbx[] = []
  createImpl: ((opts: SandboxOpts) => Promise<void>) | null = null
  listFails = false
  /** Override what getInfo reports (simulates E2B not applying the policy). */
  infoOverride: Partial<{ network: FakeSbx['network']; allowInternetAccess: boolean; cpuCount: number; memoryMB: number }> | null = null
  updateNetworkFails = false
  runImpl: ((cmd: string) => Promise<unknown>) | null = null
  hostsExit = 0
  private n = 0

  async create(_template: string, opts: SandboxOpts): Promise<E2BSandboxHandle> {
    const id = `sbx${++this.n}`
    const fake: FakeSbx = {
      id, opts, killed: false, files: new Map(), rootCmds: [], updateNetworkCalls: [],
      allowInternetAccess: opts.allowInternetAccess !== false,
      network: {
        allowOut: (opts.network?.allowOut as string[]) ?? [],
        denyOut: (opts.network?.denyOut as string[]) ?? (opts.allowInternetAccess === false ? ['0.0.0.0/0'] : []),
        dnsServers: opts.network?.dnsServers,
      },
      cpuCount: 2, memoryMB: 4096,
    }
    this.sandboxes.push(fake) // "started" on E2B's side even if the call then fails
    if (this.createImpl) await this.createImpl(opts)
    return this.handle(fake)
  }

  handle = (f: FakeSbx): E2BSandboxHandle => {
    const alive = () => { if (f.killed) throw new SandboxNotFoundError('gone') }
    return {
      sandboxId: f.id,
      getInfo: async () => {
        alive()
        return { sandboxId: f.id, network: f.network, allowInternetAccess: f.allowInternetAccess, cpuCount: f.cpuCount, memoryMB: f.memoryMB, ...this.infoOverride } as never
      },
      updateNetwork: async (o: { allowOut?: string[]; denyOut?: string[]; dnsServers?: string[]; allowInternetAccess?: boolean }) => {
        alive()
        f.updateNetworkCalls.push(o)
        if (this.updateNetworkFails && (o.allowOut?.length ?? 0) > 0) throw new Error('boom')
        f.network = { allowOut: o.allowOut ?? [], denyOut: o.denyOut ?? [], dnsServers: o.dnsServers ?? ['8.8.8.8'] }
        f.allowInternetAccess = o.allowInternetAccess ?? true
      },
      async kill() { f.killed = true; return true },
      commands: {
        run: async (cmd: string, o?: { user?: string }) => {
          alive()
          if (o?.user === 'root') { f.rootCmds.push(cmd); return { exitCode: this.hostsExit, stdout: '', stderr: '' } }
          if (this.runImpl) return this.runImpl(cmd)
          return { exitCode: 0, stdout: `ran:${cmd}`, stderr: '' }
        },
      },
      files: {
        async write(p: string, c: string) { alive(); f.files.set(p, c) },
        async read(p: string) { alive(); return f.files.get(p) ?? '' },
        async remove(p: string) { alive(); f.files.delete(p) },
        async list() { alive(); return [] },
      },
      pty: {} as never,
    } as unknown as E2BSandboxHandle
  }

  async list(metadata: Record<string, string>) {
    if (this.listFails) throw new Error('api down')
    return this.sandboxes
      .filter((s) => !s.killed && Object.entries(metadata).every(([k, v]) => (s.opts.metadata as Record<string, string>)?.[k] === v))
      .map((s) => ({ sandboxId: s.id, metadata: s.opts.metadata as Record<string, string> }))
  }

  async kill(id: string) {
    const s = this.sandboxes.find((x) => x.id === id)
    if (!s || s.killed) return false
    s.killed = true
    return true
  }
}

const RES = { cpuCount: 2, memoryMB: 4096 }
const TIMEOUT_MS = 600_000
const WORST = sandboxCostNanoUsd(RES, 600) // 27_600_000 nano = $0.0276

function setup(o: { capUsd?: number; maxConcurrent?: number; now?: () => number } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'forge-e2b-'))
  const ledger = new FileSpendLedger(join(dir, 'ledger.json'), o.now)
  const guard = new SandboxSpendGuard(ledger, o.capUsd ?? 3, o.now)
  const api = new FakeE2B()
  const provider = new E2BSandboxProvider({
    api, guard, template: 'forge-node22-phaser', resources: RES, timeoutMs: TIMEOUT_MS,
    maxConcurrent: o.maxConcurrent ?? 2, deployment: 'forge-test',
    resolve: async (h) => (h === 'registry.npmjs.org' ? '104.16.0.35' : '93.184.215.14'),
  })
  return { api, provider, ledger }
}
const open = (l: FileSpendLedger) => l.read().entries.filter((e) => e.status === 'reserved')

afterEach(() => vi.useRealTimers())

describe('E2BSandboxProvider: create', () => {
  it('reserves the worst case first, then creates deny-all with kill-on-timeout and tags', async () => {
    const { api, provider, ledger } = setup()
    const sbx = await provider.create({ template: 'node', envAllowlist: [] })
    expect(sbx.template).toBe('forge-node22-phaser')
    const opts = api.sandboxes[0]!.opts
    expect(opts).toMatchObject({ allowInternetAccess: false, timeoutMs: TIMEOUT_MS, lifecycle: { onTimeout: 'kill' }, envs: {} })
    expect(opts.metadata).toMatchObject({ forgeDeployment: 'forge-test' })
    expect(opts.network).toBeUndefined()
    expect(open(ledger)).toHaveLength(1)
    expect(open(ledger)[0]!.reservedNanoUsd).toBe(WORST)
    // resolv.conf cleared as root even with no allowlist
    expect(api.sandboxes[0]!.rootCmds[0]).toContain(': > /etc/resolv.conf')
  })

  it('creates an allowlist sandbox with deny 0.0.0.0/0, exact names, no DNS server, and pinned hosts', async () => {
    const { api, provider } = setup()
    await provider.create({ template: 'node', envAllowlist: [], egressAllowlist: ['Registry.NPMJS.org.', 'registry.npmjs.org'] })
    const f = api.sandboxes[0]!
    expect(f.opts).toMatchObject({ allowInternetAccess: true, network: { denyOut: ['0.0.0.0/0'], allowOut: ['registry.npmjs.org'], dnsServers: [] } })
    expect(f.files.get('/tmp/forge-egress-hosts')).toContain('104.16.0.35 registry.npmjs.org')
  })

  it('refuses wildcard, IP, CIDR and >10 domain allowlists before spending anything', async () => {
    const { api, provider, ledger } = setup()
    for (const bad of [['*.npmjs.org'], ['1.1.1.1'], ['10.0.0.0/8'], ['bad host'], Array.from({ length: 11 }, (_, i) => `h${i}.example.com`)]) {
      await expect(provider.create({ template: 'node', envAllowlist: [], egressAllowlist: bad })).rejects.toMatchObject({ code: 'sandbox_egress_invalid' })
    }
    expect(api.sandboxes).toHaveLength(0)
    expect(ledger.read().entries).toHaveLength(0)
  })

  it('cap reached: refuses with sandbox_spend_cap_reached and never calls E2B', async () => {
    const { api, provider } = setup({ capUsd: 0.05 }) // fits one $0.0276 reservation, not two
    await provider.create({ template: 'node', envAllowlist: [] })
    const err = await provider.create({ template: 'node', envAllowlist: [] }).catch((e) => e)
    expect(err).toBeInstanceOf(SandboxError)
    expect(err.code).toBe('sandbox_spend_cap_reached')
    expect(api.sandboxes).toHaveLength(1)
  })

  it('cap survives restarts: a new provider on the same ledger still sees open reservations', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'forge-e2b-'))
    const mk = () => new E2BSandboxProvider({
      api: new FakeE2B(), guard: new SandboxSpendGuard(new FileSpendLedger(join(dir, 'l.json')), 0.05),
      template: 't', resources: RES, timeoutMs: TIMEOUT_MS, maxConcurrent: 2, deployment: 'forge-test',
    })
    await mk().create({ template: 'node', envAllowlist: [] }) // "crash": never destroyed
    await expect(mk().create({ template: 'node', envAllowlist: [] })).rejects.toMatchObject({ code: 'sandbox_spend_cap_reached' })
  })

  it('ledger unavailable: refuses (fail closed)', async () => {
    // Parent "directory" is a regular file, so the ledger can be neither created nor read.
    const blocker = join(mkdtempSync(join(tmpdir(), 'forge-e2b-')), 'not-a-dir')
    writeFileSync(blocker, 'x')
    const guard = new SandboxSpendGuard(new FileSpendLedger(join(blocker, 'ledger.json')), 3)
    const api = new FakeE2B()
    const provider = new E2BSandboxProvider({ api, guard, template: 't', resources: RES, timeoutMs: TIMEOUT_MS, maxConcurrent: 2, deployment: 'd' })
    await expect(provider.create({ template: 'node', envAllowlist: [] })).rejects.toMatchObject({ code: 'sandbox_spend_ledger_unavailable' })
    expect(api.sandboxes).toHaveLength(0)
  })

  it('concurrency limit: refuses the third live sandbox with sandbox_limit_reached', async () => {
    const { api, provider } = setup({ maxConcurrent: 2 })
    await Promise.all([provider.create({ template: 'n', envAllowlist: [] }), provider.create({ template: 'n', envAllowlist: [] })])
    await expect(provider.create({ template: 'n', envAllowlist: [] })).rejects.toMatchObject({ code: 'sandbox_limit_reached' })
    expect(api.sandboxes).toHaveLength(2)
  })

  it('create failure: releases the reservation to $0 once E2B confirms nothing is running', async () => {
    const { api, provider, ledger } = setup()
    api.createImpl = async () => { throw new Error('quota') }
    api.sandboxes = []
    const origCreate = api.create.bind(api)
    api.create = async (t, o) => { await origCreate(t, o).catch(() => undefined); api.sandboxes.pop(); throw new Error('quota') }
    await expect(provider.create({ template: 'n', envAllowlist: [] })).rejects.toMatchObject({ code: 'sandbox_create_failed' })
    const [e] = ledger.read().entries
    expect(e).toMatchObject({ status: 'settled', settledNanoUsd: 0, outcome: 'create_failed' })
  })

  it('create timeout: kills the sandbox that did boot and settles it as an orphan', async () => {
    const { api, provider, ledger } = setup()
    api.createImpl = async () => { throw new TimeoutError('request timed out') }
    await expect(provider.create({ template: 'n', envAllowlist: [] })).rejects.toMatchObject({ code: 'sandbox_create_timeout' })
    expect(api.sandboxes[0]!.killed).toBe(true)
    expect(ledger.read().entries[0]).toMatchObject({ status: 'settled', outcome: 'create_orphan_killed' })
  })

  it('create failure with E2B unreachable: keeps the full worst case reserved', async () => {
    const { api, provider, ledger } = setup()
    api.createImpl = async () => { throw new TimeoutError('t') }
    api.listFails = true
    await expect(provider.create({ template: 'n', envAllowlist: [] })).rejects.toMatchObject({ code: 'sandbox_create_timeout' })
    expect(open(ledger)).toHaveLength(1)
    expect(open(ledger)[0]!.reservedNanoUsd).toBe(WORST)
  })

  it('egress not applied by E2B: kills the sandbox and fails closed', async () => {
    const { api, provider, ledger } = setup()
    api.infoOverride = { allowInternetAccess: true, network: { allowOut: [], denyOut: [] } }
    await expect(provider.create({ template: 'n', envAllowlist: [] })).rejects.toMatchObject({ code: 'sandbox_egress_unverified' })
    expect(api.sandboxes[0]!.killed).toBe(true)
    expect(open(ledger)).toHaveLength(0)
    expect(provider.size).toBe(0)
  })

  it('allowlist reported with a DNS server open: kills it (DNS would be an exfil channel)', async () => {
    const { api, provider } = setup()
    api.infoOverride = { network: { allowOut: ['registry.npmjs.org'], denyOut: ['0.0.0.0/0'], dnsServers: ['8.8.8.8'] } }
    await expect(provider.create({ template: 'n', envAllowlist: [], egressAllowlist: ['registry.npmjs.org'] })).rejects.toMatchObject({ code: 'sandbox_egress_unverified' })
    expect(api.sandboxes[0]!.killed).toBe(true)
  })

  it('oversized sandbox (template bigger than the priced size): kills it', async () => {
    const { api, provider } = setup()
    api.infoOverride = { cpuCount: 8 }
    await expect(provider.create({ template: 'n', envAllowlist: [] })).rejects.toMatchObject({ code: 'sandbox_resources_exceeded' })
    expect(api.sandboxes[0]!.killed).toBe(true)
  })

  it('hosts pinning fails: kills it', async () => {
    const { api, provider } = setup()
    api.hostsExit = 1
    await expect(provider.create({ template: 'n', envAllowlist: [] })).rejects.toMatchObject({ code: 'sandbox_egress_unverified' })
    expect(api.sandboxes[0]!.killed).toBe(true)
  })
})

describe('E2BSandboxProvider: egress updates', () => {
  it('replaces rules, always with dnsServers [] (omitting it would reopen 8.8.8.8)', async () => {
    const { api, provider } = setup()
    const s = await provider.create({ template: 'n', envAllowlist: [] })
    await provider.setEgressAllowlist(s.id, ['registry.npmjs.org'])
    expect(api.sandboxes[0]!.updateNetworkCalls.at(-1)).toEqual({ denyOut: ['0.0.0.0/0'], allowOut: ['registry.npmjs.org'], dnsServers: [] })
    await provider.setEgressAllowlist(s.id, [])
    expect(api.sandboxes[0]!.updateNetworkCalls.at(-1)).toEqual({ allowInternetAccess: false, denyOut: ['0.0.0.0/0'], dnsServers: [] })
  })

  it('a failed update tightens to deny-all and surfaces the error', async () => {
    const { api, provider } = setup()
    const s = await provider.create({ template: 'n', envAllowlist: [] })
    api.updateNetworkFails = true
    await expect(provider.setEgressAllowlist(s.id, ['registry.npmjs.org'])).rejects.toMatchObject({ code: 'sandbox_egress_unverified' })
    expect(api.sandboxes[0]!.updateNetworkCalls.at(-1)).toMatchObject({ allowInternetAccess: false, denyOut: ['0.0.0.0/0'] })
  })

  it('an update E2B does not reflect is rejected and tightened', async () => {
    const { api, provider } = setup()
    const s = await provider.create({ template: 'n', envAllowlist: [] })
    api.infoOverride = { network: { allowOut: ['registry.npmjs.org', 'evil.example.com'], denyOut: ['0.0.0.0/0'], dnsServers: [] }, allowInternetAccess: true }
    await expect(provider.setEgressAllowlist(s.id, ['registry.npmjs.org'])).rejects.toMatchObject({ code: 'sandbox_egress_unverified' })
  })

  it('refuses an invalid allowlist without touching the sandbox', async () => {
    const { api, provider } = setup()
    const s = await provider.create({ template: 'n', envAllowlist: [] })
    await expect(provider.setEgressAllowlist(s.id, ['*'])).rejects.toMatchObject({ code: 'sandbox_egress_invalid' })
    expect(api.sandboxes[0]!.updateNetworkCalls).toHaveLength(0)
  })
})

describe('E2BSandboxProvider: running, timeout and teardown', () => {
  it('exec returns non-zero exits as results and maps a command timeout', async () => {
    const { api, provider } = setup()
    const s = await provider.create({ template: 'n', envAllowlist: [] })
    api.runImpl = async () => { throw new CommandExitError({ exitCode: 2, stdout: 'o', stderr: 'e', error: 'x' } as never) }
    expect(await provider.exec(s.id, 'false')).toMatchObject({ exitCode: 2, stdout: 'o', stderr: 'e' })
    api.runImpl = async () => { throw new TimeoutError('slow') }
    await expect(provider.exec(s.id, 'sleep 999')).rejects.toMatchObject({ code: 'sandbox_command_timeout' })
  })

  it('a sandbox E2B already killed (timeout) surfaces sandbox_gone and is settled', async () => {
    const { api, provider, ledger } = setup()
    const s = await provider.create({ template: 'n', envAllowlist: [] })
    api.sandboxes[0]!.killed = true
    await expect(provider.exec(s.id, 'ls')).rejects.toMatchObject({ code: 'sandbox_gone' })
    await expect(provider.readFile(s.id, 'a.txt')).rejects.toMatchObject({ code: 'sandbox_unknown' })
    expect(ledger.read().entries[0]).toMatchObject({ status: 'settled', outcome: 'gone' })
  })

  it('destroy kills and settles to elapsed seconds', async () => {
    let t = 1_000_000
    const { api, provider, ledger } = setup({ now: () => t })
    const s = await provider.create({ template: 'n', envAllowlist: [] })
    t += 90_500
    await provider.destroy(s.id)
    expect(api.sandboxes[0]!.killed).toBe(true)
    expect(ledger.read().entries[0]).toMatchObject({ status: 'settled', outcome: 'destroyed', seconds: 91, settledNanoUsd: sandboxCostNanoUsd(RES, 91) })
    await provider.destroy(s.id) // idempotent
  })

  it('expiry timer settles at most the timeout even if the process lives longer', async () => {
    vi.useFakeTimers()
    let t = 0
    const { api, provider, ledger } = setup({ now: () => t })
    await provider.create({ template: 'n', envAllowlist: [] })
    t = TIMEOUT_MS * 3
    await vi.advanceTimersByTimeAsync(TIMEOUT_MS + 5_000)
    expect(provider.size).toBe(0)
    expect(api.sandboxes[0]!.killed).toBe(true)
    expect(ledger.read().entries[0]).toMatchObject({ outcome: 'expired', seconds: 600, settledNanoUsd: WORST })
  })

  it('shutdown kills everything it owns; reapOrphans kills only this deployment\'s leftovers', async () => {
    const { api, provider } = setup()
    await provider.create({ template: 'n', envAllowlist: [] })
    await provider.shutdown()
    expect(api.sandboxes.every((s) => s.killed)).toBe(true)

    const leftover = await api.create('t', { metadata: { forgeDeployment: 'forge-test', forgeNonce: 'x' } })
    const other = await api.create('t', { metadata: { forgeDeployment: 'someone-else' } })
    const mine = await provider.create({ template: 'n', envAllowlist: [] })
    expect(await provider.reapOrphans()).toBe(1)
    expect(api.sandboxes.find((s) => s.id === leftover.sandboxId)!.killed).toBe(true)
    expect(api.sandboxes.find((s) => s.id === other.sandboxId)!.killed).toBe(false)
    expect(api.sandboxes.find((s) => s.id === mine.id)!.killed).toBe(false)
  })

  it('rejects path traversal before reaching E2B', async () => {
    const { provider } = setup()
    const s = await provider.create({ template: 'n', envAllowlist: [] })
    await expect(provider.writeFile(s.id, '../../etc/passwd', 'x')).rejects.toThrow()
  })
})
