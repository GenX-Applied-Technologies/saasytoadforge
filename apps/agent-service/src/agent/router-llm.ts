// This module belongs only to agent-service; never import from apps/web.
import type { CompleteOptions, LlmClient } from './llm'

const MODEL = 'deepseek-ai/DeepSeek-V4.1-Flash-1017'

/** Server-to-server client. No operator token, model selection, fallback or retry. */
export class RouterLlmClient implements LlmClient {
  readonly kind = 'genx-router' as const
  private readonly endpoint: string

  constructor(origin: string, private readonly appToken: string) {
    if ('window' in globalThis) throw new Error('RouterLlmClient is server-only')
    const url = new URL(origin)
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)
    if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:')) ||
        url.username || url.password || url.search || url.hash || url.pathname !== '/')
      throw new Error('GENX_ROUTER_URL must be an HTTPS origin (HTTP loopback for local tests only)')
    if (appToken.length < 32 || /[\r\n]/.test(appToken))
      throw new Error('GENX_ROUTER_FORGE_TOKEN must be an independent 32+ character app token')
    this.endpoint = new URL('/api/forge/coding-complete', url).toString()
  }

  async complete(opts: CompleteOptions): Promise<string> {
    const body = JSON.stringify({ messages: opts.messages })
    if (Buffer.byteLength(body) > 16_384) throw new Error('Router coding input exceeds 16 KiB')
    try {
      const timeout = AbortSignal.timeout(130_000)
      const signal = opts.signal ? AbortSignal.any([opts.signal, timeout]) : timeout
      const res = await fetch(this.endpoint, {
        method: 'POST', redirect: 'error',
        headers: { authorization: `Bearer ${this.appToken}`, 'content-type': 'application/json' },
        body, signal,
      })
      // Do not echo server bodies, which could include secrets/prompt material.
      if (!res.ok) throw new Error('Router request refused')
      if (!res.body) throw new Error('Empty Router response')
      const reader = res.body.getReader()
      const chunks: Uint8Array[] = []
      let bytes = 0
      try {
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          bytes += value.byteLength
          if (bytes > 131_072) { await reader.cancel(); throw new Error('Router response exceeds limit') }
          chunks.push(value)
        }
      } finally { reader.releaseLock() }
      const result = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
      if (result.provider !== 'together' || result.modelId !== MODEL ||
          result.truncated === true || typeof result.text !== 'string' || !result.text.trim())
        throw new Error('Invalid Router response')
      opts.onChunk?.(result.text) // non-streaming API: emit once, only after full validation
      return result.text
    } catch {
      if (opts.signal?.aborted) throw new Error('Router coding request cancelled')
      throw new Error('Router coding completion failed; no fallback or automatic retry')
    }
  }
}
