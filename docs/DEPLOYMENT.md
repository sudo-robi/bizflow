# Deployment

BizFlow is meant to be demonstrated locally or in a container environment. Blockchain
operations remain on **Stellar Testnet** in every configuration.

## Prerequisites

- Docker 24+ and Docker Compose v2, **or** Python 3.11+ and Node 20+ locally.
- A funded Stellar Testnet account (for live settlement and contract deployment).
- Freighter browser extension configured for Testnet (for wallet flows).

## Environment

```bash
cp .env.example .env
```

Set at minimum:

| Variable | Purpose |
|---|---|
| `JWT_SECRET` | Long random string used to sign session tokens |
| `POSTGRES_PASSWORD` | Database password |
| `DATABASE_URL` | SQLAlchemy PostgreSQL URL |
| `STELLAR_NETWORK_PASSPHRASE` | Must be `Test SDF Network ; September 2015` |
| `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` |
| `STELLAR_SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` |
| `STELLAR_ESCROW_CONTRACT_ID` | The **real** deployed Testnet contract id |
| `CORS_ORIGINS` | Comma-separated frontend origins |
| `NEXT_PUBLIC_API_URL` | Browser-visible backend base URL |

Generate a secret with:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

The backend validates that the configured network is Testnet and refuses to start
otherwise. Secrets are never sent to the browser; the frontend receives only public
wallet addresses and signed XDR from Freighter.

## Docker Compose (recommended)

```bash
docker compose up --build -d
docker compose logs -f backend
```

Compose starts Postgres, runs Alembic migrations, then the API and frontend.
Verify:

```bash
curl http://localhost:8000/health
```

## Local processes

```bash
make setup-backend
cd backend && .venv/bin/alembic upgrade head && cd ..
make run-backend

make setup-frontend
make run-frontend
```

The frontend calls the backend at `NEXT_PUBLIC_API_URL`. Cookies are httpOnly, so the
browser origin and API URL must be compatible with CORS/`credentials: include`.

## Database migrations

```bash
cd backend
.venv/bin/alembic upgrade head          # apply
.venv/bin/alembic downgrade -1          # one step back
.venv/bin/alembic revision --autogenerate -m "description"
```

Migrations are required for PostgreSQL. `USE_SQLITE=true` creates tables directly for
local tests.

## Contract deployment

See `SMART_CONTRACTS.md` and `TESTNET_DEPLOYMENT.md`. The wasm must be built with the
`wasm32v1-none` target (Soroban SDK 30). Deploy with the official CLI using a funded
Testnet source account, then put the printed contract id into `.env`. Never invent a
contract id or reuse a mainnet address.

## Operational notes

- Backups: the PostgreSQL volume `postgres_data` holds all business data. Back it up.
- Verified blockchain transaction hashes are immutable references; the audit log has no
  update/delete endpoint.
- Rate limiting is enabled; tune `RATE_LIMIT_PER_MINUTE` for your environment.
- This is a demonstration deployment. It is not a production payment processor, holds
  no real funds, and carries no licenses or regulatory approvals.
