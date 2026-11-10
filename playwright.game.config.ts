import { defineConfig, devices } from '@playwright/test'

/** Standalone trusted game: no web/agent-service startup, .env, AI or E2B. */
export default defineConfig({
  testDir: './e2e/game', fullyParallel: false, workers: 1, retries: 0,
  reporter: 'list', outputDir: 'test-results/game',
  use: { baseURL: 'http://127.0.0.1:4317', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: { command: 'pnpm --filter @forge/game-template serve', url: 'http://127.0.0.1:4317', reuseExistingServer: false, timeout: 30_000 },
})
