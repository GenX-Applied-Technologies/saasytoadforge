/**
 * PAID STEP: Phaser 2D game builds and runs in a real E2B sandbox, planned through
 * Forge → GenX Router OS → Together US DeepSeek. Refuses unless
 * FORGE_E2B_PAID_APPROVED=step2-game. Needs E2B_API_KEY, E2B_TEMPLATE,
 * FORGE_SANDBOX_SPEND_CAP_USD, FORGE_DATA_DIR, GENX_ROUTER_URL, GENX_ROUTER_FORGE_TOKEN.
 * Never prints keys. The Router must be a local/preview instance with a file ledger
 * (migration 0040 is not applied to the production Router database).
 */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseServerEnv, type AgentEvent } from '@forge/shared'
import { createLlmClient, RouterLlmClient } from '../src/agent/llm'
import { createPlanner } from '../src/agent/planner'
import { Agent, ApprovalGate, QuestionGate } from '../src/agent/agent'
import { createToolSet, MockBrowserTool } from '../src/agent/tools'
import { createSandboxProvider, E2BSandboxProvider, realE2BApi, SANDBOX_LEDGER_FILE } from '../src/sandbox'
import { FileSpendLedger } from '../src/lib/file-spend-ledger'

const TASK = [
  'Plan one tiny change to the Phaser 2D garden game template already staged in this workspace.',
  'Add a new file src/config.js that exports PLAYER_SPEED = 200 and SEED_COUNT = 8 as named constants, with a one-line comment.',
  'Return exactly one edit action for that file and no run or screenshot actions. Keep the message under 20 words.',
].join(' ')

const TEMPLATE_FILES = ['package.json', 'index.html', 'src/main.js', 'scripts/build.mjs', 'scripts/serve.mjs', 'LICENSES.md']

const PLAYTEST = `import { chromium } from 'playwright-core'
import { writeFile } from 'node:fs/promises'
const errors = []
const browser = await chromium.launch({ args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-gpu'] })
try {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  page.on('pageerror', (e) => errors.push(e.message))
  await page.goto('http://127.0.0.1:4317/', { waitUntil: 'networkidle', timeout: 15_000 })
  await page.locator('canvas').waitFor({ state: 'visible', timeout: 10_000 })
  const state = async () => page.evaluate(() => window.forgeGame?.snapshot?.())
  const start = Date.now()
  let snap = await state()
  while (!snap?.ready && Date.now() - start < 8_000) {
    await new Promise((r) => setTimeout(r, 50))
    snap = await state()
  }
  if (!snap?.ready) throw new Error('game did not become ready')
  const before = snap
  await page.keyboard.down('ArrowRight')
  const moveStart = Date.now()
  while (Date.now() - moveStart < 5_000) {
    snap = await state()
    if (snap && (snap.x > before.x + 20 || snap.score > before.score)) break
    await new Promise((r) => setTimeout(r, 25))
  }
  await page.keyboard.up('ArrowRight')
  await page.screenshot({ path: '/tmp/garden.png', type: 'png' })
  const out = { ready: true, before, after: snap, moved: snap.x > before.x + 20, scored: snap.score > before.score, errors }
  await writeFile('/tmp/playtest.json', JSON.stringify(out))
  console.log(JSON.stringify(out))
  if (errors.length || !(out.moved || out.scored)) process.exit(1)
} finally {
  await browser.close()
}
`

