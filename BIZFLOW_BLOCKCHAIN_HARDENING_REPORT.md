# BIZFLOW — Blockchain Hardening Report

Branch: `blockchain-security-deployment-hardening`. All statements below were verified against source; prior reports were not trusted as evidence.

## Verification results (this branch)

- Backend pytest: **262 passed, 0 failed**
- Frontend Vitest: **262 passed, 0 failed**
- Soroban `cargo test`: **47 passed, 0 failed**
- Raw logs: `/home/robi/tmp/opencode/bizflow-baseline/`

## Finding 1 — Shared escrow instance, client-supplied on-chain id

- **Severity:** HIGH
- **Root cause:** One global `STELLAR_ESCROW_CONTRACT_ID` is used for every agreement; the backend never deploys or calls `init`. The numeric contract agreement id was client-supplied at fund-prepare time and stored without a uniqueness/ownership invariant. `contracts/escrow/src/lib.rs:98-126` shows the contract itself holds exactly one agreement, so multiple funded agreements on one instance contradict chain state.
- **Files affected:** `backend/app/config.py`, `backend/app/schemas.py`, `backend/app/routers/agreements_chain.py`, `backend/app/models.py`, `backend/alembic/versions/0006_reconciliation.py`.
- **Changes made:** `onchain_agreement_id` must now be a positive integer and is rejected if already bound to another agreement (`ONCHAIN_ID_IN_USE`); a database partial unique index `uq_agreement_funded_contract` prevents a second *funded* agreement binding the same contract (draft agreements may share the configured contract); the runtime TOCTOU check is retained for escrow funding; the legacy Horizon fund path no longer overwrites a binding with an unrelated contract.
- **Tests performed:** `test_duplicate_hash_cannot_be_reused_for_escrow_funding`, `test_cancel_funded_agreement_is_blocked`, plus the full backend suite.
- **Actual test results:** backend pytest 262 passed / 0 failed; frontend Vitest 262 passed / 0 failed; Soroban cargo test 47 passed / 0 failed (final run). Raw logs: `/home/robi/tmp/opencode/bizflow-baseline/`.
- **Verification evidence:** unique-index creation verified by `alembic upgrade head → downgrade base → upgrade head`; binding rejection exercised through API responses.
- **Status:** **PARTIALLY IMPLEMENTED**. Per-agreement contract deployment/init cannot be performed from this environment because it requires live Testnet deployment authority; the contract instance remains shared. This is the single largest residual blockchain risk.

## Finding 2 — No independent contract-state verification after settlement

