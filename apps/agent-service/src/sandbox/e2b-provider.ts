import { randomUUID } from 'node:crypto'
import {
  Sandbox,
  CommandExitError,
  FileType,
  TimeoutError,
  SandboxNotFoundError,
  SandboxNotRunningError,
  type SandboxInfo,
  type SandboxOpts,
} from 'e2b'
import type {
  AsyncShellSession,
  CreateSandboxOptions,
  ExecOptions,
  ExecResult,
  FileEntry,
  Sandbox as ForgeSandbox,
  SandboxProvider,
} from '@forge/shared'
import { Pushable } from './pushable'
import { assertSafePath } from '../lib/paths'
import { logger } from '../lib/logger'
import { SandboxError } from './errors'
import {
  APPLY_HOSTS_SCRIPT,
  hostsBlock,
  networkCreateOptions,
  networkMatches,
  networkUpdate,
  normalizeEgressAllowlist,
  resolvePublicIPv4,
  type Resolver,
} from './egress-policy'
import type { SandboxResources } from './e2b-pricing'
import type { SandboxReservation, SandboxSpendGuard } from './spend-guard'

/** The parts of an E2B sandbox this provider uses. */
export type E2BSandboxHandle = Pick<Sandbox, 'sandboxId' | 'commands' | 'files' | 'pty' | 'updateNetwork' | 'getInfo' | 'kill'>

/** The E2B control-plane calls this provider makes. `realE2BApi` is the only production implementation. */
export interface E2BApi {
  create(template: string, opts: SandboxOpts): Promise<E2BSandboxHandle>
  list(metadata: Record<string, string>): Promise<Array<Pick<SandboxInfo, 'sandboxId' | 'metadata'>>>
  kill(sandboxId: string): Promise<boolean>
}

export function realE2BApi(apiKey: string): E2BApi {
  return {
    create: (template, opts) => Sandbox.create(template, { ...opts, apiKey }),
    async list(metadata) {
      const pager = Sandbox.list({ apiKey, query: { metadata, state: ['running', 'paused'] } })
      const out: SandboxInfo[] = []
      while (pager.hasNext) out.push(...(await pager.nextItems()))
      return out
    },
    kill: (sandboxId) => Sandbox.kill(sandboxId, { apiKey }),
  }
}

export interface E2BProviderOptions {
  api: E2BApi
  guard: SandboxSpendGuard
  /** Template name or id (custom offline template on staging). */
  template: string
  /** Largest size the template may give a sandbox; reservations are priced at this size. */
  resources: SandboxResources
  /** Sandbox lifetime; E2B kills it at this point (lifecycle onTimeout: kill). */
  timeoutMs: number
  maxConcurrent: number
  /** Tag written to every sandbox's metadata so orphans of THIS deployment can be reaped. */
  deployment: string
  createTimeoutMs?: number
  resolve?: Resolver
}

interface Live {
  sbx: E2BSandboxHandle
  reservation: SandboxReservation
  template: string
  egress: string[]
  timer: NodeJS.Timeout
}

const DEFAULT_CREATE_TIMEOUT_MS = 60_000
const EXPIRY_GRACE_MS = 5_000

const isGone = (err: unknown) =>
  err instanceof SandboxNotFoundError || err instanceof SandboxNotRunningError

/** E2B's TimeoutError, plus the DOMException/AbortError that AbortSignal.timeout throws on requestTimeoutMs. */
const isTimeout = (err: unknown) =>
  err instanceof TimeoutError
  || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))

/**
 * Real microVM sandbox via E2B (Firecracker), SDK 2.x. Untrusted/agent code runs here, never
 * on the host. Every sandbox:
 *  - is paid for in advance against a fail-closed sandbox-time cap (SandboxSpendGuard);
 *  - starts with egress already restricted by E2B network rules (deny all, or deny all except
 *    exact hostnames with no DNS server reachable), verified by reading the policy back;
 *  - is killed by E2B at its timeout, and settled + forgotten here at the same moment;
 *  - carries deployment metadata so leftovers from a crash are reaped at the next boot.
 */
export class E2BSandboxProvider implements SandboxProvider {
  private readonly live = new Map<string, Live>()
  private pending = 0
  private readonly resolve: Resolver

  constructor(private readonly o: E2BProviderOptions) {
    this.resolve = o.resolve ?? resolvePublicIPv4
  }

