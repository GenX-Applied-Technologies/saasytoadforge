import { join } from 'node:path'
import type { SandboxProvider, ServerEnv } from '@forge/shared'
import { MockSandboxProvider } from './mock-provider'
import { E2BSandboxProvider, realE2BApi, type E2BApi } from './e2b-provider'
import { SandboxSpendGuard } from './spend-guard'
import { FileSpendLedger } from '../lib/file-spend-ledger'

export { MockSandboxProvider } from './mock-provider'
export { E2BSandboxProvider, realE2BApi } from './e2b-provider'
export { SandboxError, SANDBOX_ERROR_STATUS } from './errors'

export const SANDBOX_LEDGER_FILE = 'sandbox-spend-ledger.json'

/**
 * Resolves the configured SandboxProvider. Callers depend only on the interface.
 *
 * Fails closed: SANDBOX_PROVIDER=e2b without its key, spend cap or data dir refuses to boot
 * rather than silently using the mock, and the mock is refused when NODE_ENV=production. A key
 * alone never switches providers; the choice is always explicit.
 */
export function createSandboxProvider(env: ServerEnv, deps: { e2bApi?: E2BApi } = {}): SandboxProvider {
  switch (env.SANDBOX_PROVIDER) {
    case 'e2b': {
      const missing = (
        [
          ['E2B_API_KEY', env.E2B_API_KEY],
          ['FORGE_SANDBOX_SPEND_CAP_USD', env.FORGE_SANDBOX_SPEND_CAP_USD],
          ['FORGE_DATA_DIR', env.FORGE_DATA_DIR],
        ] as const
      )
        .filter(([, v]) => !v)
        .map(([k]) => k)
      if (missing.length) throw new Error(`SANDBOX_PROVIDER=e2b refused: missing ${missing.join(', ')}.`)
      const ledger = new FileSpendLedger(join(env.FORGE_DATA_DIR!, SANDBOX_LEDGER_FILE))
      return new E2BSandboxProvider({
        api: deps.e2bApi ?? realE2BApi(env.E2B_API_KEY!),
        guard: new SandboxSpendGuard(ledger, env.FORGE_SANDBOX_SPEND_CAP_USD!),
        template: env.E2B_TEMPLATE,
        resources: { cpuCount: env.FORGE_SANDBOX_VCPU, memoryMB: env.FORGE_SANDBOX_MEMORY_MB },
        timeoutMs: env.FORGE_SANDBOX_TIMEOUT_MS,
        maxConcurrent: env.FORGE_SANDBOX_MAX_CONCURRENT,
        deployment: `forge-${env.FORGE_DEPLOY_ENV}`,
      })
    }
    case 'mock':
      if (env.NODE_ENV === 'production') {
        throw new Error('SANDBOX_PROVIDER=mock is refused when NODE_ENV=production (no fake sandbox in hosted runs).')
      }
      return new MockSandboxProvider()
  }
}
