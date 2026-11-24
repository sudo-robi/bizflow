# Testing

All commands below were executed in this repository. Results are reported as observed;
no test result is claimed without running it.

## Backend (pytest)

```bash
cd backend
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
USE_SQLITE=true .venv/bin/pytest -q
```

Uses a real SQLite database (`USE_SQLITE=true`) so no external service is required.
Covers authentication, RBAC, tenant isolation, supplier CRUD, invoice validation and
status derivation, duplicate-payment prevention, agreement state transitions,
verification service behaviour, receipts and audit logging. External Horizon calls are
mocked **only in unit tests**; application code always calls the real network.

**Executed result:** see final report section of `README.md` / completion report.

## Frontend (Vitest + Next build)

```bash
cd frontend
npm install
npm test -- --run
npm run build
npx tsc --noEmit
```

**Executed result (this build):**
- `npm test -- --run` — 2 test files, **25/25 tests passed** (`validators.ts`, `format.ts`).
- `npm run build` — **success**, 22 routes generated.
- `npx tsc --noEmit` — clean.
- Browser smoke check via Playwright: landing and auth pages rendered, responsive layouts
  inspected, no application console errors (favicon 404 resolved with `app/icon.svg`).

## Smart contract (cargo test)

```bash
cd contracts/escrow
cargo fmt --check
cargo test
stellar contract build
```

**Executed result (final verification, 2026-11-25):**
- `cargo test` — **47 passed; 0 failed**; `cargo llvm-cov` lib.rs lines **98.28%**.

**Backend:** `USE_SQLITE=true .venv/bin/python -m pytest -o addopts='' -q` — **250 passed, 1 warning**; `--cov=app` — **95%** (3208 statements, 174 missed at last full run).

**Frontend:** `npx vitest run` — **260 passed in 19 files**; `npm run typecheck` and `npm run build` PASS; line coverage **86.68%**.

**Migrations:** fresh SQLite `alembic upgrade head` → `0005_feature_completeness`; tables `supplier_invitations`, `invoice_attachments`, `milestone_evidence` present.

**Browser E2E:** Playwright MCP registration → dashboard PASS against the live local stack.

Exact evidence: `BIZFLOW_FINAL_TEST_RESULTS.md`, `BIZFLOW_SECOND_PASS_TEST_RESULTS.md`.
- `stellar contract build` — success; optimized WASM 11,987 bytes, hash
  `65db0f966e0f18ac59272ce6f664b66a62c1780b74b612f1e69f02081743a7cd`.
- `cargo build --target wasm32-unknown-unknown --release` intentionally fails by SDK
  design; use `wasm32v1-none` (documented in `SMART_CONTRACTS.md`).

## Real Testnet transactions

```bash
python docs/scripts/testnet_smoke.py          # needs TESTNET_SECRET
python docs/scripts/payment_e2e.py            # needs running backend + TESTNET_SECRET
python docs/scripts/api_smoke.py              # API/RBAC/tenant smoke, no secrets needed
```

Executed during this build:

- Real XLM payment submitted and independently verified from Horizon:
  `68ee9d8b2ac98f53c2a030a49043948cafb8d2a58cb7a73f391c6a77da83cbbc`.
- Soroban contract `init`, `fund`, `approve_milestone` and `release_milestone` executed
  on Testnet; final on-chain readback
  `{"funded":"20000000","released":"10000000","remaining":"10000000"}`.
  See `TESTNET_DEPLOYMENT.md` for every hash.
- Negative on-chain checks: duplicate release → `Error(Contract, #8)`; refund after
  release → `Error(Contract, #6)`.

No hash or successful status in this repository is fabricated. Failed/unconfirmed
transactions must remain non-settling in application code.
