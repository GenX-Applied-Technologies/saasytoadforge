// This module belongs only to agent-service; never import from apps/web.
import type { CompleteOptions, LlmClient } from './llm'

export const ROUTER_CODING_MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'
const PATH = '/api/forge/coding-complete'
const MAX_REQUEST_BYTES = 16_384
const MAX_RESPONSE_BYTES = 131_072
const TIMEOUT_MS = 130_000

/**
 * Router error codes this client recognises, each with the message the agent loop
 * shows. The Router's own text is never echoed: only a known code maps to words.
 */
const ROUTER_CODES: Record<string, string> = {
  unauthorized: 'the Router rejected the Forge app token',
  app_credential_unconfigured: 'the Router has no independent Forge app token configured',
  production_disabled: 'coding calls are disabled on this Router environment',
  coding_disabled: 'the coding model is switched off on the Router',
  together_key_missing: 'the Router has no Together credential configured',
  endpoint_override_refused: 'the Router refused a Together endpoint override',
  spend_cap_unconfigured: 'the Router spend cap is not configured',
  spend_ledger_unavailable: 'the Router spend ledger is unavailable',
  spend_cap_exceeded: 'the Router spend cap is reached, so the call was not sent',
  invalid_request: 'the Router rejected the request shape',
  call_limit: 'the Router call limit is reached',
  upstream_auth_failed: 'Together rejected the Router credential',
  upstream_model_unavailable: 'the pinned model is unavailable on Together US',
  upstream_rate_limited: 'Together rate-limited the call',
  upstream_rejected_request: 'Together rejected the request',
  upstream_error: 'Together returned a server error',
  upstream_timeout: 'Together timed out',
  upstream_unreachable: 'Together could not be reached',
  upstream_truncated: 'the model output hit its token ceiling',
  upstream_malformed: 'Together returned a malformed response',
  upstream_model_mismatch: 'Together reported a different model than the pinned one',
  output_too_large: 'the model output was too large',
}

export type RouterErrorCode = keyof typeof ROUTER_CODES | 'router_unknown_error' | 'router_unreachable' | 'router_timeout' | 'cancelled' | 'invalid_router_response' | 'request_too_large'

/** A Router failure the agent loop can show as-is: code + HTTP status, never server text. */
export class RouterLlmError extends Error {
  constructor(
    readonly code: RouterErrorCode,
    readonly status?: number,
    readonly upstreamStatus?: number,
    readonly requestId?: string,
  ) {
    const reason = ROUTER_CODES[code] ?? {
      router_unknown_error: 'the Router returned an unrecognised error',
      router_unreachable: 'the Router could not be reached',
      router_timeout: 'the Router did not answer in time',
      cancelled: 'the request was cancelled',
      invalid_router_response: 'the Router response failed validation',
      request_too_large: 'the coding input exceeds 16 KiB',
    }[code as string] ?? 'the Router call failed'
    const bits = [code, status ? `HTTP ${status}` : '', upstreamStatus ? `upstream HTTP ${upstreamStatus}` : '', requestId ? `request ${requestId}` : '']
    super(`Router coding call failed: ${reason} (${bits.filter(Boolean).join(', ')}). No fallback or automatic retry.`)
    this.name = 'RouterLlmError'
  }
}

export interface RouterCallRecord {
  requestId: string
  modelId: string
  upstreamModel: string | null
  upstreamId: string | null
  inputTokens: number
  outputTokens: number
  cachedInputTokens: number
  costUsd: number
}

const SAFE_ID = /^[A-Za-z0-9_.:-]{1,80}$/
const safeId = (v: unknown): string | undefined => (typeof v === 'string' && SAFE_ID.test(v) ? v : undefined)
const count = (v: unknown): number | null => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0 ? v : null)

