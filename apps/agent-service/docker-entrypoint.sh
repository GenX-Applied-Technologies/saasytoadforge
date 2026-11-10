#!/bin/sh
# Container entrypoint for the Forge agent-service.
# Fly mounts volumes owned by root. When started as root, give the data directory to the
# unprivileged `node` user (mode 700), then drop root and every capability before exec.
set -eu
if [ "$(id -u)" = "0" ]; then
  if [ -n "${FORGE_DATA_DIR:-}" ]; then
    mkdir -p "$FORGE_DATA_DIR"
    chown node:node "$FORGE_DATA_DIR"
    chmod 700 "$FORGE_DATA_DIR"
  fi
  exec setpriv --reuid=node --regid=node --init-groups --inh-caps=-all --bounding-set=-all "$@"
fi
exec "$@"
