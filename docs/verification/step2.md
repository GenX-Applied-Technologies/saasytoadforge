# Step 2 verification: real E2B sandbox, egress rules, sandbox-time cap (DRAFT)

Branch `feature/forge-e2b-sandbox` (base `feature/forge-staging-host`). Status: **paid E2B
smoke, template, step2-live, and the Phaser game proof have passed.** The Tester real-browser
walkthrough on Fly staging has not run, so per the done rule this milestone is **not done**.

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
| E2B really blocks non-allowlisted hosts, IPs and DNS | **proven live** | paid `step2-live.ts` + smoke, 2026-11-10 |
| Template builds and contains the toolchain | **proven live** | `forge-node22-phaser` id `2epqlp5z49acaonxz6bh`, Node 22 / pnpm 10.20.0 / Playwright Chromium / esbuild 0.25.12 |
| Billing matches the ledger | **not fully proven** | ledger + published rates recorded below; E2B dashboard/API usage was not readable (no usage endpoint with this key) |
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

## Run log 2026-11-10, ~2:05 PM ET (America/Detroit) — free phase
All later paid runs used a process env with every model/provider/payment key removed from the
Forge process (Gemini, Anthropic, OpenAI, xAI, Together, MiniMax, fal, Resend, Twilio, Square,
Supabase); only `E2B_API_KEY` and, for the game proof, the local `GENX_ROUTER_*` values were
kept. Keys were never printed or put on a command line. The smoke script also refuses to start
if any model key is present.

| Check | Status | Evidence |
| --- | --- | --- |
| E2B key authenticates (list call only, no sandbox) | **proven live, $0** | 0 running/paused sandboxes |
| 402: cap $0.001 < worst case → refused, E2B create never called, ledger untouched | **proven live, $0** | step2-smoke free phase |
| 503: unknown template → E2B refuses; reservation of $0.0276 was held when create was called, then released to $0; nothing left on E2B | **proven live, $0** | step2-smoke free phase |
| Free suites | pass | Forge vitest 39 files / 321 tests (then 26/26 provider tests after the timeout/`FileNotFoundError` fixes); Router 3463/3463 |

## Paid run log — 2026-11-10, 2:17–2:51 PM ET (America/Detroit)

Approved by Ron, 2:17 PM ET, word for word "yes run it" (E2B cap $3, Fly cap $5).
Migration 0040 was not applied to the production Router database.

### 1. Paid smoke (`FORGE_E2B_PAID_APPROVED=step2-smoke`) — PASS after a fix
First run (2:22 PM ET), sandbox `iju5m50moan8sa9lz7i3s`, ledger **$0.000138**: 15/16 checks
passed. The 504 case returned `sandbox_create_failed` because E2B's `requestTimeoutMs` throws
a `DOMException` named `TimeoutError`, not `e2b.TimeoutError`. Mapping now treats that
DOMException (and `AbortError`) as a create timeout. Unit test added. Targeted retest: PASS,
ledger **$0.00**, no leftover sandboxes.

### 2. Template build (`FORGE_E2B_PAID_APPROVED=template-build`) — PASS
- First build, 2:26 PM ET, 89s: template `forge-node22-phaser`, id `2epqlp5z49acaonxz6bh`,
  build `bd53a5fc-80f6-4a89-9492-9fa97ef931c3`. pnpm 10 ignored esbuild's postinstall,
  which would have broken the Phaser `esbuild` build.
- Template updated to prefetch `esbuild@0.25.12` with `onlyBuiltDependencies: ["esbuild"]`.
  Second build, 2:28 PM ET, 69s, same template id, build `abd35cf6-b71b-4516-9a8a-7c39d1fd0ade`.
  Log shows `esbuild postinstall: Done`.
- Rate used: 2 vCPU / 4 GiB = $0.000046/s. Estimate **$0.004094 + $0.003174 = $0.007268**.

### 3. `step2-live.ts` (`FORGE_E2B_PAID_APPROVED=step2-live`) — PASS 9/9
Template toolchain: Node v22.23.4, pnpm 10.20.0, Playwright Chromium present. Deny-all,
allowlisted registry, tighten, raw IP blocked, ledger settled, no leftovers. Ledger
**$0.000552**. Sandboxes `ir51njr7k2q3bzyq46izh` and `iwvi49debqpy63ox1b5q2`.

### 4. Phaser game proof (`scripts/step2-game.ts`) — PASS 12/12
Local Router on `127.0.0.1:3917` (`next start`, `VERCEL_ENV=preview`, file ledger, cap $0.50,
coding enabled). Forge agent used `RouterLlmClient` + the real E2B template (deny-all).
Together US DeepSeek-V4.1-Flash-1017 planned `src/config.js`; the trusted Phaser template
then `pnpm install --offline`, `pnpm run build` (esbuild), served on :4317, and a Playwright
playtest inside the sandbox moved the player (`x` 64 → 88, canvas ready, no page errors).

Successful run (2:37 PM ET), sandbox `iik2yjfhp7zcemnq000lg`, 25s, 12/12:
- Router request `d3ce0d0c-d172-4a3a-9a5f-094e420e6a43`, Together id `63ba14ca-aws_ue1`,
  265 input / 150 output tokens, **$0.000324375** (from usage).
- Sandbox ledger **$0.001150**. No leftover sandboxes.

Two earlier attempts (costs included below):
1. An empty Router ledger file was treated as corrupt, so no Together call ran. Reading a
   missing `src/config.js` threw E2B `FileNotFoundError`, which extends `NotFoundError`;
   `isGone` wrongly settled the still-running sandbox as gone. The leftover (`ig93zaa1s92jawkq8hgor`)
   was killed. `isGone` now matches only `SandboxNotFoundError` / `SandboxNotRunningError`.
2. Build and preview passed; Playwright failed because `playwright-core` was not a game-template
   dependency. The script now installs it from the offline store. Together **$0.000289875**,
   sandbox **$0.000920**.

### Spend
| Provider | What | Amount |
| --- | --- | --- |
| E2B ledger (sandboxes) | smoke + live + three game attempts | $0.002898 |
| E2B estimate (templates) | 89s + 69s at $0.000046/s | $0.007268 |
| E2B extra | first game sandbox may have billed until it was killed, beyond the 3s ledger | up to about $0.006 |
| **E2B total** | under the $3 cap | **about $0.011–$0.017** |
| Together US (Router file ledger) | two successful coding calls | **$0.00061425** |
| Fly | see `docs/verification/step0.md` | a few cents so far, cap $5 |

The E2B dashboard/API did not expose a usage total with this key, so template time uses
published rates and sandboxes use the durable ledger (plus the kill note above).

### Not yet done (needs Ron)
- Tester real-browser walkthrough on the Fly staging URL (Rule A).
- Hosted Forge→Router coding (0040 stays off the production Router DB; Vercel preview is
  SSO-protected and requires the Postgres ledger).
- Confirm E2B dashboard dollars against the figures above.
- Merge of this PR.
