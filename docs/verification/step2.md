# Step 2 verification: real E2B sandbox, egress rules, sandbox-time cap (DRAFT)

Branch `feature/forge-e2b-sandbox` (base `feature/forge-staging-host`). Status: **built and
unit-tested for free; nothing has run on E2B.** Step 2 is not done until the paid live proof
below passes and a Tester real-browser walkthrough is recorded.

## What was built
- `e2b` upgraded to **2.63.0** (MIT). Node engine raised to `>=22.19.0` (SDK requirement).
- `src/sandbox/e2b-provider.ts` rewritten:
  - **Spend first:** the worst case (full timeout at the configured size) is reserved in a
    durable ledger before `Sandbox.create`; if it would pass the cap, E2B is never called.
  - **Egress at create time** (E2B network rules, read back via `getInfo` and the sandbox is
    killed on mismatch): empty allowlist = `allowInternetAccess:false`; otherwise
    `denyOut:[0.0.0.0/0]`, `allowOut:<exact names>`, `dnsServers:[]`. Names are pinned in
    `/etc/hosts` (resolved on the control plane, public IPv4 only), `/etc/resolv.conf` is
    emptied. Wildcards / IPs / CIDRs / >10 names are refused.
  - `setEgressAllowlist` (was a no-op) now calls `updateNetwork` (always with `dnsServers:[]`,
    because omitting it resets to 8.8.8.8), verifies, re-pins; on any failure it tightens to
    deny-all and throws.
  - `lifecycle.onTimeout:'kill'`, `envs:{}` (no host secrets), deployment + nonce metadata.
  - Create failure: looks the nonce up on E2B; kills anything that booted; releases the
    reservation to $0 only when E2B confirms nothing ran, otherwise the worst case stays charged.
  - Resource check: a sandbox reporting more vCPU/RAM than the priced size is killed.
  - Expiry timer settles at most the timeout; `destroy` settles real elapsed seconds;
    `shutdown()` on server close; `reapOrphans()` at boot kills this deployment's leftovers.
  - PTY `timeoutMs:0` (the SDK default of 60 s cut the terminal off after a minute).
  - Typed errors with fixed messages → HTTP: cap 402, limit 429, create failed 503,
    create timeout 504, egress unverified 503, gone 410.
- `src/sandbox/spend-guard.ts` + `src/lib/file-spend-ledger.ts` (port of the Router file
  ledger): integer nano-USD, atomic writes under a lock, crash-safe (open reservations count in
  full), corrupt/unwritable ledger refuses.
- `src/sandbox/e2b-pricing.ts`: $0.000014/vCPU-s, $0.0000045/GiB-s (read 2026-11-10).
- `src/sandbox/e2b-template.ts`: pinned Forge template (Node 22, pnpm 10.20.0, Playwright
  1.56.1 + Chromium, prefetched phaser 3.90.0 / vite 7.1.12 / typescript 5.9.3), pattern from
  e2b-dev/fragments (Apache-2.0).
- Factory: e2b without `E2B_API_KEY`/`FORGE_SANDBOX_SPEND_CAP_USD`/`FORGE_DATA_DIR` refuses to
  boot; the mock is refused when `NODE_ENV=production`; a key alone no longer switches
  providers; the Daytona stub is removed. Staging also requires a non-`base` `E2B_TEMPLATE`.
- `/ready` reports `sandboxLedger` (`ok`/`cap_reached`/`unavailable`); unavailable = not ready.
- Paid scripts, each refusing without an explicit approval flag:
  `scripts/e2b-build-template.ts` (`FORGE_E2B_PAID_APPROVED=template-build`) and
  `scripts/step2-live.ts` (`FORGE_E2B_PAID_APPROVED=step2-live`).

## Proven (free) vs not proven
| Claim | Status | Evidence |
| --- | --- | --- |
| Cap reached refuses before E2B is called | proven (fake E2B) | e2b-provider.test.ts |
| Cap survives restart (open reservations count) | proven (fake E2B, real file) | e2b-provider.test.ts |
| Ledger unavailable/corrupt refuses | proven | e2b-provider.test.ts, file-spend-ledger.test.ts |
| 20 concurrent reservations never exceed cap | proven (real file locks) | file-spend-ledger.test.ts |
| Create failure releases; create timeout kills booted orphan; E2B unreachable keeps worst case | proven (fake E2B) | e2b-provider.test.ts |
| Egress mismatch / DNS server open / oversize / hosts pin failure kill the sandbox | proven (fake E2B) | e2b-provider.test.ts |
| setEgressAllowlist replaces rules, always `dnsServers:[]`, tightens on failure | proven (fake E2B) | e2b-provider.test.ts |
| Command timeout / gone sandbox mapped and settled; expiry settles ≤ timeout | proven (fake E2B) | e2b-provider.test.ts |
| HTTP status mapping | proven | server.test.ts |
| Template renders to the pinned Dockerfile | proven (offline `Template.toDockerfile`) | egress-policy.test.ts |
| E2B really blocks non-allowlisted hosts, IPs and DNS | **not proven** | needs paid `step2-live.ts` |
| Template builds and contains the toolchain | **not proven** | needs paid template build |
| Billing matches the ledger | **not proven** | compare E2B usage page after the live run |
| Tester real-browser walkthrough | **not done** | needs Fly staging (step 0) + E2B |

