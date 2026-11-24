# BizFlow Engineering Audit

Date: 2026-11-24. Scope: the repository as delivered after initial development, before
the corrections in this audit cycle. Evidence: source inspection, executed pytest/cargo
suites, a live FastAPI + Next.js stack, and real Stellar Testnet transactions.

## Classification legend

- **Fully Functional** — execution path verified end to end with test evidence.
- **Functional with Limitations** — works, with documented constraints.
- **Partially Functional** — some paths work, important ones do not.
- **UI Only** — page renders but no working backend path.
- **Mocked** — result simulated / not from authoritative source.
- **Broken** — code exists but fails in normal use.
- **Missing** — required capability absent.
- **Blocked by External Dependency** — requires infrastructure/credentials not present.

---

## 1. Authentication & session management

| Item | Status | Evidence |
|---|---|---|
| Registration, login, bcrypt hashing, duplicate email | Fully Functional (unit) | `backend/app/routers/auth.py`, `security.py`; pytest auth suite passes |
| Logout | **Partially Functional** | `logout()` returns `{ok:true}` but does not revoke the JWT (`auth.py:70`). Token remains valid until expiry. |
| Session cookie | **Broken** | Backend returns JWT only in JSON (`TokenResponse`). Frontend `api.ts` sends `credentials:'include'` and **never** attaches `Authorization: Bearer`. Every authenticated browser request receives 401. |
| Session expiry | Functional with Limitations | JWT `exp` enforced by `decode_access_token`; no server-side revocation/jti. |
| RBAC | Fully Functional (unit) | `require_roles`, `get_business_membership`; pytest RBAC suite passes |
| Cross-business isolation | Fully Functional (unit) | every router queries by `membership.business_id`; pytest tenant suite passes |

**Correction required:** set an httpOnly `bizflow_session` cookie on register/login, accept it in `get_current_user` alongside Bearer, add a revoked-token table checked on every request, clear cookie on logout.

## 2. Business & team management

| Item | Status | Evidence |
|---|---|---|
| Create/read/update business, members, roles | Fully Functional (unit) | `routers/businesses.py`, pytest business suite |
| Unique internal identifier | Functional with Limitations | `Business.id` UUID; no separately exposed `internal_identifier`. |
| Data isolation | Fully Functional (unit) | `membership_for` + `require_business` on every endpoint |

## 3. Suppliers

| Item | Status | Evidence |
|---|---|---|
| CRUD, archive, search, filter, history | Fully Functional (unit) | `routers/suppliers.py`; pytest supplier suite |
| Stellar address validation | Fully Functional | `schemas._stellar_key` uses `Keypair.from_public_key`; duplicate-wallet conflict handled |
| Supplier→invoice relationship | Fully Functional | FK + supplier invoices/payments endpoints |

## 4. Invoices

| Item | Status | Evidence |
|---|---|---|
| Creation, validation, PDF, derived status, cancellation | Fully Functional (unit) | `routers/invoices.py`, `services/invoices.py`, `services/receipts.py` |
| Status from verified records | Fully Functional | `derived_status()` sums only `PaymentRecord.status == 'confirmed'` |
| Duplicate full-amount payment prevention | Fully Functional | DB unique partial index `(invoice_id, amount, kind)` where status != failed |
| **Partial payment** | **Missing** | `PaymentPrepareIn` has no `amount`; `prepare_payment` always uses `invoice.amount`. Workflow 2 cannot be executed. |
| Overpayment handling | Partially Functional | `derived_status` marks paid when `paid >= total`; no explicit overpayment flag/report. |
| `next_reference` concurrency | Functional with Limitations | count-then-insert; protected by unique constraint but may raise on concurrent creates. |

## 5. Payment agreements

| Item | Status | Evidence |
|---|---|---|
| Create (with milestone-sum validation), update, submit, accept, cancel, dispute | Fully Functional (unit) | `AgreementCreate.check_totals`, `routers/agreements.py`, pytest agreement suite |
| Unilateral modification of accepted agreements | Fully Functional | `update_agreement` refuses non-draft |
| Rejection endpoint | **Missing** | There is no `reject` transition (only submit/accept/cancel/dispute). |
| Expiry enforcement | **Missing** | `expiry_date` stored/displayed but never enforced in state transitions. |
| On-chain approve milestone | **Missing** | Contract requires `approve_milestone` before `release_milestone`; backend has no such endpoint, so the release flow fails on-chain. |
| Funding verification strength | **Partially Functional / Weak** | `fund_agreement` verifies **only amount**, not source, destination, asset or memo, and treats any Horizon payment as escrow funding. A matching-amount unrelated transaction can mark an agreement funded. |
| One contract per agreement | Functional with Limitations | Contract holds one agreement; backend uses one configured contract ID for all agreements. Documented. |