  private get(id: string): Live {
    const l = this.live.get(id)
    if (!l) throw new SandboxError('sandbox_unknown')
    return l
  }

  /** Map SDK failures on a live sandbox to typed errors; a vanished sandbox is settled and dropped. */
  private async fail(id: string, err: unknown): Promise<never> {
    if (isGone(err)) {
      await this.forget(id, 'gone')
      throw new SandboxError('sandbox_gone')
    }
    if (err instanceof TimeoutError) throw new SandboxError('sandbox_command_timeout')
    throw err
  }

  async create(opts: CreateSandboxOptions): Promise<ForgeSandbox> {
    const egress = normalizeEgressAllowlist(opts.egressAllowlist ?? [])
    const template = this.o.template
    if (this.live.size + this.pending >= this.o.maxConcurrent) throw new SandboxError('sandbox_limit_reached')
    this.pending++
    try {
      const nonce = randomUUID()
      const reservation = await this.o.guard.reserve(`nonce:${nonce}`, this.o.resources, Math.ceil(this.o.timeoutMs / 1000))
      let sbx: E2BSandboxHandle
      try {
        sbx = await this.o.api.create(template, {
          timeoutMs: this.o.timeoutMs,
          requestTimeoutMs: this.o.createTimeoutMs ?? DEFAULT_CREATE_TIMEOUT_MS,
          lifecycle: { onTimeout: 'kill' },
          metadata: { forgeDeployment: this.o.deployment, forgeNonce: nonce },
          envs: {},
          ...networkCreateOptions(egress),
        })
      } catch (err) {
        await this.recoverFailedCreate(reservation, nonce, err)
        throw new SandboxError(isTimeout(err) ? 'sandbox_create_timeout' : 'sandbox_create_failed')
      }

      // From here the microVM is live and billing. Any failure below kills it before surfacing.
      try {
        const info = await sbx.getInfo()
        if (info.cpuCount > this.o.resources.cpuCount || info.memoryMB > this.o.resources.memoryMB) {
          throw new SandboxError('sandbox_resources_exceeded', `${info.cpuCount} vCPU / ${info.memoryMB} MiB`)
        }
        if (!networkMatches(info, egress)) throw new SandboxError('sandbox_egress_unverified')
        await this.pinHosts(sbx, egress)
      } catch (err) {
        await sbx.kill().catch(() => undefined)
        await this.o.guard.settleElapsed(reservation, 'setup_failed', `sbx:${sbx.sandboxId}`).catch(() => undefined)
        throw err instanceof SandboxError ? err : new SandboxError('sandbox_create_failed')
      }

      const timer = setTimeout(() => void this.expire(sbx.sandboxId), this.o.timeoutMs + EXPIRY_GRACE_MS)
      timer.unref()
      this.live.set(sbx.sandboxId, { sbx, reservation, template, egress, timer })
      logger.info('sandbox.created', { sandboxId: sbx.sandboxId, template, egressDomains: egress.length })
      return { id: sbx.sandboxId, template, createdAt: new Date(reservation.startedAtMs).toISOString() }
    } finally {
      this.pending--
    }
  }

  /**
   * A failed create may still have started a sandbox on E2B's side (e.g. the request timed out
   * after the VM booted). Find it by its nonce and kill it. The reservation is released only
   * when E2B confirms nothing is running; if E2B cannot be asked, the worst case stays charged.
   */
  private async recoverFailedCreate(r: SandboxReservation, nonce: string, err: unknown): Promise<void> {
    let found: Array<Pick<SandboxInfo, 'sandboxId'>>
    try {
      found = await this.o.api.list({ forgeDeployment: this.o.deployment, forgeNonce: nonce })
    } catch {
      logger.warn('sandbox.create_failed_unverified', { error: err instanceof Error ? err.name : 'unknown' })
      return // reservation stays open at full worst case
    }
    for (const s of found) await this.o.api.kill(s.sandboxId).catch(() => false)
    const settled =
      found.length === 0
        ? this.o.guard.settle(r, 0, 'create_failed') // E2B confirms nothing ran: release fully
        : this.o.guard.settleElapsed(r, 'create_orphan_killed')
    await settled.then(() => undefined, () => undefined)
  }

