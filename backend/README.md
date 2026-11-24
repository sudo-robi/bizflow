# BizFlow backend

FastAPI backend for BizFlow, a Stellar **testnet-only** business payments platform.

## Setup

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
```

Required environment variables (see `app/config.py` for all defaults):

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | PostgreSQL DSN (`postgresql+psycopg2://...`) used when `USE_SQLITE` is false |
| `JWT_SECRET` | HS256 signing secret (set a strong value in production) |
| `STELLAR_NETWORK_PASSPHRASE` | Must be `Test SDF Network ; September 2015` |
| `STELLAR_HORIZON_URL` | `https://horizon-testnet.stellar.org` |
| `STELLAR_SOROBAN_RPC_URL` | `https://soroban-testnet.stellar.org` |
| `STELLAR_ESCROW_CONTRACT_ID` | C-address of the deployed escrow contract; empty disables escrow |
| `CORS_ORIGINS` | Comma-separated browser origins |
| `USE_SQLITE` / `SQLITE_PATH` / `RATE_LIMIT_PER_MINUTE` | Local/test options |

The app **refuses to start** on a mainnet passphrase or mainnet Horizon/RPC URL.
It never invents a contract ID and never stores or returns private keys.

## Run

```bash
# PostgreSQL (schema via Alembic)
.venv/bin/alembic upgrade head
.venv/bin/uvicorn app.main:app --reload --port 8000

# Local SQLite (schema is created at startup)
USE_SQLITE=true SQLITE_PATH=./bizflow.sqlite3 JWT_SECRET=change-me \
  .venv/bin/uvicorn app.main:app --reload --port 8000
```

Interactive docs: `http://localhost:8000/docs`. Health: `/health`.

## Tests

```bash
.venv/bin/pytest -q
```

Tests use a real in-memory SQLite database, isolated per test. Only external
Horizon/RPC boundaries are mocked; verification logic, XDR construction, PDF
generation and all settlement rules run for real.

## API notes

- Base path `/api/v1`; business-scoped calls require `Authorization: Bearer <jwt>`
  and `X-Business-ID: <uuid>`. Every query is filtered by verified membership.
- Money values are decimal **strings** (`"1250.5"`); stored as `Numeric(20, 7)`.
- Invoice status is derived from payment records confirmed on-chain. A failed or
  unconfirmed transaction is recorded but never credits an invoice.
- Payment preparation builds a real Stellar payment (`Asset` object, `TextMemo`)
  and stores the precomputed hash. Submission polls Horizon and independently
  verifies `successful`, `from`, `to`, asset, amount and memo before settlement.
- Escrow releases call Soroban `simulateTransaction`/`assembleTransaction` (via
  the SDK's `prepare_transaction`) and require a matching `released` event.
- Receipts/invoice PDFs are served from `GET /payments/{id}/receipt` and
  `GET /invoices/{id}/pdf`.
- `GET /verify/{hash}` is public and exposes only minimal receipt data.
