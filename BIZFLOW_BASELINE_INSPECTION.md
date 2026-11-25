# BIZFLOW — Phase 1 Baseline Inspection Report

Branch: `blockchain-security-deployment-hardening`
Date: 2026-11-25
Method: source-level inspection of every tracked file plus local `.env`, git history and untracked `.github/` workflows. Existing `BIZFLOW_*.md` reports were read but **not trusted as evidence**; every statement below is cross-checked against code.

## 1. Baseline test execution (before modification)

Command: `make test-backend`, `make test-contract`, `make test-frontend` (executed sequentially, output captured at `/home/robi/tmp/opencode/bizflow-baseline/all.txt`).

| Suite | Result | Status |
|---|---|---|
| Backend pytest (`USE_SQLITE=true`) | **250 passed, 0 failed** | PASS |
| Soroban `cargo test` | **47 passed, 0 failed** | PASS |
| Frontend Vitest | **20 files, 262 tests passed, 0 failed** | PASS |

No test failed before modification. Warnings only (Starlette/httpx deprecation, Vitest 4 `setTimeout` argument style).

## 2. Current blockchain architecture

- Contract: one Soroban escrow instance holds exactly **one** agreement — `DataKey::Agreement` is a singleton (`contracts/escrow/src/lib.rs:98-102`), `init` rejects a second call (`:123-126`), milestones are indexed (`:165-179`). Contract logic (payer-only fund, authorized-only approve/release/refund, duplicate/over-release rejection, terminal state locks, checked arithmetic) is solid and has 47 passing tests.
- Backend: a **single global contract id** from `STELLAR_ESCROW_CONTRACT_ID` (`backend/app/config.py:36`) is used for every agreement. No backend code deploys or initializes a contract; no `init` invocation exists. The numeric on-chain agreement id is **client-supplied** at fund-prepare time (`backend/app/schemas.py:619-622`, `routers/agreements_chain.py:193-194`).
- The only cross-agreement binding guard is a TOCTOU runtime query (`agreements_chain.py:184-192`), not a database constraint (`models.py:239-242`).
- Event verification is real: `services/verification.py:168-265` reads Soroban events and matches hash, contract, symbol, agreement id, milestone index, payer and amount. **Contract state is not read after operations**; only `services/reconciliation.py:53-86` does an authoritative `get_balance` simulation, on demand.
- Stellar payment verification (`verification.py:72-140`) checks hash, success, asset, amount, memo, destination and (optionally) source, using `Decimal` arithmetic (`utils.py:43-59`). Network is asserted as the literal `"testnet"` rather than derived from the transaction.
- Duplicate protection exists via unique hash constraints (`models.py:289,323,334-335`) but `hash_already_used` is only called in the legacy fund path and `/transactions/verify`.

## 3. Contract deployment strategy

Out-of-band: the real contract was deployed and `init`-ed manually on Testnet; the id is recorded in `docs/TESTNET_DEPLOYMENT.md` and configured via env. The backend never deploys or initializes. A misconfigured/empty contract id disables escrow rather than inventing one (`config.py:35-36,85-87`) — correct behaviour, but one contract is shared across all agreements.

## 4. Agreement-to-contract relationship

`PaymentAgreement.escrow_contract_id` (`models.py:260`) and `onchain_agreement_id` (`:262`) are nullable, with **no uniqueness constraints**. Client-supplied contract ids are accepted only if they equal the trusted resolved value (`agreements_chain.py:127-148`) — no direct override exists. The weakness is the shared instance plus client-supplied numeric id and the absence of a verified binding to contract-stored state.

## 5. Current security controls

- JWT in `httpOnly`, `SameSite=lax`, optional `Secure` cookie (`routers/auth.py:38-49`), bcrypt hashing, `jti` revocation ledger checked per request (`security.py:68-86`).
- Business isolation: mandatory `X-Business-ID`, active-membership check (`security.py:108-128`), per-resource business filters across routers.
- RBAC via `require_roles` (`security.py:131-141`); consistent on payment/agreement endpoints.
- Strong validators for Stellar keys, contract ids, 64-hex hashes and decimal money (`schemas.py:61-80,605-607`); no float money and no string-built SQL.
- Rate limiting via SlowAPI per remote IP (`main.py:79-81`), explicit CORS allowlist, typed error envelope.
- No real secrets in tracked files or git history; `.env` files are gitignored.

## 6. Existing Docker configuration

Multi-stage, non-root images (`backend/Dockerfile:1-23`, `frontend/Dockerfile:1-29`); Compose has Postgres healthcheck and migration-on-start (`docker-compose.yml:13-17,33`). Gaps: no app healthchecks, Postgres `5432` published to host, floating base tags, no `frontend/.dockerignore`, frontend `npm ci || npm install` fallback, build-time-baked `BACKEND_ORIGIN`.

## 7. Current CI

Two workflows exist but are **untracked** (`.github/` is `??` in git): `ci.yml` runs backend pytest, frontend tests/typecheck/build and `cargo test`; `release.yml` publishes GHCR images on tags. Missing: backend lint/typecheck, frontend lint step, migration validation, dependency security scans, `needs: ci` on release. Dependencies not fully pinned (Python ranges, unpinned action tags).

## 8. Baseline gaps confirmed by source (no previously reported claim accepted without verification)

Blockchain: shared escrow instance with no DB binding constraints; `init` never invoked/verified by backend; client-supplied `onchain_agreement_id`; no post-operation contract-state read; release event verification ignores amount; duplicate-hash pre-check missing in all escrow submit paths; network asserted not verified; `cancel` has no on-chain refund; reconciliation results are not persisted (a frozen dataclass plus one audit row only).

Security: **no CSRF mechanism at all** (three cookie-only state-changing endpoints: logout, invitation accept/reject); no security headers; publicly known dev JWT fallback key (`config.py:74-78`); cross-tenant role claim via unverified email on registration (`auth.py:81-88`); no role checks on wallet connect/delete, reports, audit-log and member listing; unvalidated 64-hex path params for transaction routes; unbounded `signed_xdr`/text; upstream exception text returned to clients; correlation id never logged; incomplete logout revocation when both bearer and cookie are present.

Deployment: no app health/readiness probes; migrations never exercised by CI and broken `0003` downgrade; env var names disagree with consumed settings (`ACCESS_TOKEN_EXPIRE_MINUTES`, `SQLITE_URL`, `NEXT_PUBLIC_API_URL`); dev defaults survive into "production" unless `ENVIRONMENT` is set precisely; GHCR images bake `http://backend:8000` at build time; both workflows untracked.

## 9. Tests that failed before modification

None. All three suites were green. Therefore any later failure is a regression introduced by this work and must be fixed, not hidden.
