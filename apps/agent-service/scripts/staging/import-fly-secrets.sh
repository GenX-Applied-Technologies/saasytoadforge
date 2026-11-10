#!/usr/bin/env bash
# Stage the agent-service secrets on the Fly STAGING app from mode-600 files, one file per
# variable named exactly like the variable. Values go to `fly secrets import` over stdin:
# never on a command line, never echoed, never logged. Prints names and fingerprints only.
#   FORGE_STAGING_SECRETS_DIR=/workspace/forge-game-proof/.secrets/staging import-fly-secrets.sh
source "$(dirname "$0")/lib.sh"

REQUIRED=(AGENT_SERVICE_SECRET ALLOWED_ORIGINS GENX_ROUTER_URL GENX_ROUTER_FORGE_TOKEN E2B_API_KEY)
OPTIONAL=(GENX_ROUTER_PROTECTION_BYPASS SUPABASE_URL SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY)
# Never allowed on staging: direct model keys bypass the Router; billing is tested separately;
# the Router operator token must never leave the Router.
FORBIDDEN=(OPENROUTER_API_KEY ANTHROPIC_API_KEY GEMINI_API_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET ROUTER_OS_OPERATOR_TOKEN TOGETHER_API_KEY)

check_secrets_dir
for name in "${FORBIDDEN[@]}"; do
  [ ! -e "$FORGE_STAGING_SECRETS_DIR/$name" ] || die "$name must not be provided to the staging agent-service"
done
for name in "${REQUIRED[@]}"; do check_secret_file "$FORGE_STAGING_SECRETS_DIR/$name"; done
for name in "${OPTIONAL[@]}"; do
  [ ! -e "$FORGE_STAGING_SECRETS_DIR/$name" ] || check_secret_file "$FORGE_STAGING_SECRETS_DIR/$name"
done

# Token rotation guard: the hosted token must be new, not the local step-1 proof token.
tok="$FORGE_STAGING_SECRETS_DIR/GENX_ROUTER_FORGE_TOKEN"
[ "$(wc -c < "$tok")" -ge 32 ] || die "GENX_ROUTER_FORGE_TOKEN must be 32+ characters"
if [ -f "$FORGE_LOCAL_TOKEN_FILE" ] && [ "$(sha256sum < "$tok")" = "$(sha256sum < "$FORGE_LOCAL_TOKEN_FILE")" ]; then
  die "GENX_ROUTER_FORGE_TOKEN is the local proof token; generate a new one with new-secret.sh"
fi
[ "$(wc -c < "$FORGE_STAGING_SECRETS_DIR/AGENT_SERVICE_SECRET")" -ge 32 ] || die "AGENT_SERVICE_SECRET must be 32+ characters"
grep -Eq '^https://' "$FORGE_STAGING_SECRETS_DIR/GENX_ROUTER_URL" || die "GENX_ROUTER_URL must be https://"

names=()
{
  for name in "${REQUIRED[@]}" "${OPTIONAL[@]}"; do
    f="$FORGE_STAGING_SECRETS_DIR/$name"
    [ -e "$f" ] || continue
    printf '%s=%s\n' "$name" "$(cat "$f")"
  done
} | fly secrets import --stage --app "$FORGE_STAGING_APP" >/dev/null

for name in "${REQUIRED[@]}" "${OPTIONAL[@]}"; do
  [ -e "$FORGE_STAGING_SECRETS_DIR/$name" ] && names+=("$name ($(fingerprint "$FORGE_STAGING_SECRETS_DIR/$name"))")
done
printf 'staged on %s: %s\n' "$FORGE_STAGING_APP" "${names[*]}"
