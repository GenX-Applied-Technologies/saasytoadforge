# Forge security model & review log

The hard constraints from the mission (section 6) and where each stands. "Enforced by
construction" means the design makes the unsafe thing impossible, not merely discouraged.

## 6.1 Isolation
Agent- and user-generated code runs ONLY through `SandboxProvider`. The control plane
(web + agent-service) never executes untrusted code.
- The agent reaches the sandbox only via the scoped `ToolSet` (filesystem + terminal bound
  to one sandbox id; browser for screenshots). No host filesystem, no control-plane network,
  no secret-access tools (mission section 10).
- `MockSandboxProvider` refuses to execute arbitrary commands (exit 127); it never shells out
  to the host. Real isolation is the E2B microVM provider (the mock is refused when NODE_ENV=production).
- Status: enforced by construction. Real microVM execution pending `E2B_API_KEY`.

## 6.2 Egress
Default-deny per sandbox; allowlist = package registries + the user's declared domains.
- `SandboxProvider.setEgressAllowlist` + `EGRESS_ALLOWLIST` env (`parseEgressAllowlist`).
- E2B provider (step 2): every sandbox is created with egress already restricted by E2B SDK
  2.x network rules: empty allowlist = `allowInternetAccess: false`; otherwise
  `denyOut: [0.0.0.0/0]`, `allowOut: <exact hostnames>`, `dnsServers: []` (no resolver
  reachable; names are pinned in /etc/hosts). Wildcards, IPs and CIDRs are refused. The
  policy is read back from E2B and the sandbox is killed if it differs. `setEgressAllowlist`
  replaces the rules, verifies them, and tightens to deny-all on any failure.
- Status: **unit-tested against a fake E2B API only.** The live egress proof
  (scripts/step2-live.ts) is a paid step awaiting approval; until it passes, do not treat 6.2
  as proven on real sandboxes. See docs/verification/step2.md.

## 6.3 Side-effect approvals
Reads, plans, edits, and test runs proceed freely; irreversible side effects require explicit
approval.
- `ApprovalGate` pauses the loop; the UI shows approval cards (approve/reject). The
  "require approval before each file write" toggle gates writes. Diffs have accept/reject
  (reject reverts the file in the sandbox).
- Status: write-approval done. The full side-effect queue (git push, deploy, global installs,
  out-of-allowlist network, deletes, payments) lands in Phase 4.

## 6.4 Secrets
No secret values in the repo, prompts, or logs. Env-only; injected into sandboxes only as
allowlisted vars.
- `.env.example` documents every key, all empty. Secrets are optional at boot (`secretStatus`);
  missing ones degrade to mocks. Third-party keys stay server-side.
- Status: enforced. Structured no-secret logging is formalized in Phase 4.

## 6.5 Spend control
Per-user and global caps enforced before each model call, backed by a Postgres ledger.
- `SPEND_CAP_USER_USD` / `SPEND_CAP_GLOBAL_USD` env in place.
- Status: caps defined. Ledger + pre-call enforcement + a cap test land in Phase 4.

## Review log
- Phase 1 (IDE + sandbox): isolation boundary and path-traversal guard reviewed. PASS.
- Phase 2 (agent loop): edits/tests in-sandbox only; write-approval gate reviewed. PASS.
- Phase 3 (subagents + tools): scoped `ToolSet` confirms no host fs / control-plane net /
  secret tools; browser tool is read-only render; 6.1-6.3 reviewed. PASS.
- Phase 4 (safety/cost/observability): egress default-deny enforced per sandbox + blocked-egress
  test; spend caps enforced before each model call + cap test; structured logging redacts secrets
  + redaction test; Fusion deep tier gated, capped, and degrades to frontier. 6.2 / 6.4 / 6.5
  reviewed. PASS.
- Phase 5 will move the spend ledger + workspace/artifact state to Postgres (Supabase) with
  row-level security, and add Stripe webhook signature verification.
- **2026-06-15 security audit + fixes.** A review found the agent-service had no auth and no
  workspace ownership (cross-tenant access by guessing an id) - the worst possible bug. Fixed:
  signed per-user tokens, an auth hook + WS token check, `Workspace.owner` enforced on every
  route (cross-tenant now 404s), CORS pinned, per-user spend cap, `secure` cookie, and several
  correctness fixes (concurrent-task guard, approval cleanup, workspace delete). 6.1 / 6.3 / 6.5
  strengthened. Remaining honest gaps (E2B egress not yet proven live, spend pre-charge, Supabase/Stripe not
  wired, Fusion config-only) are tracked in GAPS.md - the running service does NOT yet enforce
  the full model the earlier "PASS" lines implied.
