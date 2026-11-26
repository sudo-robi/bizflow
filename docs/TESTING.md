# Testing

All commands below were executed in this repository unless explicitly marked as
not executed. Results are reported as observed; no test result is claimed without
running it.

## Backend (pytest)

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt -c constraints.txt
USE_SQLITE=true .venv/bin/pytest -q
```

Uses a real in-memory SQLite database (`USE_SQLITE=true`) so no external service is required.
Covers authentication, RBAC, tenant isolation, supplier CRUD, invoice validation and
status derivation, duplicate-payment prevention, agreement state transitions,
verification service behaviour, receipts, audit logging, CSRF enforcement and correlation IDs.
External Horizon calls are mocked **only in unit tests**; application code always calls the
real network.

**Executed result (closure baseline): 262 backend tests passed.** During the final
verification, concurrent closure work added two test modules; the last snapshot was
**284 passed, 1 warning** (`pytest -o addopts='' -q --disable-warnings`, exit 0). An
intermediate run while `backend/app` was being edited failed 26 tests (membership
activation flow); that run is not presented as a passing result. Re-run the exact command
above after source changes settle. Historical coverage run: 95% (3208 statements, 174 missed).

## Frontend (Vitest + Next build)

```bash
cd frontend
npm ci --no-audit --no-fund
npm test -- --run
npm run lint
npm run typecheck
npm run build
```

**Executed result (verified in this cycle):**
- `npx vitest run` — **20 test files, 262/262 tests passed** in 10.27s.
- `npm run typecheck` and `npm run build` — PASS (20/20 static pages in the last full build).
- Line coverage from the prior full run: **86.68%**; `src/lib` and `src/components` 100%.
- Browser smoke check via Playwright: landing and auth pages rendered, responsive layouts
  inspected, no application console errors.

## Smart contract (cargo test)

```bash
cd contracts/escrow
cargo fmt --check
cargo test
cargo clippy -- -D warnings -A clippy::too_many_arguments -A clippy::needless_borrows_for_generic_args
rustup target add wasm32v1-none
STELLAR_CLI_VERSION=30.0.0 cargo build --target wasm32v1-none --release
stellar contract build                    # official optimized artifact
```

**Executed result (2026-11-25):**
- `cargo test` — **47 passed; 0 failed**; `cargo llvm-cov` lib.rs lines **98.28%**.
- `cargo clippy` with the two explicitly named allowances — PASS. Plain `-D warnings`
  fails on macro-generated `too_many_arguments` and one needless borrow; these are
  documented, not hidden behind `continue-on-error`.
- `cargo build --target wasm32-unknown-unknown --release` is rejected by SDK 30 on
  Rust 1.84+; `wasm32v1-none` is the correct target. Raw cargo builds also require the
  SDK's `STELLAR_CLI_VERSION` guard; deployable artifacts must use `stellar contract build`.
- The official `stellar contract build` produced an optimized WASM of 11,987 bytes, hash
  `65db0f966e0f18ac59272ce6f664b66a62c1780b74b612f1e69f02081743a7cd` in the earlier build
  cycle. The Stellar CLI is not installed in this environment, so that command was not
  re-executed here; the CI WASM step uses the documented target and build override.

## CI gates (authored, not executed on GitHub)

`.github/workflows/ci.yml` and `.github/workflows/release.yml` use blocking checks:

| Gate | Command / policy | Local observation |
|---|---|---|
| Backend correctness lint | `ruff check --isolated --select E9,F63,F7,F82 backend/app backend/tests` | PASS |
| Full backend lint (not a gate yet) | `ruff check backend/app backend/tests` | ~475 pre-existing style findings (mostly B008 FastAPI `Depends` defaults, F401 unused imports, I001, UP017); tracked as separate cleanup. Not silently ignored — the command is printed here and runs locally. |
| Backend typecheck (not a gate yet) | `mypy backend/app` | 53 errors with the backend venv visible (116 without it): missing stubs, optional-datetime comparisons, two `_fail_unverified_state` call sites. Permitted by the closure scope to document rather than add `backend/mypy.ini`; no error is suppressed in CI. |
| Dependency audit (Python) | `pip-audit --strict -r requirements.txt` | PASS locally (no known vulnerabilities). pip-audit does not expose severity, so any finding fails the gate. |
| Dependency audit (JS) | `npm audit --audit-level=high` | Fails high/critical; no `continue-on-error`. |
| Migrations | Postgres `alembic upgrade head` → `downgrade base` → `upgrade head` | PASS |
| API schema | start uvicorn, poll `/health/ready`, assert `/openapi.json` HTTP 200 and non-empty `paths` | PASS locally: 71 paths |
| Docker builds | `docker build -f backend/Dockerfile backend` and frontend equivalent with build args | PASS locally, both images built |
| Contract | `cargo test`, explicit-allow Clippy, wasm32v1-none build | PASS locally |

Actions remain on mutable version tags; full SHA pinning is a documented residual item.

## Database and restore verification

- Fresh `alembic upgrade head` head at the reconciliation closure: `0006_reconciliation`
  (an uncommitted `0007_member_invites` appeared during this cycle; check `alembic heads`).
- Executed backup/restore drill with Docker Compose: dump from scratch DB → restore into a
  different scratch DB → row counts and sentinel row matched → scratch DBs dropped. Exact
  commands and outputs are in `DEPLOYMENT.md`. The live database was not modified.

## Real Testnet transactions

```bash
python docs/scripts/testnet_smoke.py          # needs TESTNET_SECRET
python docs/scripts/payment_e2e.py            # needs running backend + TESTNET_SECRET
python docs/scripts/api_smoke.py              # API/RBAC/tenant smoke, no secrets needed
```

Executed during the earlier build cycle:

- Real XLM payment submitted and independently verified from Horizon:
  `68ee9d8b2ac98f53c2a030a49043948cafb8d2a58cb7a73f391c6a77da83cbbc`.
- Soroban contract `init`, `fund`, `approve_milestone` and `release_milestone` executed
  on Testnet; final on-chain readback
  `{"funded":"20000000","released":"10000000","remaining":"10000000"}` (stroops =
  2 XLM funded / 1 XLM released / 1 XLM remaining). See `TESTNET_DEPLOYMENT.md` for hashes.
- Negative on-chain checks: duplicate release → `Error(Contract, #8)`; refund after
  release → `Error(Contract, #6)`.

No hash or successful status in this repository is fabricated. Failed/unconfirmed
transactions must remain non-settling in application code.

## Not executed in this cycle

| Item | Reason |
|---|---|
| GitHub Actions workflow runs | Workflows are prepared locally but not committed (active token lacks `workflow` scope). |
| Live Testnet transaction created in this cycle | No funded `TESTNET_SECRET`; historical hashes were verified read-only. |
| Wallet-signing browser E2E | Needs a real Freighter session, unavailable here. |
| Stellar CLI `stellar contract build` re-run | Stellar CLI 30+ is not installed; the local `stellar` binary is an unrelated package. |
