#!/usr/bin/env bash
# Restore a pg_dump custom-format file into a NEW scratch database.
# The primary business database is never overwritten.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
COMPOSE=(docker compose -f "$REPO_ROOT/docker-compose.yml")

env_value() {
  local key="$1" value=""
  if [[ -f "$REPO_ROOT/.env" ]]; then
    value="$(sed -n "s/^[[:space:]]*${key}=//p" "$REPO_ROOT/.env" | tail -n 1)"
    value="${value%\"}"; value="${value#\"}"
    value="${value%\'}"; value="${value#\'}"
  fi
  printf '%s' "$value"
}

POSTGRES_USER="${POSTGRES_USER:-$(env_value POSTGRES_USER)}"
POSTGRES_DB="${POSTGRES_DB:-$(env_value POSTGRES_DB)}"
POSTGRES_USER="${POSTGRES_USER:-bizflow}"
POSTGRES_DB="${POSTGRES_DB:-bizflow}"
BACKUP_FILE="${1:-${BACKUP_FILE:-}}"
TARGET_DB="${TARGET_DB:-bizflow_restore_$(date -u +%Y%m%dT%H%M%SZ)}"

if [[ -z "$BACKUP_FILE" || ! -f "$BACKUP_FILE" ]]; then
  echo "Usage: BACKUP_FILE=<path> [TARGET_DB=<scratch-db>] $0 [backup-file]" >&2
  exit 1
fi

# Hard guard: only simple names, never a system database or the live database.
if [[ ! "$TARGET_DB" =~ ^[A-Za-z][A-Za-z0-9_]*$ ]]; then
  echo "Refusing unsafe target database name: $TARGET_DB" >&2
  exit 1
fi
case "$TARGET_DB" in
  postgres|template0|template1|"$POSTGRES_DB")
    echo "Refusing to restore over a system or live database: $TARGET_DB" >&2
    exit 1
    ;;
esac

existing="$("${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d postgres -Atc \
  "SELECT 1 FROM pg_database WHERE datname = '$TARGET_DB'")"
if [[ "$existing" == "1" ]]; then
  echo "Target database already exists; refusing to overwrite: $TARGET_DB" >&2
  exit 1
fi

echo "Creating scratch database: $TARGET_DB"
"${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d postgres \
  -v ON_ERROR_STOP=1 -c "CREATE DATABASE \"$TARGET_DB\""

echo "Restoring $BACKUP_FILE into scratch database $TARGET_DB"
"${COMPOSE[@]}" exec -T postgres pg_restore \
  -U "$POSTGRES_USER" -d "$TARGET_DB" \
  --clean --if-exists --no-owner --no-privileges < "$BACKUP_FILE"

echo "Restore complete: $TARGET_DB"
echo "Live database unchanged: $POSTGRES_DB"
echo "Verify with: make verify-restore TARGET_DB=$TARGET_DB"
