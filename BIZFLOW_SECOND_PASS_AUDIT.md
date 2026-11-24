# BizFlow — Second-Pass Gap Analysis (resolved)

Date: 2026-11-25. Detailed evidence: `BIZFLOW_FINAL_ENGINEERING_REPORT.md`, `BIZFLOW_FINAL_TEST_RESULTS.md`.

| Task | Finding from second pass | Actual state / action | Status |
|---|---|---|---|
| Multi-agreement escrow | One configured contract; possible cross-agreement ambiguity | Per-agreement `escrow_contract_id` persisted and enforced; client substitution rejected; event filtering by on-chain id; one-instance-per-agreement deployment needs funded keys | PARTIALLY VERIFIED |
| Independent reconciliation | Missing on-chain state readback | Added `services/reconciliation.py` + `POST /agreements/{id}/reconcile`; real `get_balance` readback executed | VERIFIED |
| Supplier onboarding | Invitation lifecycle missing | Invitation, acceptance, expiry, status, wallet validation, authorization implemented in `0005` migration and routers | VERIFIED |
| Invoice workflows | Edit/approve/reject/attachments/partial payments incomplete | Implemented and tested; derived status uses confirmed payments only | VERIFIED |
| Agreement/milestone workflows | Evidence, refund, expiry gaps | Evidence model, real refund flow, state guards, expiry checks added | VERIFIED |
| Financial reporting | Supplier breakdown/aging/CSV/PDF | DB-derived reports and exports implemented and tested | VERIFIED |
| Notifications/receipts | Missing event notifications | Event notifications and PDF receipts from verified transactions only | VERIFIED |
| Frontend/E2E | No-op buttons, wrong fields, low coverage | All audited fixes applied; 260 tests; real browser E2E executed | VERIFIED (wallet E2E unavailable) |
| Deployment/CI | Backend Dockerfile missing, no CI | Dockerfile added; workflows prepared locally; CI/release blocked by token scope | PARTIALLY IMPLEMENTED / BLOCKED |
| Docs | Conflicting statuses | Final reports and checklist reconciled | VERIFIED |

All findings include severity, root cause, remediation and test evidence in `BIZFLOW_FINAL_SECURITY_REPORT.md`.
