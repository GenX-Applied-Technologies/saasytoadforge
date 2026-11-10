import 'dotenv/config'
import { parseServerEnv } from '@forge/shared'
import { buildServer } from './server'

const env = parseServerEnv()
const app = buildServer()

app
  .listen({ port: env.PORT, host: '0.0.0.0' })
  .then(async (address) => {
    console.log(`agent-service listening on ${address}`)
    // Kill sandboxes a previous run of this deployment left behind (crash, hard stop).
    const reaped = await app.sandboxProvider.reapOrphans?.().catch(() => -1)
    if (reaped === -1) console.warn('[sandbox] orphan check failed; will rely on E2B timeouts')
  })
  .catch((err) => {
    console.error(err)
    process.exitCode = 1
  })

// Drain connections + let sandboxes clean up on shutdown (e.g. Fly auto-stop).
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    void app.close().then(() => process.exit(0))
  })
}
