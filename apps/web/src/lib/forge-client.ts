import type {
  FileEntry,
  ExecResult,
  ConfigSummary,
  SpendSummaryDto,
  SessionDto,
  Plan,
  ReviewVerdict,
  DeployResult,
} from '@forge/shared'

export interface Workspace {
  id: string
  sandboxId: string
  owner: string
  createdAt: string
}

const BASE = process.env.NEXT_PUBLIC_AGENT_SERVICE_URL ?? 'http://localhost:8787'

export function agentServiceBase(): string {
  return BASE
}

/** Derive a websocket channel URL from an http(s) base. Pure for testability. */
export function toWsUrl(
  base: string,
  workspaceId: string,
  channel: 'shell' | 'agent' = 'shell',
): string {
  return `${base.replace(/^http/, 'ws')}/workspaces/${workspaceId}/${channel}`
}

// ---- Auth: fetch a signed token from the web app, attach it to agent-service calls ----

let cachedToken: string | null = null

export async function agentToken(): Promise<string> {
  if (cachedToken) return cachedToken
  const res = await fetch('/api/agent-token')
  if (!res.ok) throw new Error('forge-client: not authenticated')
  const { token } = (await res.json()) as { token: string }
  cachedToken = token
  return token
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) throw new Error(`forge-client: ${res.status} ${res.statusText}`)
  return res.json() as Promise<T>
}

/** Authenticated agent-service call: attaches the bearer token, refreshes once on 401. */
async function authed<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers)
  headers.set('authorization', `Bearer ${await agentToken()}`)
  let res = await fetch(`${BASE}${path}`, { ...init, headers })
  if (res.status === 401) {
    cachedToken = null
    headers.set('authorization', `Bearer ${await agentToken()}`)
    res = await fetch(`${BASE}${path}`, { ...init, headers })
  }
  return asJson<T>(res)
}

export async function shellUrl(workspaceId: string): Promise<string> {
  return `${toWsUrl(BASE, workspaceId, 'shell')}?token=${encodeURIComponent(await agentToken())}`
}

export async function agentUrl(workspaceId: string): Promise<string> {
  return `${toWsUrl(BASE, workspaceId, 'agent')}?token=${encodeURIComponent(await agentToken())}`
}

const JSON_HEADERS = { 'content-type': 'application/json' }

export async function createWorkspace(): Promise<Workspace> {
  return authed('/workspaces', { method: 'POST' })
}

export async function listWorkspaces(): Promise<Workspace[]> {
  return authed('/workspaces')
}

export async function deleteWorkspace(id: string): Promise<void> {
  await authed(`/workspaces/${id}`, { method: 'DELETE' })
}

export async function listFiles(id: string, dir = ''): Promise<FileEntry[]> {
  return authed(`/workspaces/${id}/files?dir=${encodeURIComponent(dir)}`)
}

export async function readFile(id: string, path: string): Promise<string> {
  const { contents } = await authed<{ contents: string }>(
    `/workspaces/${id}/file?path=${encodeURIComponent(path)}`,
  )
  return contents
}

export async function writeFile(id: string, path: string, contents: string): Promise<void> {
  await authed(`/workspaces/${id}/file`, {
    method: 'PUT',
    headers: JSON_HEADERS,
    body: JSON.stringify({ path, contents }),
  })
}

export async function deleteFile(id: string, path: string): Promise<void> {
  await authed(`/workspaces/${id}/file?path=${encodeURIComponent(path)}`, {
    method: 'DELETE',
  })
}

export async function exec(id: string, cmd: string): Promise<ExecResult> {
  return authed(`/workspaces/${id}/exec`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ cmd }),
  })
}

/** Ask Ronald to review the workspace before a deploy. */
export async function reviewWorkspace(id: string): Promise<ReviewVerdict> {
  return authed(`/workspaces/${id}/review`, { method: 'POST' })
}

/** Deploy. Ronald reviews first; pass force to deploy past a not-ready verdict. */
export async function deployWorkspace(id: string, force = false): Promise<DeployResult> {
  return authed(`/workspaces/${id}/deploy`, {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ force }),
  })
}

export async function getSpend(id: string): Promise<SpendSummaryDto> {
  return authed(`/workspaces/${id}/spend`)
}

export async function getSessions(id: string): Promise<SessionDto[]> {
  return authed(`/workspaces/${id}/sessions`)
}

export async function createCheckout(
  planId: string,
): Promise<{ url: string; mode: 'mock' | 'stripe' }> {
  const res = await fetch('/api/billing/checkout', {
    method: 'POST',
    headers: JSON_HEADERS,
    body: JSON.stringify({ planId }),
  })
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `Checkout failed with status ${res.status}`)
  }
  return res.json() as Promise<{ url: string; mode: 'mock' | 'stripe' }>
}

/** Full config (models, caps, secret-present flags) requires a signed agent token. */
export async function getConfig(): Promise<ConfigSummary> {
  return authed('/config')
}

/** Harmless public subset: no model IDs, spend caps, or secret-present flags. */
export async function getPublicConfig(): Promise<{ service: string; billingConfigured: boolean }> {
  return asJson(await fetch(`${BASE}/config/public`))
}

export async function getPlans(): Promise<Plan[]> {
  return asJson(await fetch(`${BASE}/billing/plans`))
}

export async function getAdminStats(): Promise<{
  workspaces: Workspace[]
  globalSpend: number
  caps: { perUserUsd: number; globalUsd: number }
  users: Array<{ userId: string; usd: number }>
}> {
  return authed('/admin/stats')
}
