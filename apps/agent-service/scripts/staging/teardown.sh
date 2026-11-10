#!/usr/bin/env bash
# Stops all Fly staging charges. `stop` scales machines to 0 (rootfs/volume storage still
# billed, cents per month). `destroy` deletes the app, its machine and its volume (all billing ends).
#   teardown.sh stop | teardown.sh destroy
source "$(dirname "$0")/lib.sh"
case "${1:-}" in
  stop) fly scale count 0 --app "$FORGE_STAGING_APP" --yes ;;
  destroy) fly apps destroy "$FORGE_STAGING_APP" --yes ;;
  *) die "usage: teardown.sh stop|destroy" ;;
esac
