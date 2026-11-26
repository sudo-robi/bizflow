.PHONY: help setup-backend test-backend run-backend setup-frontend test-frontend run-frontend test-contract build-contract dev docs backup-db restore-db verify-restore

help:
	@echo "BizFlow targets:"
	@echo "  setup-backend    create venv and install Python deps"
	@echo "  test-backend     run pytest (SQLite test DB)"
	@echo "  run-backend      start FastAPI on :8000"
	@echo "  setup-frontend   npm install"
	@echo "  test-frontend    run vitest"
	@echo "  run-frontend     start Next.js dev on :3000"
	@echo "  test-contract    cargo test for Soroban escrow"
	@echo "  build-contract   build wasm release artifact (wasm32v1-none)"
	@echo "  dev              start backend + frontend together"
	@echo "  backup-db        pg_dump the live Postgres DB into backups/"
	@echo "  restore-db       restore a dump into a SEPARATE scratch DB (BACKUP_FILE, TARGET_DB)"
	@echo "  verify-restore   compare row counts between source and scratch DB (TARGET_DB)"

setup-backend:
	cd backend && python3 -m venv .venv && .venv/bin/pip install -r requirements.txt

test-backend:
	cd backend && USE_SQLITE=true .venv/bin/pytest -q

run-backend:
	cd backend && USE_SQLITE=true .venv/bin/uvicorn app.main:app --reload --port 8000

setup-frontend:
	cd frontend && npm install

test-frontend:
	cd frontend && npm test -- --run

run-frontend:
	cd frontend && npm run dev

test-contract:
	cd contracts/escrow && cargo test

build-contract:
	cd contracts/escrow && STELLAR_CLI_VERSION=30.0.0 cargo build --target wasm32v1-none --release

backup-db:
	POSTGRES_DB="$(POSTGRES_DB)" BACKUP_DIR="$(BACKUP_DIR)" BACKUP_FILE="$(BACKUP_FILE)" ./scripts/backup_db.sh

restore-db:
	POSTGRES_DB="$(POSTGRES_DB)" BACKUP_FILE="$(BACKUP_FILE)" TARGET_DB="$(TARGET_DB)" ./scripts/restore_db.sh

verify-restore:
	POSTGRES_DB="$(POSTGRES_DB)" SRC_DB="$(SRC_DB)" TARGET_DB="$(TARGET_DB)" VERIFY_SQL="$(VERIFY_SQL)" ./scripts/verify_restore.sh

dev:
	@echo "Run 'make run-backend' and 'make run-frontend' in two terminals, or use docker compose up."
