# BizFlow

**Business payments, supplier management and programmable settlement on Stellar.**

BizFlow is a B2B fintech application for managing suppliers, invoices, payment
agreements and milestone-based settlement. It combines an audited business backend
with independently verified on-chain payments and a deployed Soroban escrow contract.
No private keys, seed phrases or secret recovery phrases are ever requested or stored.

## What is implemented

- Authentication, JWT sessions, bcrypt password hashing, role-based access control
  (owner, admin, finance manager, supplier) enforced on the backend.
- Strict business (tenant) isolation on every data query.
- Supplier directory with Stellar address validation, search, filters and archives.
- Invoices with line items, unique references, derived statuses, cancellation rules
  and downloadable PDFs.
- Payment agreements with a guarded state machine and milestone definitions.
- Soroban escrow contract (Rust) with funding, approval, release, refund and events,
  deployed on-chain with a real contract id verified against the network RPC.
- Freighter wallet integration: network detection, network enforcement, address and
  balance display, explicit transaction approval UI, signature and rejection handling.
- Real Stellar payment building, signing, submission, polling and **independent
  verification** against Horizon / Soroban RPC before any status changes.
- Payment receipts from verified transactions only, in-app notifications, immutable
  audit log, CSV export and a dashboard built from real database aggregates.
- A public receipt verification page.
- Docker Compose setup, migrations, automated tests and documentation.

See `docs/API_CONTRACT.md`, `docs/ARCHITECTURE.md` and `docs/DATABASE.md`.

## Repository layout

```
backend/     FastAPI application, SQLAlchemy models, Alembic migrations, pytest suite
frontend/    Next.js App Router UI, Freighter + Stellar SDK integration, Vitest tests
contracts/   Soroban escrow contract (Rust) and its automated test suite
docs/        Architecture, API, database, contract, testing, deployment and Testnet records
```

## Run locally (Docker Compose)

```bash
cp .env.example .env
# edit .env: set JWT_SECRET and POSTGRES_PASSWORD
docker compose up --build -d
```

Local ports are configurable in `.env` (`FRONTEND_PORT`, `BACKEND_PORT`). For a
publicly reachable instance, see [Deployment](#deployment--packages) below and
`docs/DEPLOYMENT.md`.

## Run locally (processes)

```bash
# Backend
make setup-backend
make run-backend          # http://localhost:8000

# Frontend (second terminal)
make setup-frontend
make run-frontend         # http://localhost:3000
```

For a Postgres-free test run, `make test-backend` uses a real SQLite database
(`USE_SQLITE=true`); this is never browser localStorage.

## Tests

```bash
make test-backend
make test-frontend
make test-contract
python docs/scripts/testnet_smoke.py   # needs TESTNET_SECRET for a funded Testnet account
```

See `docs/TESTING.md` for executed results and exact commands.

## Configuration

All configuration is read from environment variables; see `.env.example` and
`docs/DEPLOYMENT.md`. Required secrets: `JWT_SECRET`, `POSTGRES_PASSWORD`.
Never commit `.env`. The backend is configured for the Stellar test network and
refuses other network settings. The deployed contract id and independently verified
transaction hashes are recorded in `docs/TESTNET_DEPLOYMENT.md`.

## Deployment & packages

Container images are published to GitHub Container Registry on version tags:

- Backend: `ghcr.io/sudo-robi/bizflow-backend`
- Frontend: `ghcr.io/sudo-robi/bizflow-frontend`
- Releases: <https://github.com/sudo-robi/bizflow/releases>

A public host must be provisioned to expose the stack; see `docs/DEPLOYMENT.md`
for the required environment and reverse-proxy configuration. No public host is
provisioned by this repository alone, and no URL is claimed here unless it has
actually been deployed and health-checked.

## Documentation

- `docs/ARCHITECTURE.md` — system design and trust boundaries
- `docs/API_CONTRACT.md` — endpoint contract
- `docs/DATABASE.md` — schema and status derivation
- `docs/SMART_CONTRACTS.md` — escrow contract design
- `docs/TESTNET_SETUP.md` — Testnet and wallet setup
- `docs/TESTNET_DEPLOYMENT.md` — real deployed contract and transaction record
- `docs/TESTING.md` — test suites and executed results
- `docs/DEPLOYMENT.md` — deployment instructions
- `docs/TASK_CHECKLIST.md` — execution checklist with VERIFIED evidence per feature
