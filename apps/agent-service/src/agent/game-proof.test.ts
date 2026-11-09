import { readFile } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import type { AgentEvent } from '@forge/shared'
import { parseServerEnv } from '@forge/shared'
import { Agent, ApprovalGate, QuestionGate } from './agent'
import { createLlmClient } from './llm'
import { createPlanner } from './planner'
import { createToolSet, MockBrowserTool } from './tools'
import { MockSandboxProvider } from '../sandbox/mock-provider'

const root = new URL('../../../../packages/game-template/', import.meta.url)
const templateFiles = ['package.json', 'index.html', 'src/main.js', 'scripts/build.mjs', 'scripts/serve.mjs', 'LICENSES.md']
afterEach(() => vi.unstubAllGlobals())

it('mock Router → real client/planner/agent → existing mock sandbox; no build execution claim', async () => {
  const files = await Promise.all(templateFiles.map(async path => ({ path, contents: await readFile(new URL(path, root), 'utf8') })))
  const plan = {
    message: 'Mock coding plan: stage the trusted Phaser template and simulate its smoke test.',
    steps: [{ id: 'game', title: 'Stage game', role: 'coder' }, { id: 'test', title: 'Simulated run', role: 'verifier' }],
    actions: [
      ...files.map(file => ({ kind: 'edit', stepId: 'game', ...file })),
      { kind: 'edit', path: 'test/game.test.mjs', contents: "import { test } from 'node:test'; test('template staged', () => {});" },
      { kind: 'run', stepId: 'test', cmd: 'node --test test/game.test.mjs' },
    ],
  }
  const fetch = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).toBe('https://mock-router.example/api/forge/coding-complete')
    expect(JSON.parse(init.body as string).messages.at(-1).content).toContain('Phaser')
    return Response.json({ text: JSON.stringify(plan), provider: 'together', modelId: 'deepseek-ai/DeepSeek-V4.1-Flash-1017' })
  })
  vi.stubGlobal('fetch', fetch) // network and LLM are mocked; actual Router tests live in Router repo
  const env = parseServerEnv({ GENX_ROUTER_URL: 'https://mock-router.example', GENX_ROUTER_FORGE_TOKEN: 'mock-test-only-app-credential-32-characters' })
  const sandbox = new MockSandboxProvider() // never auto-upgrade via an ambient E2B key
  const session = await sandbox.create({ template: 'node', envAllowlist: [] })
  const before = await sandbox.checkpoint(session.id)
  const events: AgentEvent[] = []
  try {
    const agent = new Agent(createToolSet(sandbox, session.id, new MockBrowserTool()))
    const result = await agent.run({ task: 'Stage a playable Phaser garden game', planner: createPlanner(env, createLlmClient(env)),
      approvals: new ApprovalGate(), questions: new QuestionGate() }, e => events.push(e))
    expect(result.ok).toBe(true)
    expect(fetch).toHaveBeenCalledTimes(1)
    for (const file of files) expect(await sandbox.readFile(session.id, file.path)).toBe(file.contents)
    const terminal = events.find(e => e.type === 'terminal')
    expect(terminal?.type === 'terminal' && terminal.result.stdout).toContain('simulated by mock sandbox')
    // Do NOT teach the mock to fake npm success. Build execution is a separate local proof.
    const build = await sandbox.exec(session.id, 'npm run build')
    expect(build.exitCode).toBe(127)
    expect(build.stderr).toContain('not executable in the mock provider')
    await sandbox.restore(session.id, before)
    await expect(sandbox.readFile(session.id, 'src/main.js')).rejects.toThrow('no such file')
  } finally { await sandbox.destroy(session.id) }
})
