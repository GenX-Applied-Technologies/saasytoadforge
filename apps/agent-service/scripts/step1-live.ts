/**
 * Step-1 live proof: Forge's own agent loop (createLlmClient -> RouterLlmClient,
 * createPlanner -> LlmPlanner, Agent.run) against a running GenX Router.
 *
 * Reads GENX_ROUTER_URL and GENX_ROUTER_FORGE_TOKEN from the environment; never
 * prints them. Prints agent events (kinds, paths, sizes, messages) and the
 * Router's real usage record. Planned edits are applied to the in-memory
 * MockSandboxProvider: real sandbox execution is milestone 2, not step 1.
 *
 *   pnpm --filter @forge/agent-service exec tsx scripts/step1-live.ts
 */
import { parseServerEnv, type AgentEvent } from '@forge/shared'
import { createLlmClient, RouterLlmClient } from '../src/agent/llm'
import { createPlanner } from '../src/agent/planner'
import { Agent, ApprovalGate, QuestionGate } from '../src/agent/agent'
import { createToolSet, MockBrowserTool } from '../src/agent/tools'
import { MockSandboxProvider } from '../src/sandbox/mock-provider'

const TASK = [
  'Plan one tiny change to the Phaser 2D garden game template (packages/game-template).',
  'Add a new file src/config.js that exports PLAYER_SPEED = 200 and SEED_COUNT = 8 as named constants, with a one-line comment.',
  'Return exactly one edit action for that file and no run or screenshot actions. Keep the message under 20 words.',
].join(' ')

async function main() {
  const env = parseServerEnv()
  const llm = createLlmClient(env)
  if (!(llm instanceof RouterLlmClient)) throw new Error(`Expected the Router client, got ${llm.kind}`)
  const planner = createPlanner(env, llm)
  const sandbox = new MockSandboxProvider()
  const session = await sandbox.create({ template: 'node', envAllowlist: [] })
  const events: AgentEvent[] = []
  const started = Date.now()
  try {
    const agent = new Agent(createToolSet(sandbox, session.id, new MockBrowserTool()))
    const result = await agent.run({ task: TASK, planner, approvals: new ApprovalGate(), questions: new QuestionGate() }, e => events.push(e))
    const summary = events.map(e => {
      if (e.type === 'edit') return { type: e.type, path: e.path, diffLines: e.diff.split('\n').length }
      if (e.type === 'message' || e.type === 'error') return { type: e.type, text: 'text' in e ? e.text : e.message }
      if (e.type === 'plan') return { type: e.type, steps: e.steps.map(s => s.title) }
      return { type: e.type }
    })
    // Contents of every file the plan wrote into the (in-memory) sandbox, by its own path.
    const written: Record<string, string> = {}
    for (const e of events) if (e.type === 'edit') written[e.path] = await sandbox.readFile(session.id, e.path)
    console.log(JSON.stringify({ plannerKind: planner.kind, llmKind: llm.kind, ok: result.ok, elapsedMs: Date.now() - started,
      events: summary, lastCall: llm.lastCall, writtenFiles: written }, null, 2))
    process.exitCode = result.ok ? 0 : 1
  } finally { await sandbox.destroy(session.id) }
}

void main()
