# BizFlow — Final Security Report

Date: 2026-11-25. Scope: backend, frontend, Soroban contract, deployment configuration. This report does **not** claim the application is completely secure or production-ready.

## Repaired findings (with evidence)

| ID | Severity | Root cause | Remediation | Test evidence |
|---|---|---|---|---|
| F-01 | CRITICAL | `fund` matched only amount/asset; any Horizon payment could mark an agreement funded | Requires active agreement, on-chain id, and server-bound amount, asset, issuer, destination contract and memo; replay rejected | `tests/test_agreements.py`, `test_coverage_agreements_fund.py` |
| F-02 | CRITICAL | Soroban events from the single configured contract were shown for every agreement | Events filtered by on-chain agreement id present in event topics | `test_coverage_agreements_chain.py` |
| F-08 | CRITICAL | Client-supplied `escrow_contract_id` could replace the real contract | `_escrow_context` accepts a client id only when it matches the server-resolved contract | `tests/test_agreements.py` |
| XDR-1 | CRITICAL | Decoder used wrong SDK accessors (`_transaction`, `operation.body`), so every real signed invocation was rejected | Decodes contract/function from `envelope.transaction` and `operation.host_function`; verified against a real built XDR → `(contract_id, 'get_balance')` | manual SDK verification + `test_coverage_stellar.py` |
| F-03 | HIGH | Approve/release submit skipped state, kind, expiry and contract checks | Re-validated before submission; failed/expired prepared records marked failed | `test_coverage_agreements_state.py`, `test_coverage_refunds.py` |
| F-09 | HIGH | Default JWT secret, insecure cookie, default DB credentials | Production requires ≥32-char `JWT_SECRET`, real `DATABASE_URL`, and forces secure cookie | `tests/test_coverage_units.py`, manual config check |
| F-10 | HIGH | Agreement completed while milestones were only approved | Completion requires every milestone `released` | `tests/test_agreements.py` |
| F-07 | HIGH | Fresh migration failed on duplicate `updated_at` | Idempotent `0003` migration; fresh upgrade and downgrade/upgrade verified | executed Alembic commands |
| F-06 | MEDIUM | Invoice creation produced audit entry but no notification | Event notifications added across invoice/agreement/payment flows | `tests/test_feature_completeness.py`, `test_misc.py` |
| TX-1 | HIGH | `/transactions/verify` allowed any member and globally blocked hashes | Restricted role; duplicate-hash check scoped to caller's business; provider exceptions logged, generic error returned | `tests/test_coverage_transactions.py` |
| UP-1 | MEDIUM | Attachment upload could store secret files | Type/size validation and key-content rejection; business-bound records | `tests/test_feature_completeness.py` |

## Remaining risks / limitations

| Risk | Severity | Status |
|---|---|---|
| One configured escrow contract shared across agreements while the contract holds one agreement | HIGH | **PARTIALLY IMPLEMENTED**: per-agreement `escrow_contract_id` is persisted and enforced; deploying one instance per agreement requires funded Testnet keys/deployment tooling not present here. Every agreement is bound to its own id/config at prepare time and cannot substitute a client contract. |
| On-chain state readback is implemented for Soroban (fund/approve/release/refund) but ordinary Horizon payments rely on independent transaction/operation verification, not a balance readback | MEDIUM | **PARTIALLY VERIFIED** — reconciliation service reads `get_balance` via simulation and reports discrepancies without auto-repair. |
| `authorized` party can both approve and release on-chain; separation of duties is enforced only in backend roles | MEDIUM | Documented; mitigated by backend `finance_manager` gating and event verification. |
| CSRF on cookie-auth writes | MEDIUM | **VERIFIED IMPLEMENTED** — double-submit `bizflow_csrf` cookie / `X-CSRF-Token` header with origin checks; public auth endpoints are explicitly exempt. Tests: `tests/test_hardening.py::test_csrf_blocks_cookie_authenticated_mutation`, `::test_csrf_rejects_foreign_origin_with_and_without_token`. |
| Correlation IDs on logs | LOW | **VERIFIED IMPLEMENTED** — request id generated or accepted from `X-Request-ID`, written to each request log line and echoed on responses (`tests/test_hardening.py::test_security_headers_and_correlation_id`). |
| Live public deployment and GHCR packages | N/A | **BLOCKED BY EXTERNAL DEPENDENCY** (no host credentials; token lacks `workflow` scope). |
| Official optimized WASM artifact absent locally | LOW | `cargo build --target wasm32v1-none --release` succeeds with the SDK's `STELLAR_CLI_VERSION` guard satisfied; the Stellar CLI v30+ needed for `stellar contract build` is not installed, so the historical optimized hash/size could not be re-derived. On-chain deployment was verified via RPC. |

No private keys, seed phrases, fake hashes or simulated confirmations were introduced. No application behavior was changed to make tests pass; assertions were preserved or strengthened.
