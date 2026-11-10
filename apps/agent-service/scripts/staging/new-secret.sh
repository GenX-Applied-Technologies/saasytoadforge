#!/usr/bin/env bash
# Generate a new random secret (384 bits, base64url, 64 chars) into a NEW mode-600 file.
# Prints only a 12-hex-char fingerprint. Used for the rotated hosted Router Forge app token
# (GENX_ROUTER_FORGE_TOKEN = ROUTER_OS_FORGE_APP_TOKEN on the Router preview) and for
# AGENT_SERVICE_SECRET.
#   new-secret.sh /workspace/forge-game-proof/.secrets/staging/GENX_ROUTER_FORGE_TOKEN
source "$(dirname "$0")/lib.sh"
out="${1:-}"
[ -n "$out" ] || die "usage: new-secret.sh <output-file>"
[ ! -e "$out" ] || die "$out already exists; rotate by moving it aside first"
umask 077
mkdir -p "$(dirname "$out")"
chmod 700 "$(dirname "$out")"
openssl rand -base64 48 | tr '+/' '-_' | tr -d '=\n' > "$out"
chmod 600 "$out"
[ "$(wc -c < "$out")" -eq 64 ] || { rm -f "$out"; die "generation failed"; }
printf 'wrote %s (fingerprint %s)\n' "$out" "$(fingerprint "$out")"