async function readCapped(res: Response): Promise<string> {
  if (!res.body) return ''
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let bytes = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      bytes += value.byteLength
      if (bytes > MAX_RESPONSE_BYTES) { await reader.cancel(); throw new RouterLlmError('invalid_router_response', res.status) }
      chunks.push(value)
    }
  } finally { reader.releaseLock() }
  return Buffer.concat(chunks).toString('utf8')
}

/** Server-to-server client. No operator token, model selection, fallback or retry. */
export class RouterLlmClient implements LlmClient {
  readonly kind = 'genx-router' as const
  private readonly endpoint: string
  /** The last successful call's Router request id, model and real usage (numbers only). */
  lastCall: RouterCallRecord | null = null

  constructor(origin: string, private readonly appToken: string) {
    if ('window' in globalThis) throw new Error('RouterLlmClient is server-only')
    const url = new URL(origin)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/')
      throw new Error('GENX_ROUTER_URL must be an HTTPS origin (HTTP loopback for local tests only)')
    if (appToken.length < 32 || /[\r\n]/.test(appToken))
      throw new Error('GENX_ROUTER_FORGE_TOKEN must be an independent 32+ character app token')
    this.endpoint = new URL(PATH, url).toString()
  }

  async complete(opts: CompleteOptions): Promise<string> {
    const body = JSON.stringify({ messages: opts.messages })
    if (Buffer.byteLength(body) > MAX_REQUEST_BYTES) throw new RouterLlmError('request_too_large')
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout

    let res: Response
    try {
      res = await fetch(this.endpoint, {
        method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${this.appToken}`, 'content-type': 'application/json' },
        body, signal,
      })
    } catch {
      if (opts.signal?.aborted) throw new RouterLlmError('cancelled')
      if (timeout.aborted) throw new RouterLlmError('router_timeout')
      throw new RouterLlmError('router_unreachable')
    }

    let text: string
    try { text = await readCapped(res) }
    catch (error) {
      if (error instanceof RouterLlmError) throw error
      if (opts.signal?.aborted) throw new RouterLlmError('cancelled')
      throw new RouterLlmError(timeout.aborted ? 'router_timeout' : 'router_unreachable', res.status)
    }
    let json: Record<string, unknown> | null = null
    try {
      const parsed: unknown = JSON.parse(text)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) json = parsed as Record<string, unknown>
    } catch { json = null }
    const requestId = safeId(json?.requestId) ?? safeId(res.headers.get('x-forge-request-id'))

    if (!res.ok) {
      const code = typeof json?.code === 'string' && Object.prototype.hasOwnProperty.call(ROUTER_CODES, json.code) ? json.code : 'router_unknown_error'
      const upstreamStatus = count(json?.upstreamStatus) ?? undefined
      throw new RouterLlmError(code as RouterErrorCode, res.status, upstreamStatus, requestId)
    }

    const usage = json?.usage as Record<string, unknown> | undefined
    const inputTokens = count(usage?.inputTokens)
    const outputTokens = count(usage?.outputTokens)
    const cost = typeof usage?.costUsd === 'number' && Number.isFinite(usage.costUsd) && usage.costUsd >= 0 ? usage.costUsd : null
    if (!json || json.provider !== 'together' || json.modelId !== ROUTER_CODING_MODEL || json.truncated === true ||
        typeof json.text !== 'string' || !json.text.trim() || inputTokens === null || outputTokens === null || cost === null || !requestId)
      throw new RouterLlmError('invalid_router_response', res.status, undefined, requestId)

    this.lastCall = {
      requestId,
      modelId: ROUTER_CODING_MODEL,
      upstreamModel: typeof json.upstreamModel === 'string' ? json.upstreamModel : null,
      upstreamId: safeId(json.upstreamId) ?? null,
      inputTokens, outputTokens,
      cachedInputTokens: count(usage?.cachedInputTokens) ?? 0,
      costUsd: cost,
    }
    opts.onChunk?.(json.text) // non-streaming API: emit once, only after full validation
    return json.text
  }
}