Free test results (2026-11-10, ET): `pnpm -r typecheck` pass, `pnpm lint` pass,
`pnpm test` **39 files / 321 tests pass** (run with direct model keys unset).

## Paid steps (each needs Ron's OK first)
Rates (https://e2b.dev/pricing, read 2026-11-10): $0.000014 per vCPU-second +
$0.0000045 per GiB-second. 2 vCPU / 4 GiB = **$0.000046/s = $0.1656/hour = $0.0276 per
10-minute sandbox**. Hobby plan: $0/month with a one-time $100 usage credit, 1-hour max
session, 10 concurrent sandboxes; template build billing is not stated on the page, so it is
priced here as sandbox time (worst case).

| Step | Action | Expected | Hard cap | Enforcement |
| --- | --- | --- | --- | --- |
| 2a | Build template `forge-node22-phaser` (2 vCPU / 4 GiB), up to 3 attempts | ≈ $0.03–0.50 | $0.50 | not code-enforced: ≤3 runs × ≤1 h build × $0.1656/h; script refuses without the flag; E2B console budget is the backstop |
| 2b | `step2-live.ts`: 2 sandboxes per run, 2-min timeout each, up to 5 runs | ≈ $0.06 | $0.06 (10 × $0.00552) | each sandbox reserved in the ledger before create; cap 3 USD; max 1 concurrent; E2B kills at 2 min |
| 2c | Tester walkthrough on staging: up to 5 sessions × 10-min sandboxes, ≤2 concurrent | ≈ $0.14–0.35 | $3.00 total sandbox time | `FORGE_SANDBOX_SPEND_CAP_USD=3` (code hard max 10) refuses new sandboxes once reservations reach $3 |
| — | Account-level backstop | — | $5 | Ron sets a $5 budget/limit on the E2B console Budget page |

Expected total ≈ **$1**, hard cap **$3.56** in code-enforced sandbox time (+ $5 console
backstop). Likely **$0 cash** while the Hobby $100 credit lasts.

## Run log 2026-11-10, ~2:05 PM ET (America/Detroit)
All runs used a process env with every model/provider/payment key removed (Gemini, Anthropic,
OpenAI, xAI, Together, MiniMax, fal, Resend, Twilio, Square, Supabase, Router token); only
`E2B_API_KEY` was inherited (never printed or put on a command line). The smoke script also
refuses to start if any model key is present.

New: `apps/agent-service/scripts/step2-smoke.ts` — real E2B, same provider/guard/ledger as the
server, no mocks. Free phase always runs; the paid phase (ONE sandbox, 10-minute timeout,
ledger cap ≤ $0.50) runs only with `FORGE_E2B_PAID_APPROVED=step2-smoke`.

| Check | Status | Evidence |
| --- | --- | --- |
| E2B key authenticates (list call only, no sandbox) | **proven live, $0** | 0 running/paused sandboxes |
| 402: cap $0.001 < worst case → refused, E2B create never called, ledger untouched | **proven live, $0** | step2-smoke free phase |
| 503: unknown template → E2B refuses; reservation of $0.0276 was held when create was called, then released to $0; nothing left on E2B | **proven live, $0** | step2-smoke free phase |
| Reserve-before-create with a booted sandbox; deny-all; allow rule; tighten; 429; 410; 504; kill | **not run** | paid phase held (see below) |
| Template build, `step2-live.ts`, end-to-end | **not run** | paid |
| Free suites | pass | Forge vitest 39 files / 321 tests; Router 3463/3463 |

Actual E2B spend so far: **$0.00** (ledger committed $0; no sandbox has booted).
Paid phase held pending Ron's own confirmation of the 1:45 PM "go ahead with forge test"
message, which came from the shared account two minutes after Joe wrote from it.

To run the paid smoke (≤ $0.0276 reserved, ledger cap $0.50):
`FORGE_DATA_DIR=<dir> FORGE_E2B_PAID_APPROVED=step2-smoke npx tsx scripts/step2-smoke.ts`
(from `apps/agent-service`, under a key-scrubbed env).
