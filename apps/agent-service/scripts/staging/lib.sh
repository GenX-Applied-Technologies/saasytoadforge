#!/usr/bin/env bash
# Shared helpers for the staging scripts. Never prints a secret value.
set -euo pipefail

FORGE_STAGING_APP="${FORGE_STAGING_APP:-saasytoad-forge-agent-staging}"
FORGE_STAGING_SECRETS_DIR="${FORGE_STAGING_SECRETS_DIR:-/workspace/forge-game-proof/.secrets/staging}"
# The LOCAL step-1 proof token. The hosted service must never use it.
FORGE_LOCAL_TOKEN_FILE="${FORGE_LOCAL_TOKEN_FILE:-/workspace/forge-game-proof/.secrets/forge-app-token}"

die() { printf 'refused: %s\n' "$*" >&2; exit 1; }

# 12-hex-char fingerprint of a file's contents: safe to show, identifies a rotation.
fingerprint() { sha256sum "$1" | cut -c1-12; }

mode_of() { stat -c '%a' "$1"; }

# A secret file must be a regular file owned by us, mode 600, one line, no CR.
check_secret_file() {
  local f="$1"
  [ -f "$f" ] || die "$(basename "$f") is missing"
  [ "$(stat -c '%u' "$f")" = "$(id -u)" ] || die "$(basename "$f") is not owned by the current user"
  [ "$(mode_of "$f")" = "600" ] || die "$(basename "$f") must be mode 600 (is $(mode_of "$f"))"
  [ -s "$f" ] || die "$(basename "$f") is empty"
  # One line only: an embedded newline would smuggle a second NAME=VALUE into the import.
  local content
  content="$(cat "$f")"
  if [[ "$content" == *$'\n'* || "$content" == *$'\r'* ]]; then die "$(basename "$f") must be a single line"; fi
}

check_secrets_dir() {
  [ -d "$FORGE_STAGING_SECRETS_DIR" ] || die "secrets dir $FORGE_STAGING_SECRETS_DIR does not exist"
  [ "$(mode_of "$FORGE_STAGING_SECRETS_DIR")" = "700" ] || die "secrets dir must be mode 700"
  case "$(realpath "$FORGE_STAGING_SECRETS_DIR")/" in
    "$(git rev-parse --show-toplevel 2>/dev/null || echo /nonexistent)"/*) die "secrets dir must be outside the repository" ;;
  esac
}
