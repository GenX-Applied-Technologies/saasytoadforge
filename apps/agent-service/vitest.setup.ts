// Unit tests must never reach a real (paid) provider. A developer shell or CI runner may carry
// real model/sandbox keys; createLlmClient/createSandboxProvider would then pick a live client
// (this is why "runs the canonical task" failed on hosts with GEMINI_API_KEY set). Tests that
// need a provider configure it explicitly with fake values and mocked fetch.
for (const name of [
  'OPENROUTER_API_KEY',
  'ANTHROPIC_API_KEY',
  'GEMINI_API_KEY',
  'E2B_API_KEY',
  'GENX_ROUTER_URL',
  'GENX_ROUTER_FORGE_TOKEN',
  'GENX_ROUTER_PROTECTION_BYPASS',
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_ROLE_KEY',
  'FORGE_DEPLOY_ENV',
  'SANDBOX_PROVIDER',
]) {
  delete process.env[name]
}
