#!/usr/bin/env bash
# Create a logical, custom-format PostgreSQL backup from the running Compose
# postgres service. Never mutates the source database.
set -euo pipefail

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." && pwd)"
COMPOSE=(docker compose -f "$REPO_ROOT/docker-compose.yml")

# Local development convenience: read only the keys we need from .env. Never
# source the file: it contains an unquoted Stellar passphrase with spaces.
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
BACKUP_DIR="${BACKUP_DIR:-}"
BACKUP_FILE="${BACKUP_FILE:-}"
POSTGRES_USER="${POSTGRES_USER:-bizflow}"
POSTGRES_DB="${POSTGRES_DB:-bizflow}"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"

if [[ -n "${BACKUP_FILE:-}" ]]; then
  output="$BACKUP_FILE"
else
  backup_dir="${BACKUP_DIR:-}"
  backup_dir="${backup_dir:-$REPO_ROOT/backups}"
  mkdir -p "$backup_dir"
  output="$backup_dir/${POSTGRES_DB}_${STAMP}.dump"
fi

mkdir -p "$(dirname -- "$output")"
tmp="${output}.partial.$$"
trap 'rm -f "$tmp"' EXIT

"${COMPOSE[@]}" exec -T postgres \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom > "$tmp"
test -s "$tmp" || { echo "Backup is empty: $tmp" >&2; exit 1; }
mv "$tmp" "$output"
trap - EXIT

echo "Backup complete: $output"
echo "Destination database: $POSTGRES_DB (unchanged)"
