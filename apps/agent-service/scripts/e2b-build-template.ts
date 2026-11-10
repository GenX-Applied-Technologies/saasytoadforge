/**
 * PAID STEP: builds the Forge E2B template (src/sandbox/e2b-template.ts) on E2B.
 * Refuses unless FORGE_E2B_PAID_APPROVED=template-build (set only after Ron approves the cost).
 * Reads E2B_API_KEY from the environment; never prints it. Build timeout: 30 minutes.
 *
 *   FORGE_E2B_PAID_APPROVED=template-build pnpm --filter @forge/agent-service exec tsx scripts/e2b-build-template.ts
 */
import { Template } from 'e2b'
import { FORGE_TEMPLATE_NAME, forgeTemplate } from '../src/sandbox/e2b-template'

async function main() {
  if (process.env.FORGE_E2B_PAID_APPROVED !== 'template-build') {
    throw new Error('Refused: paid step. Set FORGE_E2B_PAID_APPROVED=template-build after approval.')
  }
  if (!process.env.E2B_API_KEY) throw new Error('Refused: E2B_API_KEY is not set.')
  const started = Date.now()
  const info = await Template.build(forgeTemplate(), FORGE_TEMPLATE_NAME, {
    cpuCount: 2,
    memoryMB: 4096,
    onBuildLogs: (log) => console.log(String(log.message ?? log).slice(0, 400)),
  })
  console.log(JSON.stringify({ template: FORGE_TEMPLATE_NAME, templateId: info.templateId, buildId: info.buildId, seconds: Math.round((Date.now() - started) / 1000) }))
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'template build failed')
  process.exitCode = 1
})