  private async pinHosts(sbx: E2BSandboxHandle, egress: string[]): Promise<void> {
    if (egress.length > 0) await sbx.files.write('/tmp/forge-egress-hosts', await hostsBlock(egress, this.resolve))
    const res = await sbx.commands.run(APPLY_HOSTS_SCRIPT, { user: 'root', timeoutMs: 15_000 })
    if (res.exitCode !== 0) throw new SandboxError('sandbox_egress_unverified', 'hosts pinning failed')
  }

  private async expire(id: string): Promise<void> {
    const l = this.live.get(id)
    if (!l) return
    // E2B has already killed it at its timeout; kill again (idempotent) to be sure.
    await this.o.api.kill(id).catch(() => false)
    await this.forget(id, 'expired')
    logger.info('sandbox.expired', { sandboxId: id })
  }

  private async forget(id: string, outcome: string): Promise<void> {
    const l = this.live.get(id)
    if (!l) return
    clearTimeout(l.timer)
    this.live.delete(id)
    await this.o.guard.settleElapsed(l.reservation, outcome, `sbx:${id}`).catch((err) => {
      logger.warn('sandbox.settle_failed', { sandboxId: id, error: err instanceof Error ? err.message : 'unknown' })
    })
  }

  async exec(id: string, cmd: string, opts?: ExecOptions): Promise<ExecResult> {
    const { sbx } = this.get(id)
    const start = performance.now()
    try {
      const res = await sbx.commands.run(cmd, { timeoutMs: opts?.timeoutMs ?? 60_000 })
      return { exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr, durationMs: Math.round(performance.now() - start) }
    } catch (err) {
      if (err instanceof CommandExitError) {
        return { exitCode: err.exitCode, stdout: err.stdout, stderr: err.stderr, durationMs: Math.round(performance.now() - start) }
      }
      return this.fail(id, err)
    }
  }

  async writeFile(id: string, path: string, contents: string): Promise<void> {
    await this.get(id).sbx.files.write(assertSafePath(path), contents).catch((e: unknown) => this.fail(id, e))
  }

  async readFile(id: string, path: string): Promise<string> {
    return this.get(id).sbx.files.read(assertSafePath(path)).catch((e: unknown) => this.fail(id, e))
  }

  async deleteFile(id: string, path: string): Promise<void> {
    // Use the filesystem API, never a shell string, so a path can never inject shell commands.
    try {
      await this.get(id).sbx.files.remove(assertSafePath(path))
    } catch (err) {
      if (isGone(err)) await this.fail(id, err)
      // Idempotent: removing a path that is already gone is not an error.
    }
  }

  async listFiles(id: string, dir: string): Promise<FileEntry[]> {
    const entries = await this.get(id)
      .sbx.files.list(dir ? assertSafePath(dir) : '.')
      .catch((e: unknown) => this.fail(id, e))
    return entries.map((entry) => ({
      path: entry.path,
      name: entry.name,
      type: entry.type === FileType.DIR ? 'dir' : 'file',
      size: entry.size,
    }))
  }

  openShell(id: string): AsyncShellSession {
    const { sbx } = this.get(id)
    const stream = new Pushable<string>()
    const decoder = new TextDecoder()
    const encoder = new TextEncoder()
    let pid: number | null = null
    const pending: string[] = []

    const handle = sbx.pty
      .create({
        cols: 80,
        rows: 24,
        // 0 = no PTY timeout (the SDK default of 60 s would cut the terminal off after a
        // minute); the sandbox's own timeout still bounds it.
        timeoutMs: 0,
        onData: (data: Uint8Array) => stream.push(decoder.decode(data)),
      })
      .then((h) => {
        pid = h.pid
        for (const data of pending) void sbx.pty.sendInput(pid, encoder.encode(data))
        pending.length = 0
        return h
      })
      .catch(() => {
        stream.push('\r\n[forge] the sandbox shell could not be opened\r\n')
        return null
      })

    return {
      output: stream,
      async write(data: string): Promise<void> {
        if (pid !== null) await sbx.pty.sendInput(pid, encoder.encode(data))
        else pending.push(data)
      },
      async resize(cols: number, rows: number): Promise<void> {
        if (pid !== null) await sbx.pty.resize(pid, { cols, rows })
      },
      async close(): Promise<void> {
        await handle
        if (pid !== null) await sbx.pty.kill(pid).catch(() => false)
        stream.end()
      },
    }
  }