const results: Array<{ check: string; pass: boolean; detail?: string }> = []
const check = (name: string, pass: boolean, detail?: string) => {
  results.push({ check: name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`)
}

async function main() {
  if (process.env.FORGE_E2B_PAID_APPROVED !== 'step2-game') {
    throw new Error('Refused: paid step. Set FORGE_E2B_PAID_APPROVED=step2-game after approval.')
  }
  const leaked = ['TOGETHER_API_KEY', 'OPENROUTER_API_KEY', 'ANTHROPIC_API_KEY', 'GEMINI_API_KEY'].filter((k) => process.env[k])
  if (leaked.length) throw new Error(`Refused: provider keys present in Forge env: ${leaked.join(', ')}`)
  const env = parseServerEnv({
    ...process.env,
    SANDBOX_PROVIDER: 'e2b',
    FORGE_SANDBOX_TIMEOUT_MS: process.env.FORGE_SANDBOX_TIMEOUT_MS ?? '600000',
    FORGE_SANDBOX_MAX_CONCURRENT: '1',
    FORGE_DEPLOY_ENV: process.env.FORGE_DEPLOY_ENV ?? 'local',
  })
  const llm = createLlmClient(env)
  if (!(llm instanceof RouterLlmClient)) throw new Error(`Expected the Router client, got ${llm.kind}`)
  const planner = createPlanner(env, llm)
  const provider = createSandboxProvider(env) as E2BSandboxProvider
  const ledger = new FileSpendLedger(join(env.FORGE_DATA_DIR!, SANDBOX_LEDGER_FILE))
  const api = realE2BApi(env.E2B_API_KEY!)
  const root = join(dirname(fileURLToPath(import.meta.url)), '../../../packages/game-template')

  const session = await provider.create({ template: 'node', envAllowlist: [] })
  const events: AgentEvent[] = []
  const started = Date.now()
  try {
    for (const rel of TEMPLATE_FILES) {
      const contents = await readFile(join(root, rel), 'utf8')
      await provider.writeFile(session.id, rel, contents)
    }
    // Allow esbuild's postinstall when installing from the offline store.
    const pkg = JSON.parse(await provider.readFile(session.id, 'package.json'))
    pkg.pnpm = { ...(pkg.pnpm ?? {}), onlyBuiltDependencies: ['esbuild'] }
    await provider.writeFile(session.id, 'package.json', JSON.stringify(pkg, null, 2) + '\n')

    const agent = new Agent(createToolSet(provider, session.id, new MockBrowserTool()))
    const result = await agent.run(
      { task: TASK, planner, approvals: new ApprovalGate(), questions: new QuestionGate() },
      (e) => events.push(e),
    )
    const written = events.filter((e) => e.type === 'edit').map((e) => e.path)
    const errors = events.filter((e) => e.type === 'error').map((e) => e.message)
    let config = ''
    try { config = await provider.readFile(session.id, written[0] ?? 'src/config.js') } catch { config = '' }
    check('planner is llm via genx-router', planner.kind === 'llm' && llm.kind === 'genx-router', `planner=${planner.kind} llm=${llm.kind}`)
    check('agent returned ok', result.ok === true, errors[0] ?? (written.length ? `edits=${written.join(',')}` : 'no edits'))
    check('Together US DeepSeek wrote src/config.js', /PLAYER_SPEED/.test(config) && /SEED_COUNT/.test(config) && /200/.test(config) && /8/.test(config), `path=${written[0] ?? 'src/config.js'} bytes=${config.length}`)
    const last = llm.lastCall
    check(
      'Router reported DeepSeek-V4.1-Flash-1017',
      !!last && (last.modelId ?? '').includes('DeepSeek-V4.1-Flash-1017'),
      last ? `model=${last.modelId} request=${last.requestId} in=${last.inputTokens} out=${last.outputTokens} costUsd=${last.costUsd}` : 'no lastCall',
    )

    const install = await provider.exec(session.id, 'pnpm config set store-dir /opt/forge-store && pnpm install --offline --frozen-lockfile=false', { timeoutMs: 120_000 })
    check('offline pnpm install', install.exitCode === 0, install.stderr.slice(0, 240).replace(/\s+/g, ' '))
    const build = await provider.exec(session.id, 'pnpm run build', { timeoutMs: 60_000 })
    check('phaser esbuild succeeded', build.exitCode === 0 && /Built trusted Phaser template/.test(build.stdout), build.stdout.trim().slice(0, 200))
    const dist = await provider.exec(session.id, 'test -s dist/game.js && test -s dist/index.html && wc -c dist/game.js')
    check('dist/game.js and index.html exist', dist.exitCode === 0, dist.stdout.trim())

    await provider.writeFile(session.id, 'scripts/playtest.mjs', PLAYTEST)
    const serve = await provider.exec(session.id, 'node scripts/serve.mjs >/tmp/serve.log 2>&1 & echo $!; sleep 0.4; curl -s -o /dev/null -m 5 -w %{http_code} http://127.0.0.1:4317/')
    check('game preview serves on 4317', serve.stdout.trim().split('\n').pop() === '200', serve.stdout.trim())
    const pwInstall = await provider.exec(
      session.id,
      'pnpm add playwright-core@1.56.1 --offline --store-dir /opt/forge-store',
      { timeoutMs: 60_000 },
    )
    check('offline playwright-core install', pwInstall.exitCode === 0, pwInstall.stderr.slice(0, 240).replace(/\s+/g, ' '))
    const play = await provider.exec(session.id, 'PLAYWRIGHT_BROWSERS_PATH=/ms-playwright node scripts/playtest.mjs', { timeoutMs: 60_000 })
    check(
      'playwright: canvas ready and player moved or scored',
      play.exitCode === 0,
      [play.stdout, play.stderr].filter(Boolean).join(' | ').trim().slice(0, 600),
    )
  } finally {
    await provider.destroy(session.id).catch(() => undefined)
    await api.kill(session.id).catch(() => undefined)
  }

  const state = ledger.read()
  const open = state.entries.filter((e) => e.status === 'reserved').length
  check('sandbox ledger has no open reservations', open === 0, `${state.entries.length} entries`)
  const left = await api.list({ forgeDeployment: `forge-${env.FORGE_DEPLOY_ENV}` })
  check('E2B lists no leftover sandboxes', left.length === 0)
  const spent = state.entries.reduce((s, e) => s + (e.settledNanoUsd ?? e.reservedNanoUsd), 0)
  const summary = events.map((e) => {
    if (e.type === 'edit') return { type: e.type, path: e.path, diffLines: e.diff.split('\n').length }
    if (e.type === 'message' || e.type === 'error') return { type: e.type, text: 'text' in e ? e.text : e.message }
    if (e.type === 'plan') return { type: e.type, steps: e.steps.map((s) => s.title) }
    return { type: e.type }
  })
  console.log(JSON.stringify({
    ok: results.every((r) => r.pass),
    elapsedMs: Date.now() - started,
    sandboxCommittedUsd: spent / 1e9,
    passed: results.filter((r) => r.pass).length,
    total: results.length,
    events: summary,
    lastCall: llm.lastCall,
  }))
  if (results.some((r) => !r.pass)) process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'step2-game failed')
  process.exitCode = 1
})
