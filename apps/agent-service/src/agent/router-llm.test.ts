import { afterEach, describe, expect, it, vi } from 'vitest'
import { parseServerEnv, type AgentEvent } from '@forge/shared'
import { createLlmClient } from './llm'
import { RouterLlmClient, RouterLlmError } from './router-llm'
import { LlmPlanner } from './planner'
import { Agent, ApprovalGate, QuestionGate } from './agent'
import { createToolSet, MockBrowserTool } from './tools'
import { MockSandboxProvider } from '../sandbox/mock-provider'

// Unit tests: fetch is mocked here, and ONLY here. The live proof is docs/verification/step1.md.
const token = 'forge-unit-test-only-app-token-32-chars'
const payload = {
  text: 'const score = 1', provider: 'together', modelId: 'deepseek-ai/DeepSeek-V4.1-Flash-1017',
  upstreamModel: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', upstreamId: 'cmpl-1', truncated: false, requestId: 'req-1',
  usage: { inputTokens: 120, outputTokens: 30, cachedInputTokens: 0, costUsd: 0.00009 },
}
const opts = { model: 'ignored/direct-model', messages: [{ role: 'user' as const, content: 'Build game' }] }
afterEach(() => vi.unstubAllGlobals())

describe('createLlmClient fails closed', () => {
  it('keeps mock as the default only outside production', () => {
    expect(createLlmClient(parseServerEnv({})).kind).toBe('mock')
  })
  it('refuses the offline mock in production when nothing is configured', () => {
    const env = parseServerEnv({ NODE_ENV: 'production', AGENT_SERVICE_SECRET: 'x'.repeat(40), ALLOWED_ORIGINS: 'https://forge.example' })
    expect(() => createLlmClient(env)).toThrow('refusing the offline mock in production')
  })
  it('selects Router before direct or BYO keys and refuses partial config, in every environment', () => {
    const env = parseServerEnv({ GENX_ROUTER_URL: 'https://router.example', GENX_ROUTER_FORGE_TOKEN: token,
      OPENROUTER_API_KEY: 'not-real', ANTHROPIC_API_KEY: 'not-real' })
    expect(createLlmClient(env, { anthropic: 'not-real' }).kind).toBe('genx-router')
    for (const NODE_ENV of ['development', 'production'] as const) {
      const base = { NODE_ENV, AGENT_SERVICE_SECRET: 'x'.repeat(40), ALLOWED_ORIGINS: 'https://forge.example', OPENROUTER_API_KEY: 'not-real' }
      expect(() => createLlmClient(parseServerEnv({ ...base, GENX_ROUTER_URL: 'https://router.example' }))).toThrow('Both GENX_ROUTER')
      expect(() => createLlmClient(parseServerEnv({ ...base, GENX_ROUTER_FORGE_TOKEN: token }))).toThrow('Both GENX_ROUTER')
    }
  })
  it('rejects a short token and a non-HTTPS public origin', () => {
    expect(() => parseServerEnv({ GENX_ROUTER_URL: 'https://router.example', GENX_ROUTER_FORGE_TOKEN: 'short' })).toThrow()
    expect(() => createLlmClient(parseServerEnv({ GENX_ROUTER_URL: 'http://router.example', GENX_ROUTER_FORGE_TOKEN: token }))).toThrow('HTTPS origin')
  })
})

