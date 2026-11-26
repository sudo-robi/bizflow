# Deployment

BizFlow is meant to be demonstrated locally or in a container environment. Blockchain
operations remain on **Stellar Testnet** in every configuration. This document does
**not** claim production readiness or a public deployment.

## Prerequisites

- Docker 24+ and Docker Compose v2, **or** Python 3.12+ and Node 22+ locally.
  CI and both Dockerfiles use Python 3.12 and Node 22.
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
| `NEXT_PUBLIC_API_BASE_URL` | Browser-visible backend base URL |

Generate a secret with:

```bash
python3 -c "import secrets; print(secrets.token_urlsafe(48))"
```

The backend validates that the configured network is Testnet and refuses to start
otherwise. Secrets are never sent to the browser; the frontend receives only public
wallet addresses and signed XDR from Freighter. Cookie-authenticated writes use a
double-submit CSRF token (`bizflow_csrf` cookie / `X-CSRF-Token` header), issued on
login/register; cross-origin requests are rejected unless explicitly exempted.

## Reproducible installs

Runtime ranges live in `backend/requirements.txt`. Exact versions observed in this
repository are pinned in `backend/constraints.txt` (captured with `pip freeze` from
`backend/.venv`). Use constraints when the exact build matters:

```bash
cd backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt -c constraints.txt
```

`backend/Dockerfile` currently installs `requirements.txt` without the constraints
file and cannot be changed in this closure cycle; add `-c constraints.txt` there in a
follow-up if byte-for-byte reproducible images are required. Hashed lockfile
generation was verified locally:

```bash
pip install pip-tools
pip-compile --generate-hashes --strip-extras -o backend/requirements.hashed.txt backend/requirements.txt
```

The generated 1,666-line artifact was produced successfully but is not committed
because it is outside this cycle's file scope. The constraints file was captured on
Python 3.14 while CI/Docker use Python 3.12; validate resolution when changing the
base image.

## Docker Compose (recommended)

```bash
docker compose up --build -d
docker compose logs -f backend
```

Compose starts Postgres, runs Alembic migrations, then the API and frontend. Verify:

```bash
curl -fsS http://localhost:8000/health/ready
curl -fsS -o /dev/null -w '%{http_code}\n' http://localhost:3000/
```

Executed on 2026-11-25 in this environment (host ports 8000/3000 were already in use,
so alternate host ports were used; container ports and data are unchanged):

```bash
BACKEND_PORT=18000 FRONTEND_PORT=13000 docker compose up -d
curl -fsS http://127.0.0.1:18000/health/ready
# {"status":"ready","database":"ok","network":"testnet","escrow_configured":true}
curl -sS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:13000/
# 200
curl -fsS -o /dev/null -w '%{http_code}\n' http://127.0.0.1:18000/openapi.json
# 200 (71 documented paths)
```

Dockerfile builds were also verified directly:

```bash
docker build -f backend/Dockerfile backend -t bizflow-backend:ci-verify
docker build -f frontend/Dockerfile frontend \
  --build-arg NEXT_PUBLIC_API_BASE_URL=/api/v1 \
  --build-arg BACKEND_ORIGIN=http://backend:8000 -t bizflow-frontend:ci-verify
```

Both exited 0 and produced images (`bizflow-backend:ci-verify`,
`bizflow-frontend:ci-verify`).

## Local processes

```bash
make setup-backend
cd backend && .venv/bin/alembic upgrade head && cd ..
make run-backend

make setup-frontend
make run-frontend
```

The frontend calls the backend at `NEXT_PUBLIC_API_BASE_URL`. Cookies are httpOnly, so the
browser origin and API URL must be compatible with CORS/`credentials: include`.

## Database migrations

```bash
cd backend
.venv/bin/alembic upgrade head          # apply
.venv/bin/alembic downgrade -1          # one step back
.venv/bin/alembic revision --autogenerate -m "description"
```

The documented reconciliation-closure head is `0006_reconciliation`; verify the actual
head with `alembic heads` before deploying, since later migrations may be added in
working copies (an uncommitted `0007_member_invites` was present during this cycle).
Migrations are required for PostgreSQL. `USE_SQLITE=true` creates tables directly for
local tests.

