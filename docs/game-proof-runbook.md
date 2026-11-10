# Forge Garden: first small, local game proof

## Scope and truth labels
- **Real:** trusted local Phaser 3.90.0 build (esbuild), Chromium canvas, actual
  keyboard input, Arcade Physics obstacle/world collisions, collection/score,
  restart and a browser screenshot. Phaser 3 is deliberately version-pinned for
  this small 2D example; Godot/Phaser 4 migration are not part of this proof.
- **Mock:** HTTP transport/Router response, LLM-generated plan fixture and the
  existing `MockSandboxProvider` in `game-proof.test.ts`. The real
  `RouterLlmClient`, `LlmPlanner`, `Agent`, toolset and file/checkpoint flow run.
- **Not proved:** live Router→Together inference, real E2B execution/isolation,
  deployed agent-service/WebSocket sessions, or an autonomous game factory.
  No paid calls, hosted sandbox, subscriptions or production changes.

The mock sandbox **does not execute npm/build or arbitrary JS**. Its existing
`node --test` output is explicitly simulated. The test asserts `npm run build`
returns 127, rather than inventing a successful sandbox build. Real trusted
build/play occurs separately on the box, not inside a pretend security boundary.
Never run hostile model-generated code on the host/inside a DIY Docker container.

## Restore and run, without credentials
From a fresh checkout of the reviewed branch/commit (base `7e58d12`):

```sh
corepack enable # if needed; use a writable COREPACK_HOME on locked machines
pnpm install --frozen-lockfile --ignore-scripts
pnpm typecheck
pnpm test             # full existing suite; see known baseline failures below
pnpm lint
pnpm exec playwright install chromium
pnpm test:game        # builds trusted template + local Playwright browser test
# To play manually after the build:
pnpm --filter @forge/game-template serve
# open http://127.0.0.1:4317 ; Ctrl-C stops this loopback-only server
```

No `.env` required for game or new tests. They never start the agent-service,
connect an AI provider or instantiate E2B. `pnpm test:game` reuses the existing
root Playwright dependency and its own config, so it does not start the full IDE.
Static output: `packages/game-template/dist/`; screenshot/trace:
`test-results/game/` (ignored by Git). Keep `LICENSES.md`, `PHASER-LICENSE.txt`
and `game.js.LEGAL.txt` alongside any copied build. Originals are code-generated
CC0 shapes, not fetched Kenney/SpriteCook art; see template `LICENSES.md`.

The mock proof checkpoints the empty in-memory sandbox, stages every template
file through the real agent tools, simulates a test command, verifies contents,
restores the checkpoint, and destroys the sandbox. For source restore use a fresh
checkout at the reviewed commit; do not reset another worker's checkout. No new
runtime, container executor or duplicate E2B SDK was added.

## Later secure configuration — server only, not authorization to spend
Router preview environment:
- `TOGETHER_API_KEY`: existing Together key supplied securely by the owner.
  A GitHub Actions encrypted secret is not readable/exportable and is not a
  Vercel runtime environment variable. Do not extract it through a workflow.
- `ROUTER_OS_FORGE_APP_TOKEN`: independent 32+ character secret; NOT the broad
  operator token, MiniMax plan key, or MiniMax Studio wallet key.
- `ROUTER_OS_FORGE_CODING_ENABLED`: leave absent/false until bounded cost approval.

Forge **agent-service** environment (never browser/NEXT_PUBLIC):
- `GENX_ROUTER_URL`: exact HTTPS Router preview origin, no path/query/credentials.
- `GENX_ROUTER_FORGE_TOKEN`: same scoped app token as the Router variable above.
- `E2B_API_KEY`: later, after separate sandbox-spend approval.
- `SANDBOX_PROVIDER=e2b`: explicit intent for the later real proof.
- `EGRESS_ALLOWLIST`: empty/default-deny for an offline/prebuilt sandbox.
  Since step 2 the E2B provider enforces exact-hostname allowlists (deny all
  else, no DNS server); the Forge template pre-installs the toolchain so the
  default stays empty. No Router/app/provider keys go into a sandbox.
- `E2B_TEMPLATE`, `FORGE_SANDBOX_SPEND_CAP_USD`, `FORGE_DATA_DIR`: required with
  `SANDBOX_PROVIDER=e2b` (see docs/verification/step2.md).

Existing hosting/auth config still applies (`AGENT_SERVICE_SECRET`,
`ALLOWED_ORIGINS`, web→agent URL and signed tenant tokens); see PR9 recovery docs.
PR9 touches only `fly.toml` and `docs/deployment-recovery-20260924.md`: no overlap
with this branch, and neither deployment recovery nor production is changed here.
The production UI/agent loop remains unverified. A configured Router takes
precedence over direct/BYO keys, rejects partial config and never falls back.
With no Router or other keys, the existing mock client remains the default.

## Provider migration — explicit, never fallback
Together's official deprecation history removed
`deepseek-ai/DeepSeek-V4-Flash-0731` on 2026-10-22. This proof explicitly pins
`deepseek-ai/DeepSeek-V4.1-Flash-1017` on **https://us-api.together.ai/v1**,
using the existing OpenAI-compatible Together adapter in the companion Router
change. No direct DeepSeek/China connection; no automatic model selection.
The general Router catalog is deliberately not changed. US placement covers
inference, not provider storage/logs. Keep Together passthrough OFF and configure
zero retention; use only non-sensitive game code. A real account/model check is
still required before claiming paid inference works.

Sources opened 2026-11-08:
- https://docs.together.ai/docs/deprecations
- https://docs.together.ai/docs/changelog
- https://docs.together.ai/docs/serverless/geo-specific-inference
- https://docs.together.ai/docs/serverless/models
- https://e2b.dev/pricing

## Proposed first paid proof — requires approval, not performed
One manual completion (<=16 KiB JSON input, <=2048 output tokens, no retries),
then at most **one sandbox for 300 seconds**, destroyed in `finally` and backed by
provider timeout. No open-ended agent loop or auto-repair. Disable the Router
spend switch again afterwards. Verify real model access, prices, E2B allocation,
network restrictions, and billing controls first; do not start a new subscription.

Current documented US model rates: $0.375/M input + $1.50/M output.
A conservative 16,384 input + 2048 output is **$0.009216** (plus small fixed
system-message overhead). E2B published rates: $0.000014/vCPU-second +
$0.0000045/GiB-second. At 2 vCPU/4 GiB ×300s: **$0.0138**. Combined estimate
~**$0.024**, proposed owner-approved envelope **$0.10 total**. This is not an
enforced account billing cap; verify resource size/model access first. Existing
credits may cover some usage, but that is not assumed. If preinstalled dependencies
or safe network controls require a new paid template/plan, stop and report first.

## Known clean-main regressions
Full test results are recorded in `game-proof-validation.md`. Existing WebSocket
canonical-task test fails unchanged on clean main; new focused tests and actual
gameplay tests are separate evidence, not a claim that all legacy tests pass.
