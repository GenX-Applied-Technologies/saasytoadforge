# Game proof validation (local, 2026-11-08 America/Detroit)

Run from an isolated checkout of `feature/router-llm-client`. No real model call, no E2B sandbox, no deploy.

| Check | Result |
| --- | --- |
| `pnpm -r typecheck` | pass (shared, agent-service, web) |
| `pnpm lint` | pass |
| `pnpm test` | 217 passed, 1 failed: `src/workspace/agent.test.ts > runs the canonical task…` fails identically on clean `main` (pre-existing, unrelated) |
| `router-llm.test.ts` | 15 passed (mocked fetch, no network) |
| `game-proof.test.ts` | passed: mocked Router response -> real planner/agent/tools on `MockSandboxProvider`; build is intentionally not faked (exit 127) |
| `pnpm test:game` | 1 passed: real Chromium keyboard playtest of the built Phaser template (movement, collection/score, obstacle + world-bound collision, R restart, no page errors) |
| `pnpm --filter ./packages/game-template build` | pass (real local esbuild) |

## Not proved
- Real Together/DeepSeek generation through the Router (needs approved secrets and spend switch).
- Real E2B execution or isolation. DIY Docker is not a safe isolation boundary for hostile code.