## Backup, restore and restore drill

The `postgres_data` volume holds all business data. `scripts/backup_db.sh` streams a
custom-format `pg_dump` from the running Compose `postgres` service. `scripts/restore_db.sh`
restores **only into a new scratch database**; it refuses system databases, the live
database and any target that already exists. `scripts/verify_restore.sh` compares row
counts for every public table and optionally checks a sentinel query.

```bash
make backup-db                                  # writes backups/<db>_<UTC>.dump
make restore-db BACKUP_FILE=<dump> TARGET_DB=bizflow_restore_<stamp>
make verify-restore TARGET_DB=bizflow_restore_<stamp>
# optional sentinel: VERIFY_SQL="SELECT ...;" must return 1 in both DBs
```

**Policy (demonstration environment):** RPO = 15 minutes (schedule `backup-db` at
least every 15 minutes when the stack is in use); RTO = 30 minutes (restore into a
scratch DB plus verification); retention = 7 daily and 4 weekly dumps, then delete —
no automated retention job is configured yet. Backups must be stored encrypted at rest
(e.g. an encrypted volume or `age`/GPG-encrypted object) and access-limited to the
operator; the scripts deliberately do not embed encryption keys. A restore is never a
rollback of application code; see the manual rollback steps below.

**Executed restore drill (2026-11-25, Docker Compose v5.7.0, Engine 28.5.2):** only the
`postgres` service was started; two scratch databases were created; a sentinel row was
inserted into the source scratch DB; the dump was restored into a **different** scratch
DB; row counts and the sentinel were verified; then both scratch DBs were dropped. The
live `bizflow` database was never modified.

```bash
docker compose up -d postgres
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d postgres \
  -v ON_ERROR_STOP=1 -c 'CREATE DATABASE bizflow_drill_src;' -c 'CREATE DATABASE bizflow_drill_dst;'
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d bizflow_drill_src \
  -v ON_ERROR_STOP=1 -c 'CREATE TABLE drill_probe (id integer PRIMARY KEY, note text NOT NULL);' \
  -c "INSERT INTO drill_probe (id, note) VALUES (1, 'restore-drill');"

POSTGRES_DB=bizflow_drill_src BACKUP_FILE=/home/robi/tmp/opencode/drill/drill.dump ./scripts/backup_db.sh
# Backup complete: /home/robi/tmp/opencode/drill/drill.dump

POSTGRES_DB=bizflow_drill_src TARGET_DB=bizflow_drill_dst \
  BACKUP_FILE=/home/robi/tmp/opencode/drill/drill.dump ./scripts/restore_db.sh
# Restore complete: bizflow_drill_dst

SRC_DB=bizflow_drill_src TARGET_DB=bizflow_drill_dst \
  VERIFY_SQL="SELECT CASE WHEN EXISTS (SELECT 1 FROM public.drill_probe WHERE note = 'restore-drill') THEN 1 ELSE 0 END;" \
  ./scripts/verify_restore.sh
# Restore verification PASS: 1 tables matched (bizflow_drill_src -> bizflow_drill_dst)

docker compose exec -T postgres psql -U "$POSTGRES_USER" -d bizflow_drill_dst -Atc 'SELECT id, note FROM public.drill_probe;'
# 1|restore-drill
```

A safety check was exercised: attempting to restore over the live `bizflow` database
exited 1 with `Refusing to overwrite ...` (the target already existed). `make backup-db`
and `make verify-restore` were also executed successfully against the scratch DBs.

## Contract deployment

See `SMART_CONTRACTS.md` and `TESTNET_DEPLOYMENT.md`. The wasm must be built with the
`wasm32v1-none` target (Soroban SDK 30); `wasm32-unknown-unknown` is rejected by the SDK
on Rust 1.82+. The SDK build script additionally requires a Stellar CLI v30+ (or the
`STELLAR_CLI_VERSION=30.0.0` build override used in CI); production artifacts must be
built with `stellar contract build`. Deploy with the official CLI using a funded
Testnet source account, then put the printed contract id into `.env`. Never invent a
contract id or reuse a mainnet address.

