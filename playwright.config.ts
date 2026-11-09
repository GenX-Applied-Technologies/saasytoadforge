import { defineConfig, devices } from '@playwright/test'

/**
 * End-to-end flows live in ./e2e and are added from Phase 1 onward (IDE round-trip,
 * agent loop, artifact bundle). Run with `pnpm test:e2e` after `pnpm --filter @forge/web build`.
 * Browsers are installed on demand via `pnpm exec playwright install` (deferred in Phase 0).
 */
export default defineConfig({
  testDir: './e2e',
  testIgnore: '**/game/**',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 1 : 0,
  reporter: 'list',
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  // Both servers must be up. Locally this reuses any already running; in CI it
  // starts them (web needs a prior `pnpm --filter @forge/web build`).
  webServer: [
    {
      command: 'pnpm --filter @forge/agent-service start',
      port: 8787,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
      // Keep the suite deterministic + free: force mocks even if .env has real keys.
      env: { SANDBOX_PROVIDER: 'mock', OPENROUTER_API_KEY: '', E2B_API_KEY: '' },
    },
    {
      command: 'pnpm --filter @forge/web start',
      port: 3000,
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
  ],
})