## 6. Dashboard & reports

| Item | Status | Evidence |
|---|---|---|
| Metrics, charts, CSV | Fully Functional (unit) | `routers/reports.py` uses only DB aggregates; no static financial figures in authenticated paths |
| Landing illustration | Functional with Limitations | Static example values on `/` were unlabelled; now explicitly labelled illustrative. |
| Reconciliation / invoice aging / supplier breakdown | **Missing** | Not implemented. |

## 7. Stellar integration

| Item | Status | Evidence |
|---|---|---|
| Horizon connectivity, account load, payment build/sign/submit/poll/verify | Fully Functional (live) | `services/stellar.py`; real testnet tx `68ee9d8b…` built/submitted/verified by `docs/scripts/testnet_smoke.py` |
| Asset/public key validation | Fully Functional | `_asset`, `Keypair.from_public_key` |
| Failed/pending handling | Fully Functional | `submit_transaction` distinguishes rejected/failed/pending and never settles them |
| Soroban build/simulate/submit/poll/event verification | Functional with Limitations | `build_soroban_release_xdr`, `submit_soroban`, `verify_soroban_release`; requires a fresh per-agreement contract and an approval step (see above) |
| `validate_contract_id()` / `schemas._contract_id` | **Broken (unused)** | calls `Keypair.from_public_key` on `C...` addresses; raises `Ed25519PublicKeyInvalidError`. Use `scval`/strkey contract decoding instead. |

## 8. Transaction verification

| Item | Status | Evidence |
|---|---|---|
| Independent Horizon verification of hash/success/source/dest/asset/amount/memo | Fully Functional (unit + live) | `services/verification.py`; live smoke script |
| Duplicate-hash idempotency | Fully Functional | unique constraints + `hash_already_used` + IntegrityError handling |
| Soroban event verification | Functional with Limitations | `verify_soroban_release` matches `released` topic + agreement id + milestone index |
| Replay / expired prepared tx | Fully Functional | `expires_at` check + hash match of signed XDR |

## 9. Smart contract

| Item | Status | Evidence |
|---|---|---|
| Escrow state machine, auth, funding, approval, release, refund, events | Fully Functional | `contracts/escrow/src/lib.rs`; 24 `cargo test` cases passed |
| Deployed to Testnet | Fully Functional | contract `CBEIRUNYWZ54JOS…`; live init/fund/approve/release hashes in `docs/TESTNET_DEPLOYMENT.md` |
| Overflow protection | Fully Functional | checked arithmetic + `overflow-checks = true` |
| Security review of remaining risks | **Missing** | required `SMART_CONTRACT_REVIEW.md` |

## 10. Notifications, receipts, audit

| Item | Status | Evidence |
|---|---|---|
| In-app notifications for payment/milestone | Functional with Limitations | `notify_business` called on confirmations; invoice-created/agreement-accepted/payment-failure notifications not all emitted |
| PDF receipt fields | Partially Functional | `build_receipt_pdf` includes all required fields **except Stellar explorer link** |
| Audit trail immutability | Fully Functional | read-only router; no update/delete endpoints |

## 11. Frontend

| Item | Status | Evidence |
|---|---|---|
| 21 pages + public verify page, forms, role awareness | Functional with Limitations | build succeeds; browser rendering verified; **auth broken** (see §1) |
| Freighter detection/connect/network check/sign/reject handling | Functional with Limitations | `lib/stellar.ts` implements real API calls; live Freighter session unavailable in this environment |
| Vitest coverage | Partially Functional | 25 tests only for validators/format; no component/form/state tests |
| Playwright E2E | Missing | no committed Playwright test suite |

## 12. Infrastructure / CI

| Item | Status | Evidence |
|---|---|---|
| Docker Compose, env config, health endpoint | Functional with Limitations | compose file + `/health`; backend Dockerfile not committed |
| CI pipeline | **Missing** | no `.github/workflows` |
| Structured logging | Functional with Limitations | stdlib logging; no request correlation ids |

---

## Prioritized corrections in this cycle

1. Cookie-based session auth + token revocation (P0, blocks all browser use).
2. Partial payments + stronger duplicate/overpayment handling (P0).
3. On-chain milestone approval and verified Soroban funding path (P0).
4. Strengthen agreement funding verification (source/destination/asset/memo).
5. Receipt explorer link, missing notifications, remove dead/broken validators.
6. Backend Dockerfile, CI workflow, additional tests, E2E scripts.
7. Documentation set matching actual implementation.

Features classified above will be re-evaluated at the end of the cycle in the final report.
