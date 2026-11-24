.PHONY: help setup-backend test-backend run-backend setup-frontend test-frontend run-frontend test-contract build-contract dev docs

help:
	@echo "BizFlow targets:"
	@echo "  setup-backend    create venv and install Python deps"
	@echo "  test-backend     run pytest (SQLite test DB)"
	@echo "  run-backend      start FastAPI on :8000"
	@echo "  setup-frontend   npm install"
	@echo "  test-frontend    run vitest"
	@echo "  run-frontend     start Next.js dev on :3000"
	@echo "  test-contract    cargo test for Soroban escrow"
	@echo "  build-contract   build wasm release artifact"
	@echo "  dev              start backend + frontend together"

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
	cd contracts/escrow && cargo build --target wasm32-unknown-unknown --release

dev:
	@echo "Run 'make run-backend' and 'make run-frontend' in two terminals, or use docker compose up."