- **Severity:** HIGH
- **Root cause:** Funding/approval/release/refund relied on a successful transaction plus a matching event; authoritative `get_balance` / `get_milestone` state was only read by the on-demand reconciliation endpoint.
- **Files affected:** `backend/app/services/reconciliation.py`, `backend/app/routers/agreements_chain.py`, `backend/app/config.py`, `backend/tests/conftest.py`, `backend/tests/test_hardening.py`.
- **Changes made:** Added `read_contract_milestone()` and `verify_escrow_state()`. Every settled escrow operation now compares authoritative contract balances (and, for approval/release, the milestone's `approved`/`released` flags) against a value computed from trusted database state *before* any financial record is written. Failed RPC, missing state, or mismatches produce `ESCROW_STATE_READ_FAILED` / `ESCROW_STATE_MISMATCH`, mark the prepared record `failed`, and refuse settlement. Controlled by `ENFORCE_ESCROW_STATE_VERIFICATION` (default `true`; disabled in legacy unit suites that stub only the event boundary).
- **Tests performed:** `test_escrow_state_mismatch_blocks_settlement` (mismatched chain read → 409, agreement remains unfunded) and `test_release_event_verification_requires_exact_amount`.
- **Actual test results:** backend pytest 262 passed / 0 failed; frontend Vitest 262 passed / 0 failed; Soroban cargo test 47 passed / 0 failed (final run). Raw logs: `/home/robi/tmp/opencode/bizflow-baseline/`.
- **Verification evidence:** the dedicated mismatch test asserts `fund_transaction_hash` is still `None` after a rejected funding.
- **Status:** **IMPLEMENTED BUT NOT VERIFIED** against a live Testnet contract; verified with a mocked RPC getter. Live-state verification requires network/deployment access.

## Finding 3 — Transaction verification and replay protection

- **Severity:** HIGH → mitigated
- **Root cause:** Duplicate-hash checks were only present in the legacy fund path and `/transactions/verify`; release-event verification did not check the released amount; signed XDR was validated only for contract id and function name; transaction hash path parameters were unvalidated strings.
- **Files affected:** `backend/app/services/verification.py`, `backend/app/services/stellar.py`, `backend/app/routers/agreements_chain.py`, `backend/app/routers/transactions.py`, `backend/app/schemas.py`.
- **Changes made:** `_assert_no_duplicate_hash()` is called in all four escrow submit endpoints; `verify_soroban_release` now requires the exact milestone amount; `invoked_contract_parameters()` decodes every invocation argument and `submit_soroban` compares them to the server-prepared values (`PARAMETER_MISMATCH`); `signed_xdr` is length-bounded; transaction-hash path parameters require 64 lowercase/uppercase hex characters; all money arithmetic remains `Decimal`/`i128` stroops.
- **Tests performed:** full backend suite plus `test_malformed_transaction_hash_is_rejected`, `test_duplicate_hash_cannot_be_reused_for_escrow_funding`, `test_release_event_verification_requires_exact_amount`.
- **Status:** **VERIFIED COMPLETE** for the implemented checks (unit-level). Network identity is still asserted from the testnet-only configuration rather than derived from the transaction itself.

## Finding 4 — Milestone settlement and cancellation

- **Severity:** HIGH
- **Root cause:** `verify_soroban_release` accepted any `released` event for the right index; off-chain cancellation of a funded agreement could strand escrowed funds.
- **Files affected:** `backend/app/routers/agreements.py`, `backend/app/routers/agreements_chain.py`.
- **Changes made:** amount-bound release verification; state verification before release records are written; `cancel` now refuses funded, non-refunded agreements with `ESCROW_FUNDS_OUTSTANDING`, directing the caller to the verified refund flow. Existing role gates and duplicate-release checks were confirmed intact.
- **Tests performed:** `test_cancel_funded_agreement_is_blocked`, existing milestone approve/release/refund suites.
- **Status:** **VERIFIED COMPLETE**.

## Finding 5 — Reconciliation was not auditable

- **Severity:** MEDIUM
- **Root cause:** `ReconciliationReport` was a frozen in-memory dataclass; only an audit-log line was persisted, with no expected/observed pair, resolution state or timestamped record.
- **Files affected:** `backend/app/models.py`, `backend/alembic/versions/0006_reconciliation.py`, `backend/app/services/reconciliation.py`, `backend/app/routers/reconciliation.py`.
- **Changes made:** new `reconciliation_records` table storing agreement id, transaction hash, contract id, expected state, observed state, discrepancy list, detection timestamp and resolution status; `persist_report()` appends a record on every reconciliation run and never modifies financial rows; the endpoint returns the record id.
- **Tests performed:** `test_reconciliation_creates_auditable_record`, existing reconciliation suites; migration upgrade/downgrade/upgrade.
- **Status:** **VERIFIED COMPLETE** (fresh SQLite). No automated resolution workflow is implemented by design: discrepancies require a human decision.

## Remaining limitations

1. One shared Soroban contract instance: per-agreement state isolation is enforced by backend checks and a partial DB index, not by distinct on-chain contracts. Full isolation requires deploying and `init`-ing one contract per agreement on Testnet (**NOT IMPLEMENTED — BLOCKED BY EXTERNAL DEPENDENCY**).
2. Contract-state verification and event verification were exercised only against mocked RPC/events; no live Testnet settlement was performed in this environment.
3. `cancel` has no on-chain action (refund must be invoked explicitly). This is now enforced, not silently allowed.
