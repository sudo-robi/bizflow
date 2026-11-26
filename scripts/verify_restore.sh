#!/usr/bin/env bash
# Compare table row counts between the source database and a restored scratch
# database. Optionally assert a sentinel query returns 1 in both.
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
SRC_DB="${SRC_DB:-${POSTGRES_DB:-bizflow}}"
TARGET_DB="${TARGET_DB:-}"

if [[ -z "$TARGET_DB" ]]; then
  echo "Usage: TARGET_DB=<scratch-db> [SRC_DB=<source-db>] $0" >&2
  exit 1
fi
if [[ "$SRC_DB" == "$TARGET_DB" ]]; then
  echo "Source and target must be different databases" >&2
  exit 1
fi

count_query() {
  local db="$1" table="$2"
  "${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$db" -Atc \
    "SELECT count(*) FROM public.\"$table\""
}

tables="$("${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$SRC_DB" -Atc \
  "SELECT tablename FROM pg_tables WHERE schemaname = 'public' ORDER BY 1")"
if [[ -z "$tables" ]]; then
  echo "No public tables found in source database $SRC_DB" >&2
  exit 1
fi

failures=0
checked=0
while IFS= read -r table; do
  [[ -n "$table" ]] || continue
  src_count="$(count_query "$SRC_DB" "$table")"
  tgt_count="$(count_query "$TARGET_DB" "$table")"
  checked=$((checked + 1))
  if [[ "$src_count" != "$tgt_count" ]]; then
    echo "MISMATCH $table: source=$src_count restore=$tgt_count" >&2
    failures=$((failures + 1))
  fi
done <<< "$tables"

if [[ -n "${VERIFY_SQL:-}" ]]; then
  for db in "$SRC_DB" "$TARGET_DB"; do
    result="$("${COMPOSE[@]}" exec -T postgres psql -U "$POSTGRES_USER" -d "$db" -Atc "$VERIFY_SQL")"
    if [[ "$result" != "1" ]]; then
      echo "Sentinel check failed in $db (expected 1, got '$result')" >&2
      failures=$((failures + 1))
    fi
  done
fi

if [[ "$failures" -ne 0 ]]; then
  echo "Restore verification FAILED: $failures mismatch(es)" >&2
  exit 1
fi
echo "Restore verification PASS: $checked tables matched ($SRC_DB -> $TARGET_DB)"