  /**
   * Replace the running sandbox's egress rules (E2B updateNetwork replaces, never merges) and
   * verify by reading them back. On any failure the sandbox is tightened to deny-all and the
   * error is surfaced, so a failed update can never leave egress wider than requested.
   */
  async setEgressAllowlist(id: string, domains: string[]): Promise<void> {
    const l = this.get(id)
    const egress = normalizeEgressAllowlist(domains)
    try {
      await l.sbx.updateNetwork(networkUpdate(egress))
      const info = await l.sbx.getInfo()
      if (!networkMatches(info, egress)) throw new SandboxError('sandbox_egress_unverified')
      await this.pinHosts(l.sbx, egress)
      l.egress = egress
    } catch (err) {
      if (isGone(err)) return this.fail(id, err)
      await l.sbx.updateNetwork(networkUpdate([])).catch(() => undefined)
      l.egress = []
      throw err instanceof SandboxError ? err : new SandboxError('sandbox_egress_unverified')
    }
  }

  async checkpoint(id: string): Promise<string> {
    // Shadow git: GIT_DIR/GIT_WORK_TREE point at a private repo so we never create a .git
    // in the workspace or touch any real history the project may have. node_modules and
    // build output are excluded so snapshots stay fast. Returns the commit SHA as the ref.
    const cmd = `sh -c '
      export GIT_DIR="$HOME/.forge-shadow.git" GIT_WORK_TREE="$HOME"
      if [ ! -d "$GIT_DIR" ]; then
        git init -q
        git config user.email forge@saasytoad.local
        git config user.name "Forge"
        mkdir -p "$GIT_DIR/info"
        printf "node_modules/\\n.next/\\ndist/\\n.cache/\\n.git/\\n" > "$GIT_DIR/info/exclude"
      fi
      git add -A
      git commit -q --allow-empty -m "forge checkpoint" >/dev/null 2>&1 || true
      git rev-parse HEAD
    '`
    const res = await this.exec(id, cmd)
    const ref = res.stdout.trim()
    if (res.exitCode !== 0 || !ref) {
      throw new Error(`e2b checkpoint failed: ${res.stderr || res.stdout || 'no commit'}`)
    }
    return ref
  }

  async restore(id: string, ref: string): Promise<void> {
    // ref is always a commit SHA we produced; reject anything else so it can't be used for
    // shell injection.
    if (!/^[0-9a-f]{7,40}$/.test(ref)) throw new Error('e2b restore: invalid checkpoint ref')
    const cmd = `sh -c 'export GIT_DIR="$HOME/.forge-shadow.git" GIT_WORK_TREE="$HOME"; git reset --hard ${ref} -q'`
    const res = await this.exec(id, cmd)
    if (res.exitCode !== 0) throw new Error(`e2b restore failed: ${res.stderr || res.stdout}`)
  }

  /**
   * Kill and settle. If E2B cannot be reached the sandbox stays tracked (its reservation stays
   * open at the worst case and its expiry timer still fires), and the error is surfaced.
   */
  async destroy(id: string): Promise<void> {
    const l = this.live.get(id)
    if (!l) return
    try {
      await l.sbx.kill()
    } catch (err) {
      if (!isGone(err)) throw new SandboxError('sandbox_create_failed', 'kill failed; will retry at expiry')
    }
    await this.forget(id, 'destroyed')
  }

  /** Kill every sandbox this process owns (SIGTERM / Fly auto-stop). */
  async shutdown(): Promise<void> {
    await Promise.all([...this.live.keys()].map((id) => this.destroy(id).catch(() => undefined)))
  }

  /**
   * Kill sandboxes tagged with this deployment that this process does not own: leftovers from a
   * crash or a stop. Their old reservations stay at full worst case (stricter, never looser).
   */
  async reapOrphans(): Promise<number> {
    const found = await this.o.api.list({ forgeDeployment: this.o.deployment })
    let killed = 0
    for (const s of found) {
      if (this.live.has(s.sandboxId)) continue
      if (await this.o.api.kill(s.sandboxId).catch(() => false)) killed++
    }
    if (killed) logger.info('sandbox.orphans_reaped', { count: killed })
    return killed
  }

  /** Ledger health for /ready: throws if the ledger cannot be read or written. */
  async spendStatus(): Promise<{ committedNanoUsd: number; capNanoUsd: number }> {
    return { committedNanoUsd: await this.o.guard.committedNanoUsd(), capNanoUsd: this.o.guard.capNanoUsd }
  }

  /** Live sandbox count, for readiness and tests. */
  get size(): number {
    return this.live.size
  }
}
