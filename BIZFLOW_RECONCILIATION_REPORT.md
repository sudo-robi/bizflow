# BizFlow — On-Chain Reconciliation Report

Date: 2026-11-25.

## Implementation

- `backend/app/services/reconciliation.py` — reads authoritative Soroban contract state by simulating a real `get_balance` invocation (no signing, no state change), decodes the returned SCVal, compares funded/released/remaining against database records and persisted milestone state, checks duplicate funding hashes and on-chain agreement id presence, and returns a structured report. It **never** writes financial records.
- `backend/app/routers/reconciliation.py` — `POST /api/v1/agreements/{id}/reconcile`, restricted to owner/admin/finance_manager, writes only an audit entry (`agreement.reconciled`).
- `backend/tests/test_reconciliation.py` — 4 tests: RPC result decoding, mismatch detection without DB writes, consistent state, authenticated endpoint + audit record.

Discrepancy codes: `NO_CONTRACT_BOUND_TO_AGREEMENT`, `NO_FUNDING_SOURCE_ACCOUNT`, `ONCHAIN_READ_FAILED`, `MISMATCH_FUNDED`, `MISMATCH_RELEASED`, `MISMATCH_REMAINING`, `DUPLICATE_FUNDING_TRANSACTION`, `NO_ONCHAIN_AGREEMENT_ID`.

## Real on-chain verification executed this cycle

Command: Soroban RPC `simulate_transaction` on a transaction invoking `get_balance` for contract
`CBEIRUNYWZ54JOSYJD6VGJUTPAZHPMEOJIAYECWCXZVMT7FOBBO57HGK`, source account
`GAZUFXW3M7WM6ZKO5BRWZS47S3WIJEUZZDJ7VK4UAETVQRRMD3JJ2MVB`, network
`Test SDF Network ; September 2015`.

Result (latest ledger **5907394**):

```json
{"funded": 20000000, "released": 10000000, "remaining": 10000000}
```

Interpretation: 20 XLM funded, 10 XLM released, 10 XLM remaining in stroops — consistent with the
`funded`/`released` events and the historical readback recorded in `docs/TESTNET_DEPLOYMENT.md`.
This value came from the contract itself, not from the application database.

Corroborating read-only evidence:
- Horizon transaction `68ee9d8b2ac98f53c2a030a49043948cafb8d2a58cb7a73f391c6a77da83cbbc` → `successful=true`, ledger 5901307.
- Soroban `getTransaction` for `187db0721a9cacd164dc9ff4f16ac4b88f105c1e64ca9b047a30c8c9e1b60966` → `status=SUCCESS`.
- Soroban `getEvents` returned `init`, `funded`, `approved`, `released` for that contract.

## Limits

- The endpoint reports discrepancies; it does not auto-correct them. Remediation requires an operator with a funded account and an audited process.
- A full per-agreement comparison of Horizon payment records for ordinary (non-escrow) payments still relies on independent transaction/operation verification (`services/verification.py`), not a on-chain balance readback.
- Tests mock RPC responses; the real RPC read above was executed manually and is not a CI test (CI must not depend on public Testnet availability).