describe('server-only GenX Router LLM client', () => {
  it('sends only messages and the app token to the exact Router endpoint, and records real usage', async () => {
    const fetch = vi.fn(async () => Response.json(payload))
    vi.stubGlobal('fetch', fetch)
    const chunk = vi.fn()
    const client = new RouterLlmClient('https://router.example', token)
    expect(await client.complete({ ...opts, onChunk: chunk })).toBe(payload.text)
    expect(fetch).toHaveBeenCalledTimes(1)
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://router.example/api/forge/coding-complete')
    expect(init.redirect).toBe('error')
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${token}`)
    expect(JSON.parse(init.body as string)).toEqual({ messages: opts.messages })
    expect(chunk).toHaveBeenCalledWith(payload.text)
    expect(client.lastCall).toEqual({ requestId: 'req-1', modelId: payload.modelId, upstreamModel: payload.upstreamModel, upstreamId: 'cmpl-1',
      inputTokens: 120, outputTokens: 30, cachedInputTokens: 0, costUsd: 0.00009 })
  })
  it.each(['http://public.example', 'https://router.example/api', 'https://u:p@router.example', 'https://router.example?key=x'])('rejects unsafe origins %s', origin => {
    expect(() => new RouterLlmClient(origin, token)).toThrow('HTTPS origin')
  })
  it('sends the Vercel protection bypass only when configured, and rejects a bad one', async () => {
    const seen: Record<string, string>[] = []
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>)
      return new Response(JSON.stringify(payload), { status: 200 })
    }))
    await new RouterLlmClient('https://router.example', token).complete(opts)
    await new RouterLlmClient('https://router.example', token, { protectionBypass: 'b'.repeat(32) }).complete(opts)
    expect(seen[0]!['x-vercel-protection-bypass']).toBeUndefined()
    expect(seen[1]!['x-vercel-protection-bypass']).toBe('b'.repeat(32))
    expect(() => new RouterLlmClient('https://router.example', token, { protectionBypass: 'short' })).toThrow('PROTECTION_BYPASS')
    expect(() => new RouterLlmClient('https://router.example', token, { protectionBypass: `${'b'.repeat(20)}\r\nx: y` })).toThrow('PROTECTION_BYPASS')
    const env = parseServerEnv({ GENX_ROUTER_URL: 'https://router.example', GENX_ROUTER_FORGE_TOKEN: token, GENX_ROUTER_PROTECTION_BYPASS: 'c'.repeat(32) })
    await createLlmClient(env).complete(opts)
    expect(seen[2]!['x-vercel-protection-bypass']).toBe('c'.repeat(32))
  })

  it('refuses use in a browser', () => {
    vi.stubGlobal('window', {})
    expect(() => new RouterLlmClient('https://router.example', token)).toThrow('server-only')
  })
  it.each([
    { ...payload, provider: 'deepseek' }, { ...payload, modelId: 'other' },
    { ...payload, text: '' }, { ...payload, truncated: true }, { ...payload, usage: undefined },
    { ...payload, usage: { ...payload.usage, costUsd: -1 } }, { ...payload, requestId: undefined },
  ])('fails closed for an unpinned, incomplete or unmetered result %j', async bad => {
    const fetch = vi.fn(async () => Response.json(bad)); vi.stubGlobal('fetch', fetch)
    const err = await new RouterLlmClient('https://router.example', token).complete(opts).catch(e => e)
    expect(err).toBeInstanceOf(RouterLlmError); expect(err.code).toBe('invalid_router_response')
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it.each([
    [402, { code: 'spend_cap_exceeded', requestId: 'r2' }, 'spend cap is reached'],
    [503, { code: 'coding_disabled' }, 'switched off'],
    [401, { code: 'unauthorized' }, 'rejected the Forge app token'],
    [502, { code: 'upstream_auth_failed', upstreamStatus: 401 }, 'upstream HTTP 401'],
    [504, { code: 'upstream_timeout' }, 'Together timed out'],
    [502, { code: 'upstream_malformed' }, 'malformed'],
    [500, { code: 'made-up', error: 'private data sk-123' }, 'unrecognised error'],
    [503, 'private data, not json', 'unrecognised error'],
  ] as const)('maps Router %i %j to a clean typed error, never echoing server text', async (status, body, words) => {
    const fetch = vi.fn(async () => typeof body === 'string' ? new Response(body, { status }) : Response.json(body, { status }))
    vi.stubGlobal('fetch', fetch)
    const err = await new RouterLlmClient('https://router.example', token).complete(opts).catch(e => e)
    expect(err).toBeInstanceOf(RouterLlmError)
    expect(err.status).toBe(status)
    expect(err.message).toContain(words); expect(err.message).toContain('No fallback')
    expect(err.message).not.toContain('private'); expect(err.message).not.toContain(token)
    expect(fetch).toHaveBeenCalledTimes(1)
  })
  it('router unreachable', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('connect ECONNREFUSED') }))
    await expect(new RouterLlmClient('http://127.0.0.1:1', token).complete(opts)).rejects.toMatchObject({ code: 'router_unreachable' })
  })
  it('caps requests and responses', async () => {
    const fetch = vi.fn(async () => new Response('x'.repeat(131_073))); vi.stubGlobal('fetch', fetch)
    const client = new RouterLlmClient('https://router.example', token)
    await expect(client.complete({ ...opts, messages: [{ role: 'user', content: 'x'.repeat(16_384) }] })).rejects.toMatchObject({ code: 'request_too_large' })
    expect(fetch).not.toHaveBeenCalled()
    await expect(client.complete(opts)).rejects.toMatchObject({ code: 'invalid_router_response' })
  })
  it('propagates cancellation without a provider fallback', async () => {
    const controller = new AbortController(); controller.abort()
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => { init.signal.throwIfAborted(); return Response.json(payload) }))
    await expect(new RouterLlmClient('http://127.0.0.1:4318', token).complete({ ...opts, signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
  })
  it('the agent loop surfaces a Router refusal as one clean error event and does nothing else', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ code: 'spend_cap_exceeded', requestId: 'r9' }, { status: 402 })))
    const sandbox = new MockSandboxProvider()
    const session = await sandbox.create({ template: 'node', envAllowlist: [] })
    const events: AgentEvent[] = []
    try {
      const agent = new Agent(createToolSet(sandbox, session.id, new MockBrowserTool()))
      const planner = new LlmPlanner(new RouterLlmClient('https://router.example', token), 'ignored')
      const result = await agent.run({ task: 'Plan a change', planner, approvals: new ApprovalGate(), questions: new QuestionGate() }, e => events.push(e))
      expect(result.ok).toBe(false)
      expect(events.map(e => e.type)).toEqual(['error', 'done'])
      const error = events[0]
      expect(error?.type === 'error' && error.message).toBe('Router coding call failed: the Router spend cap is reached, so the call was not sent (spend_cap_exceeded, HTTP 402, request r9). No fallback or automatic retry.')
    } finally { await sandbox.destroy(session.id) }
  })
})
