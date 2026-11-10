import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    name: 'agent-service',
    environment: 'node',
    include: ['src/**/*.test.ts'],
    setupFiles: ['./vitest.setup.ts'],
  },
})
