import type { ServerEnv } from '@forge/shared'
import { RouterLlmClient } from './router-llm'
export { RouterLlmClient } from './router-llm'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CompleteOptions {
  model: string
  messages: LlmMessage[]
  onChunk?: (text: string) => void
  signal?: AbortSignal
}

export interface LlmClient {
  /** Streams chunks to onChunk (if provided) and resolves with the full text. */
  complete(opts: CompleteOptions): Promise<string>
  readonly kind: 'mock' | 'openrouter' | 'anthropic' | 'google' | 'genx-router'
}

/** Deterministic stand-in used until OPENROUTER_API_KEY is supplied. */
export class MockLlmClient implements LlmClient {
  readonly kind = 'mock' as const

  async complete(opts: CompleteOptions): Promise<string> {
    const lastUser = [...opts.messages].reverse().find((m) => m.role === 'user')
    const userPrompt = lastUser?.content ?? ''

    const text =
      `Ronald here, running in offline mode. I read your request: "${userPrompt.slice(0, 280)}". ` +
      `Add an Anthropic or Google key in settings, or set OPENROUTER_API_KEY, and I will work it for real.`
    for (const word of text.split(' ')) {
      opts.onChunk?.(`${word} `)
    }
    return text
  }
}

/**
 * OpenRouter-backed client (chat completions, SSE streaming). Only constructed when a
 * key is present; callers fall back to MockLlmClient otherwise.
 */
export class OpenRouterLlmClient implements LlmClient {
  readonly kind = 'openrouter' as const
  private readonly endpoint = 'https://openrouter.ai/api/v1/chat/completions'

  constructor(private readonly apiKey: string) {}

  async completeSingle(
    model: string,
    messages: LlmMessage[],
    signal?: AbortSignal,
  ): Promise<string> {
    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model, messages, stream: false }),
      signal,
    })
    if (!res.ok) {
      throw new Error(`openrouter single completions: ${res.status} ${res.statusText}`)
    }
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>
    }
    return json.choices?.[0]?.message?.content || ''
  }

  async complete(opts: CompleteOptions): Promise<string> {
    if (opts.model === 'openrouter/fusion') {
      opts.onChunk?.(
        'Fusing models: calling Llama-3-8B, Gemini-2.5-Flash, and Mistral-7B in parallel...\n',
      )

      const freeModels = [
        'meta-llama/llama-3-8b-instruct:free',
        'google/gemini-2.5-flash:free',
        'mistralai/mistral-7b-instruct:free',
      ]

      const responses = await Promise.all(
        freeModels.map((m) =>
          this.completeSingle(m, opts.messages, opts.signal).catch(
            (err) =>
              `[Model ${m} call failed: ${err instanceof Error ? err.message : String(err)}]`,
          ),
        ),
      )

      opts.onChunk?.(
        '\nPanel responses gathered. Invoking the judge model for final synthesis...\n\n',
      )

      const userPrompt = opts.messages[opts.messages.length - 1]?.content || ''
      const judgeMessages: LlmMessage[] = [
        {
          role: 'system',
          content:
            'You are an expert developer judge. You have been given a prompt and three proposed answers from different developer assistant models. Synthesize their answers, reconcile contradictions, extract the best coding logic, and output a single refined developer instruction. Do not include raw conversational filler; yield clean instructions.',
        },
        {
          role: 'user',
          content: `Original User Prompt:\n${userPrompt}\n\nCandidate Answer 1 (Llama-3):\n${responses[0]}\n\nCandidate Answer 2 (Gemini-Flash):\n${responses[1]}\n\nCandidate Answer 3 (Mistral-7B):\n${responses[2]}\n\nFinal Synthesized Solution:`,
        },
      ]

      // Delegate to standard streaming path with the frontier/judge model
      return this.complete({
        ...opts,
        model: 'google/gemini-2.5-pro', // Gemini 2.5 Pro as Judge
        messages: judgeMessages,
      })
    }

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ model: opts.model, messages: opts.messages, stream: true }),
      signal: opts.signal,
    })
    if (!res.ok || !res.body) {
      throw new Error(`openrouter: ${res.status} ${res.statusText}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''

    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const json = JSON.parse(payload) as {
            choices?: Array<{ delta?: { content?: string } }>
          }
          const chunk = json.choices?.[0]?.delta?.content
          if (chunk) {
            full += chunk
            opts.onChunk?.(chunk)
          }
        } catch {
          // ignore keep-alive / partial frames
        }
      }
    }
    return full
  }
}

/**
 * Direct Anthropic Claude client. Used when the client provides a custom Anthropic key.
 */
export class AnthropicLlmClient implements LlmClient {
  readonly kind = 'anthropic' as const
  private readonly endpoint = 'https://api.anthropic.com/v1/messages'

  /**
   * @param apiKey       caller-supplied Anthropic key
   * @param defaultModel current Claude model id used when the routed model is not a Claude id
   *                     (env ANTHROPIC_MODEL). Never a claude-3-* id: those lack adaptive
   *                     thinking and are below our floor.
   */
  constructor(
    private readonly apiKey: string,
    private readonly defaultModel = 'claude-sonnet-4-5',
  ) {}

  /** Resolve a bare Anthropic model id, honouring an explicit Claude routing id. */
  private resolveModel(model: string): string {
    // Strip an OpenRouter-style "anthropic/" prefix, e.g. "anthropic/claude-sonnet-4".
    const bare = model.includes('/') ? (model.split('/').pop() ?? model) : model
    // Use an explicit Claude id as-is, but never a legacy claude-3-* id.
    if (bare.startsWith('claude-') && !bare.startsWith('claude-3')) return bare
    return this.defaultModel
  }

  async complete(opts: CompleteOptions): Promise<string> {
    const systemMessage = opts.messages.find((m) => m.role === 'system')?.content
    const restMessages = opts.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role,
        content: m.content,
      }))

    const modelName = this.resolveModel(opts.model)

    const res = await fetch(this.endpoint, {
      method: 'POST',
      headers: {
        'x-api-key': this.apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: modelName,
        messages: restMessages,
        system: systemMessage,
        stream: true,
        max_tokens: 4000,
      }),
      signal: opts.signal,
    })

    if (!res.ok || !res.body) {
      throw new Error(`anthropic: ${res.status} ${res.statusText}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''

    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed.startsWith('data:')) continue
        const payload = trimmed.slice(5).trim()
        if (payload === '[DONE]') continue
        try {
          const json = JSON.parse(payload) as {
            type?: string
            delta?: { text?: string }
          }
          if (json.type === 'content_block_delta' && json.delta?.text) {
            const chunk = json.delta.text
            full += chunk
            opts.onChunk?.(chunk)
          }
        } catch {
          // ignore
        }
      }
    }
    return full
  }
}

