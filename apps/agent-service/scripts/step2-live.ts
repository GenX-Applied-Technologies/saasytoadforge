/**
 * PAID STEP: live E2B proof for step 2, through the SAME provider and spend guard the server
 * uses. Refuses unless FORGE_E2B_PAID_APPROVED=step2-live. Needs E2B_API_KEY, E2B_TEMPLATE,
 * FORGE_SANDBOX_SPEND_CAP_USD and FORGE_DATA_DIR (same rules as the server); never prints keys.
 * Each sandbox is created with a 2-minute timeout here, so the worst case per run is bounded.
 *
 * Checks, each printed as PASS/FAIL:
 *  1. toolchain present (node, pnpm, playwright chromium) in the template
 *  2. deny-all sandbox: example.com over HTTPS gets no TLS response; DNS lookup fails
 *  3. allowlist [registry.npmjs.org]: registry answers; example.com and a raw IP do not
 *  4. setEgressAllowlist([]) tightens to deny-all; registry then fails
 *  5. destroy settles the ledger; E2B no longer lists the sandbox
 *
 *   FORGE_E2B_PAID_APPROVED=step2-live pnpm --filter @forge/agent-service exec tsx scripts/step2-live.ts
 */
import { parseServerEnv } from '@forge/shared'
import { createSandboxProvider, E2BSandboxProvider, realE2BApi } from '../src/sandbox'
import { FileSpendLedger } from '../src/lib/file-spend-ledger'
import { join } from 'node:path'
import { SANDBOX_LEDGER_FILE } from '../src/sandbox'

const results: Array<{ check: string; pass: boolean; detail?: string }> = []
const check = (name: string, pass: boolean, detail?: string) => {
  results.push({ check: name, pass, detail })
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${detail ? ` - ${detail}` : ''}`)
}
// HTTP status from curl; '000' means no HTTP/TLS response at all (blocked).
const curl = (url: string) => `curl -s -o /dev/null -m 8 -w '%{http_code}' ${url} || true`

async function main() {
  if (process.env.FORGE_E2B_PAID_APPROVED !== 'step2-live') {
    throw new Error('Refused: paid step. Set FORGE_E2B_PAID_APPROVED=step2-live after approval.')
  }
  const env = parseServerEnv({ ...process.env, SANDBOX_PROVIDER: 'e2b', FORGE_SANDBOX_TIMEOUT_MS: '120000', FORGE_SANDBOX_MAX_CONCURRENT: '1' })
  const provider = createSandboxProvider(env) as E2BSandboxProvider
  const ledger = new FileSpendLedger(join(env.FORGE_DATA_DIR!, SANDBOX_LEDGER_FILE))
  const api = realE2BApi(env.E2B_API_KEY!)

  // 1 + 2: deny-all sandbox
  const a = await provider.create({ template: 'node', envAllowlist: [] })
  try {
    const tools = await provider.exec(a.id, 'node -v && pnpm -v && ls /ms-playwright | grep -c chromium')
    check('toolchain present', tools.exitCode === 0, tools.stdout.trim().replace(/\n/g, ' '))
    check('deny-all blocks https://example.com', (await provider.exec(a.id, curl('https://example.com'))).stdout.trim() === '000')
    const dns = await provider.exec(a.id, 'getent hosts example.com || echo NXDOMAIN')
    check('deny-all has no DNS', dns.stdout.includes('NXDOMAIN'))
  } finally {
    await provider.destroy(a.id)
  }

  // 3 + 4: allowlisted registry
  const b = await provider.create({ template: 'node', envAllowlist: [], egressAllowlist: ['registry.npmjs.org'] })
  try {
    check('allowlisted registry answers', (await provider.exec(b.id, curl('https://registry.npmjs.org/phaser'))).stdout.trim() === '200')
    check('non-allowlisted host blocked', (await provider.exec(b.id, curl('https://example.com'))).stdout.trim() === '000')
    check('raw IP blocked', (await provider.exec(b.id, curl('http://1.1.1.1'))).stdout.trim() === '000')
    await provider.setEgressAllowlist(b.id, [])
    check('tightened to deny-all', (await provider.exec(b.id, curl('https://registry.npmjs.org/phaser'))).stdout.trim() === '000')
  } finally {
    await provider.destroy(b.id)
  }

  // 5: ledger + E2B listing
  const state = ledger.read()
  const open = state.entries.filter((e) => e.status === 'reserved').length
  check('ledger has no open reservations', open === 0, `${state.entries.length} entries`)
  const left = await api.list({ forgeDeployment: `forge-${env.FORGE_DEPLOY_ENV}` })
  check('E2B lists no leftover sandboxes', left.length === 0)
  const spent = state.entries.reduce((s, e) => s + (e.settledNanoUsd ?? e.reservedNanoUsd), 0)
  console.log(JSON.stringify({ committedUsd: spent / 1e9, passed: results.filter((r) => r.pass).length, total: results.length }))
  if (results.some((r) => !r.pass)) process.exitCode = 1
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : 'step2-live failed')
  process.exitCode = 1
})
