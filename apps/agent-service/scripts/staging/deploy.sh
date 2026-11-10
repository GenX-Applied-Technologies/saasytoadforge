#!/usr/bin/env bash
# PAID STEP. Creates (if needed) and deploys the Forge agent-service STAGING app on Fly:
# exactly one shared-cpu-1x/512MB machine in iad and one 1 GB volume, no dedicated IPv4.
# Run only after Ron approves the Fly cost and cap (docs/verification/step0.md).
#   FORGE_STAGING_APPROVED=yes apps/agent-service/scripts/staging/deploy.sh
source "$(dirname "$0")/lib.sh"
[ "${FORGE_STAGING_APPROVED:-}" = "yes" ] || die "set FORGE_STAGING_APPROVED=yes only after Ron approves the staging cost"
cd "$(git rev-parse --show-toplevel)"
CONFIG=apps/agent-service/fly.staging.toml
fly auth whoami >/dev/null || die "fly is not logged in"

if ! fly status --app "$FORGE_STAGING_APP" >/dev/null 2>&1; then
  fly apps create "$FORGE_STAGING_APP" >/dev/null
fi
if ! fly volumes list --app "$FORGE_STAGING_APP" --json | grep -q '"name": *"forge_staging_data"'; then
  fly volumes create forge_staging_data --app "$FORGE_STAGING_APP" --region iad --size 1 --count 1 --yes >/dev/null
fi
"$(dirname "$0")/import-fly-secrets.sh"
fly deploy --config "$CONFIG" --app "$FORGE_STAGING_APP" --ha=false \
  --build-arg "FORGE_BUILD_SHA=$(git rev-parse HEAD)" --yes
# Exactly one machine: the ledger volume and in-memory workspaces are single-instance.
fly scale count 1 --app "$FORGE_STAGING_APP" --yes >/dev/null
if fly ips list --app "$FORGE_STAGING_APP" --json | grep -q '"Type": *"v4"'; then
  die "a dedicated IPv4 ($2/month) is allocated; release it with: fly ips release <ip> --app $FORGE_STAGING_APP"
fi
curl -fsS "https://$FORGE_STAGING_APP.fly.dev/health"; echo
curl -fsS "https://$FORGE_STAGING_APP.fly.dev/ready"; echo
