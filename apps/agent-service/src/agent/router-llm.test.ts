import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseServerEnv } from '@forge/shared'
import { createLlmClient } from './llm'
import { RouterLlmClient } from './router-llm'

const token = 'forge-unit-test-only-app-token-32-chars'
const payload = { text: 'const score = 1', provider: 'together', modelId: 'deepseek-ai/DeepSeek-V4.1-Flash-1017' }
const opts = { model: 'ignored/direct-model', messages: [{ role: 'user' as const, content: 'Build game' }] }
afterEach(() => vi.unstubAllGlobals())

describe('server-only GenX Router LLM client', () => {
  it('keeps mock as default without credentials', () => {
    expect(createLlmClient(parseServerEnv({})).kind).toBe('mock')
  })
  it('selects Router before direct or BYO keys and refuses partial config', () => {
    const env = parseServerEnv({ GENX_ROUTER_URL: 'https://router.example', GENX_ROUTER_FORGE_TOKEN: token,
      OPENROUTER_API_KEY: 'not-real', ANTHROPIC_API_KEY: 'not-real' })
    expect(createLlmClient(env, { anthropic: 'not-real' }).kind).toBe('genx-router')
    expect(() => createLlmClient(parseServerEnv({ GENX_ROUTER_URL: 'https://router.example' }))).toThrow('Both GENX_ROUTER')
    expect(() => createLlmClient(parseServerEnv({ GENX_ROUTER_FORGE_TOKEN: token }))).toThrow('Both GENX_ROUTER')
  })
  it('sends only messages and the app token to the exact Router endpoint', async () => {
    const fetch = vi.fn(async () => Response.json(payload))
    vi.stubGlobal('fetch', fetch)
    const chunk = vi.fn()
    expect(await new RouterLlmClient('https://router.example', token).complete({ ...opts, onChunk: chunk })).toBe(payload.text)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://router.example/api/forge/coding-complete')
    expect(init.redirect).toBe('error')
    expect(init.headers).toEqual({ authorization: `Bearer ${token}`, 'content-type': 'application/json' })
    expect(JSON.parse(init.body as string)).toEqual({ messages: opts.messages })
    expect(chunk).toHaveBeenCalledWith(payload.text)
  })
  it.each(['http://public.example', 'https://router.example/api', 'https://u:p@router.example', 'https://router.example?key=x'])('rejects unsafe origins %s', origin => {
    expect(() => new RouterLlmClient(origin, token)).toThrow('HTTPS origin')
  })
  it('refuses use in a browser', () => {
    vi.stubGlobal('window', {})
    expect(() => new RouterLlmClient('https://router.example', token)).toThrow('server-only')
  })
  it.each([
    { ...payload, provider: 'deepseek' }, { ...payload, modelId: 'other' },
    { ...payload, text: '' }, { ...payload, truncated: true },
  ])('fails closed for an unpinned or incomplete result %j', async bad => {
    const fetch = vi.fn(async () => Response.json(bad)); vi.stubGlobal('fetch', fetch)
    await expect(new RouterLlmClient('https://router.example', token).complete(opts)).rejects.toThrow('no fallback')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('does not retry or echo server errors', async () => {
    const fetch = vi.fn(async () => new Response('private data', { status: 503 })); vi.stubGlobal('fetch', fetch)
    await expect(new RouterLlmClient('https://router.example', token).complete(opts)).rejects.toThrow('no fallback')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('caps requests and responses', async () => {
    const fetch = vi.fn(async () => new Response('x'.repeat(131_073))); vi.stubGlobal('fetch', fetch)
    const client = new RouterLlmClient('https://router.example', token)
    await expect(client.complete({ ...opts, messages: [{ role: 'user', content: 'x'.repeat(16_384) }] })).rejects.toThrow('16 KiB')
    expect(fetch).not.toHaveBeenCalled()
    await expect(client.complete(opts)).rejects.toThrow('no fallback')
  })
  it('propagates cancellation without a provider fallback', async () => {
    const controller = new AbortController(); controller.abort()
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { init.signal.throwIfAborted(); return Response.json(payload) }))
    await expect(new RouterLlmClient('http://127.0.0.1:4318', token).complete({ ...opts, signal: controller.signal })).rejects.toThrow('cancelled')
  })
})