## CI/CD gates

`.github/workflows/ci.yml` is blocking (no `continue-on-error`): pip-audit fails on any
known vulnerability (a strict superset of high/critical — pip-audit does not expose
severity in its output), `npm audit --audit-level=high` fails on high/critical, and
Clippy fails with two explicitly named lint allowances. Backend correctness lint uses
`ruff --select E9,F63,F7,F82`; full ruff findings and mypy's 53 pre-existing type errors
are documented in `TESTING.md`, not silently ignored. Jobs verify migrations and the
OpenAPI schema, and build both Docker images. `release.yml` mirrors these gates before
publishing; `deploy-demo.yml` deploys only after versioned images exist.

**Residual limitation:** GitHub Actions are referenced by mutable major version tags
(`@v4`, `@v5`, `@v6`) rather than commit SHAs. Pinning each action to a full SHA is a
recommended follow-up once the workflows are accepted on the remote.

## Demo deployment workflow (not executed)

`.github/workflows/deploy-demo.yml` triggers on `workflow_dispatch` and tag pushes
`v*`; it targets the GitHub environment `testnet-demo` and uses these secrets **by name
only**: `DEMO_HOST`, `DEMO_SSH_USER`, `DEMO_SSH_PRIVATE_KEY`, `DEMO_DEPLOY_PATH`,
`JWT_SECRET`, `POSTGRES_PASSWORD`, `STELLAR_ESCROW_CONTRACT_ID`. It resolves the tag,
waits for both GHCR image tags, SSHes to the host, renders a Compose override with the
versioned images, pulls/up, runs `alembic upgrade head`, and smoke-tests `/health/ready`
plus the frontend. **This workflow has not been run.**

Exact remaining action to execute it:

1. Grant a GitHub token with `workflow` + `write:packages` scope and commit the three
   workflow files (the current active token has `repo` only; remote
   `.github/workflows/` returns 404).
2. Create the `testnet-demo` environment and add the seven secrets listed above; the
   host must already contain a working `docker-compose.yml` and `.env`.
3. Push a `v*` tag (Release publishes images first) or dispatch the workflow with an
   explicit existing tag; watch the `deploy` job.
4. **Manual rollback (no automatic rollback):** on the host, set `PREVIOUS_TAG` to the
   last known-good release, regenerate `docker-compose.demo.yml` with that tag, then
   `docker compose -f docker-compose.yml -f docker-compose.demo.yml pull backend frontend`
   and `... up -d --remove-orphans backend frontend`, then re-run both smoke checks.
   Do not downgrade the schema automatically; only roll back to a release compatible
   with the current Alembic head.

## Operational notes

- Verified blockchain transaction hashes are immutable references; the audit log has no
  update/delete endpoint.
- Rate limiting is enabled; tune `RATE_LIMIT_PER_MINUTE` for your environment.
- This is a demonstration deployment. It is not a production payment processor, holds
  no real funds, and carries no licenses or regulatory approvals.

## Live deployment status (this environment)

| Item | Status |
|---|---|
| Source repository | <https://github.com/sudo-robi/bizflow> |
| Releases | v0.1.0–v0.4.0 exist on the remote (verified with `gh release list`). |
| Workflows on remote | **Blocked**: `.github/workflows/` returns 404 because the active token lacks `workflow` scope. All three workflow files are prepared locally only. |
| Container packages (GHCR) | **Not published**: repository/user package listings returned 404; no `ghcr.io/sudo-robi/bizflow-*` images exist yet. README does not claim otherwise. |
| Public host | **Blocked**: no hosting account/credentials are configured; no public URL is claimed. |
| Local stack | Backend verified live (health/ready 200, OpenAPI 200 with 71 paths); frontend verified live (HTTP 200); both Docker builds and `docker compose up -d` verified locally. |
| GitHub workflow execution | **Not performed**: no workflow has been committed to or run on the remote in this cycle. |
