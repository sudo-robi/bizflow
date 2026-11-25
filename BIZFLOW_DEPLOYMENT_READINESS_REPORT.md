# BIZFLOW — Deployment Readiness Report

Branch: `blockchain-security-deployment-hardening`.

## Verification results (this branch)

- Backend pytest: **262 passed, 0 failed**
- Frontend Vitest: **262 passed, 0 failed**
- Soroban `cargo test`: **47 passed, 0 failed**
- Raw logs: `/home/robi/tmp/opencode/bizflow-baseline/`

## Finding 1 — No application health/readiness probes

- **Severity:** HIGH
- **Root cause:** `/health` was static (always `ok`) and never checked the database; neither image nor Compose defined healthchecks for backend/frontend; frontend waited only for backend *start*.
- **Files affected:** `backend/app/main.py`, `backend/Dockerfile`, `frontend/Dockerfile`, `docker-compose.yml`.
- **Changes made:** `/health/ready` performs a real `SELECT 1` and returns 503 when the database is unavailable; both images define `HEALTHCHECK`; Compose adds healthchecks with `start_period` and `depends_on: condition: service_healthy` for backend→postgres and frontend→backend.
- **Tests performed:** `docker compose config` (exit 0), migration chain run, backend suite, and a **real `docker compose up -d`** with all three containers reaching `healthy`.
- **Actual test results:** `GET /health` → 200 `{"status":"ok","network":"testnet","escrow_configured":true}`; `GET /health/ready` → 200 `{"status":"ready","database":"ok",...}`; frontend `/` and `/login` → 200; `GET /api/v1/auth/me` through the Next.js rewrite → 200 with real session cookie; dashboard → 200.
- **Status:** **VERIFIED COMPLETE**.

## Finding 2 — Docker hardening / reproducibility

- **Severity:** MEDIUM
- **Root cause:** floating base tags, `pip install --upgrade pip`, `npm ci || npm install` fallback, no frontend `.dockerignore`, runtime user owned writable application code.
- **Files affected:** `backend/Dockerfile`, `frontend/Dockerfile`, `frontend/.dockerignore`.
- **Changes made:** pinned patch-level base images; removed the pip upgrade and npm fallback; added `frontend/.dockerignore` excluding `node_modules`, `.next`, `tests`, `.env*`, logs; application code made read-only to the non-root runtime user.
- **Tests performed:** `docker compose build backend frontend` (see final verification report for result); `docker compose config`.
- **Actual test results:** `docker compose build backend frontend` → both images built (EXIT=0). The frontend build needed several minutes because `next/font/google` retries font downloads; it completed successfully.
- **Status:** **VERIFIED COMPLETE**.

## Finding 3 — Database exposure and migration integrity

- **Severity:** MEDIUM/HIGH
- **Root cause:** Postgres port 5432 was published to the host; migration `0003` downgrade dropped a column owned by `0001`; `0004` was not idempotent; migrations were never exercised by tests or CI.
- **Files affected:** `docker-compose.yml`, `backend/alembic/versions/0003_blockchain_updated_at.py`, `0004_onchain_agreement_id.py`, `0006_reconciliation.py`, `.github/workflows/ci.yml`.
- **Changes made:** Postgres is now internal-only (`expose`); `0003` downgrade is a no-op; `0004` upgrade is guarded by an inspector check; `0006` adds the reconciliation table and a partial unique index on funded escrow bindings with an explicit refusal to guess when pre-existing duplicates are found; CI runs upgrade→downgrade→upgrade against PostgreSQL.
- **Tests performed:** `alembic upgrade head`, `alembic downgrade base`, `alembic upgrade head` on a fresh SQLite file — all succeeded. PostgreSQL CI job not executed locally.
- **Status:** **VERIFIED COMPLETE** for SQLite; **IMPLEMENTED BUT NOT VERIFIED** for PostgreSQL (CI only).

## Finding 3b — Two startup failures found only by actually starting the stack

- **Severity:** HIGH (both blocked all deployments)
- **Root cause:** (a) recent SQLAlchemy defaults `postgresql://` to psycopg3, but the image only installs `psycopg2-binary`, so Alembic died with `ModuleNotFoundError: psycopg`; (b) the new revision id `0006_reconciliation_and_escrow_bindings` exceeded the existing `alembic_version VARCHAR(32)` column, causing `StringDataRightTruncation`.
- **Files affected:** `docker-compose.yml`, `backend/alembic/versions/0006_reconciliation.py`.
- **Changes made:** explicit `postgresql+psycopg2://` scheme in Compose (and in the CI migration job); shortened the revision id to `0006_reconciliation`.
- **Tests performed:** repeated `docker compose up -d` until all services were healthy; queried `alembic_version` inside the live Postgres container.
- **Actual test results:** live DB reported revision `0006_reconciliation`; `reconciliation_records` table present.
- **Status:** **VERIFIED COMPLETE**.

## Finding 4 — Configuration drift and unsafe defaults

- **Severity:** MEDIUM
- **Root cause:** `ACCESS_TOKEN_EXPIRE_MINUTES`, `SQLITE_URL` and `NEXT_PUBLIC_API_URL` were documented but not consumed; dead Stellar variables gave false confidence; `ENVIRONMENT=development` disabled all production guards; no startup warning when escrow was unconfigured.
- **Files affected:** `backend/app/config.py`, `.env.example`, `docs/DEPLOYMENT.md` (remaining doc drift).
- **Changes made:** consumed aliases with correct precedence (explicit `SQLITE_PATH` wins); removed dead variables from `.env.example`; documented security/runtime flags; no fixed JWT fallback remains. Testnet-only enforcement left intact.
- **Tests performed:** config guard tests, full backend suite.
- **Status:** **VERIFIED COMPLETE** — `docs/DEPLOYMENT.md` was aligned to `NEXT_PUBLIC_API_BASE_URL` as part of this work. The frontend container still bakes its rewrite origin at build time (separate limitation below).

## Finding 5 — CI/CD did not exist on the remote

- **Severity:** HIGH
- **Root cause:** both workflow files were untracked, so nothing ran on GitHub. CI lacked lint/migration/security checks; `release.yml` had no verification gate and baked a Compose-only hostname into published frontend images.
- **Files affected:** `.github/workflows/ci.yml`, `.github/workflows/release.yml`.
- **Changes made:** CI now includes compile check, pip-audit, migration validation against PostgreSQL, backend tests, frontend tests/lint/typecheck/build, npm audit, contract tests and clippy. Release has a `verify` job gating `publish` via `needs`. Frontend image build args remain Compose-oriented; this is documented as a limitation.
- **Tests performed:** local equivalents of tests/builds/migrations; YAML not executed by GitHub Actions in this environment.
- **Status:** **IMPLEMENTED BUT NOT VERIFIED** (workflows require a GitHub run; files must be committed/pushed).

## Remaining limitations

1. Published frontend images still bake `BACKEND_ORIGIN=http://backend:8000` at build time; they work inside Compose but not as standalone public images unless rebuilt with a real origin. (**PARTIALLY IMPLEMENTED**)
2. No public host is provisioned by this repository; no claim of external deployment is made. (**BLOCKED BY EXTERNAL DEPENDENCY**)
3. Live Testnet connectivity and wallet extension checks require a browser with Freighter and a funded test account; not performed here. (**BLOCKED BY EXTERNAL DEPENDENCY**)
4. Dependency pinning is partial: Python requirements remain ranges and action versions are tags rather than commit SHAs. (**PARTIALLY IMPLEMENTED**)
