/**
 * The sandbox abstraction. Untrusted / agent-generated code runs ONLY through a
 * SandboxProvider (see SECURITY in ARCHITECTURE.md). The host control plane never
 * executes untrusted code. Default implementation targets microVM/gVisor isolation;
 * the interface stays clean so another provider can swap in.
 */

export interface ExecResult {
  exitCode: number
  stdout: string
  stderr: string
  durationMs: number
}

export interface FileEntry {
  /** Path relative to the sandbox workspace root. */
  path: string
  name: string
  type: 'file' | 'dir'
  size?: number
}

export interface Sandbox {
  id: string
  template: string
  /** ISO 8601 creation timestamp. */
  createdAt: string
}

export interface CreateSandboxOptions {
  template: string
  /** Environment variable names allowed to be injected into the sandbox. */
  envAllowlist: string[]
  /**
   * Domains the sandbox is allowed to reach. An empty list means default-deny: the sandbox
   * gets no outbound network. Real providers must honor this at create time, not after.
   */
  egressAllowlist?: string[]
}

export interface ExecOptions {
  timeoutMs?: number
}

/** A live, streamed shell session bridged to the editor terminal (xterm). */
export interface AsyncShellSession {
  /** Stream of raw terminal output chunks. */
  output: AsyncIterable<string>
  /** Write user keystrokes / commands into the shell. */
  write(data: string): Promise<void>
  /** Resize the pseudo-terminal. */
  resize(cols: number, rows: number): Promise<void>
  close(): Promise<void>
}

export interface SandboxProvider {
  create(opts: CreateSandboxOptions): Promise<Sandbox>
  exec(id: string, cmd: string, opts?: ExecOptions): Promise<ExecResult>
  writeFile(id: string, path: string, contents: string): Promise<void>
  readFile(id: string, path: string): Promise<string>
  deleteFile(id: string, path: string): Promise<void>
  listFiles(id: string, dir: string): Promise<FileEntry[]>
  /** Streamed to the xterm terminal. */
  openShell(id: string): AsyncShellSession
  /** Default-deny egress; only these domains (plus package registries) are reachable. */
  setEgressAllowlist(id: string, domains: string[]): Promise<void>
  /**
   * Snapshot the workspace filesystem and return an opaque ref. The basis for safe
   * autonomy: the agent can roll back to a checkpoint when an edit or a verification step
   * goes wrong, so no single bad action is unrecoverable.
   */
  checkpoint(id: string): Promise<string>
  /** Restore the workspace filesystem to a prior checkpoint ref from `checkpoint`. */
  restore(id: string, ref: string): Promise<void>
  destroy(id: string): Promise<void>
  /** Kill every sandbox this process owns (graceful shutdown). Optional for in-memory providers. */
  shutdown?(): Promise<void>
  /** Kill leftover sandboxes from an earlier crash of this deployment; returns how many. */
  reapOrphans?(): Promise<number>
}