/**
 * Direct Google Gemini client. Used when the client provides a custom Google key.
 */
export class GeminiLlmClient implements LlmClient {
  readonly kind = 'google' as const

  constructor(
    private readonly apiKey: string,
    private readonly defaultModel = 'gemini-2.5-pro',
  ) {}

  async complete(opts: CompleteOptions): Promise<string> {
    const systemMessage = opts.messages.find((m) => m.role === 'system')?.content
    const restMessages = opts.messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }))

    const model = opts.model
    const modelName = model.startsWith('gemini-')
      ? model
      : model.includes('fast') || model.includes('mini')
        ? 'gemini-2.5-flash'
        : this.defaultModel

    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:streamGenerateContent?key=${this.apiKey}`

    interface GeminiBody {
      contents: Array<{ role: string; parts: Array<{ text: string }> }>
      systemInstruction?: { parts: Array<{ text: string }> }
    }
    const body: GeminiBody = {
      contents: restMessages,
    }
    if (systemMessage) {
      body.systemInstruction = {
        parts: [{ text: systemMessage }],
      }
    }

    const res = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: opts.signal,
    })

    if (!res.ok || !res.body) {
      throw new Error(`google-gemini: ${res.status} ${res.statusText}`)
    }

    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
    let full = ''

    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let cleaned = buffer.trim()
      if (cleaned.startsWith('[')) cleaned = cleaned.slice(1)
      if (cleaned.endsWith(']')) cleaned = cleaned.slice(0, -1)
      if (cleaned.startsWith(',')) cleaned = cleaned.slice(1)

      const parts = cleaned.split(/},\s*\{/)
      if (parts.length > 1) {
        for (let i = 0; i < parts.length - 1; i++) {
          let part = parts[i]
          if (part === undefined) continue
          if (!part.startsWith('{')) part = '{' + part
          if (!part.endsWith('}')) part = part + '}'
          try {
            const json = JSON.parse(part)
            const text = json.candidates?.[0]?.content?.parts?.[0]?.text
            if (text) {
              full += text
              opts.onChunk?.(text)
            }
          } catch {
            // ignore
          }
        }
        buffer = '{' + (parts[parts.length - 1] ?? '')
      }
    }

    try {
      let finalStr = buffer.trim()
      if (finalStr.startsWith('[')) finalStr = finalStr.slice(1)
      if (finalStr.endsWith(']')) finalStr = finalStr.slice(0, -1)
      if (finalStr.startsWith(',')) finalStr = finalStr.slice(1)
      if (finalStr) {
        const json = JSON.parse(finalStr)
        const text = json.candidates?.[0]?.content?.parts?.[0]?.text
        if (text) {
          full += text
          opts.onChunk?.(text)
        }
      }
    } catch {
      // ignore
    }

    return full
  }
}

export function createLlmClient(
  env: ServerEnv,
  customKeys?: { anthropic?: string; google?: string },
): LlmClient {
  // Explicit Router mode takes precedence over ALL direct/BYO providers. A partial
  // configuration fails closed, never silently bypassing Router or using a mock.
  if (env.GENX_ROUTER_URL || env.GENX_ROUTER_FORGE_TOKEN) {
    if (!env.GENX_ROUTER_URL || !env.GENX_ROUTER_FORGE_TOKEN)
      throw new Error('Both GENX_ROUTER_URL and GENX_ROUTER_FORGE_TOKEN are required')
    return new RouterLlmClient(env.GENX_ROUTER_URL, env.GENX_ROUTER_FORGE_TOKEN)
  }
  // A user-supplied key takes precedence so "bring your own Claude" works end to end.
  if (customKeys?.anthropic)
    return new AnthropicLlmClient(customKeys.anthropic, env.ANTHROPIC_MODEL)
  if (customKeys?.google) return new GeminiLlmClient(customKeys.google, env.GOOGLE_MODEL)
  // A server-side Anthropic key drives Claude directly (no OpenRouter needed).
  if (env.ANTHROPIC_API_KEY)
    return new AnthropicLlmClient(env.ANTHROPIC_API_KEY, env.ANTHROPIC_MODEL)
  if (env.OPENROUTER_API_KEY) return new OpenRouterLlmClient(env.OPENROUTER_API_KEY)
  // Server-side Gemini fallback when no OpenRouter/Anthropic key is configured.
  if (env.GEMINI_API_KEY) return new GeminiLlmClient(env.GEMINI_API_KEY, env.GOOGLE_MODEL)
  return new MockLlmClient()
}
