# Database Design

PostgreSQL is the system of record. Alembic manages schema migrations. The documented
head at the reconciliation closure is `0006_reconciliation` (created
`reconciliation_records`); always confirm with `cd backend && .venv/bin/alembic heads`
before deploying, since later migrations may exist in working copies. For local
unit tests, `USE_SQLITE=true` selects a real SQLite database (never browser storage),
so tests do not require a running Postgres server.

All money columns are `NUMERIC(20,7)` and serialized as strings. All tables have
`created_at`/`updated_at` timestamps. Foreign keys enforce referential integrity and
unique constraints prevent duplicate settlement.

## Tables

| Table | Purpose | Key constraints |
|---|---|---|
| `users` | Identity and password hash | unique `email`; `password_hash` never returned by API |
| `businesses` | Tenant root | UUID `id`; name and legal_name fields; no separate internal identifier |
| `business_members` | Membership + role | unique (`business_id`,`user_id`); role in owner/admin/finance_manager/supplier |
| `suppliers` | Supplier profiles | FK business; `wallet_address` validated as Stellar G-address; unique (`business_id`,`wallet_address`) where provided |
| `invoices` | Payment requests | FK business + supplier; unique `invoice_number` per business; unique (`business_id`,`reference`) when reference set; amount NUMERIC; status derived |
| `invoice_items` | Line items | FK invoice; quantity + unit_price NUMERIC |
| `payment_agreements` | Agreements | FK business + supplier; unique `agreement_reference`; status state machine; `escrow_contract_id` stored when funded |
| `agreement_milestones` | Milestones | FK agreement; unique (`agreement_id`,`index`); amount NUMERIC; `released_at`, `approved_at` |
| `payment_records` | Payment attempts/settlements | FK business, optional invoice/agreement/milestone; unique `transaction_hash`; amount NUMERIC; status pending/submitted/confirmed/failed |
| `blockchain_transactions` | Verified chain facts | unique `hash`; network, source, destination, asset, amount, memo, confirmed_at, successful flag, raw result summary |
| `wallet_connections` | Connected public addresses | FK user/business; `public_key`, `network='testnet'`, never stores secrets |
| `notifications` | In-app notifications | FK business + user; type, title, body, read_at |
| `audit_logs` | Immutable activity trail | actor, action, target_type/id, business_id, metadata JSON, created_at; no update/delete API |
| `supplier_invitations` | Supplier invitation lifecycle | token unique; status pending/accepted/rejected/expired/revoked; expires_at; business-bound |
| `invoice_attachments` | Invoice files | FK invoice + business; 5 MB validation; no secret-file content |
| `milestone_evidence` | Deliverable evidence | FK milestone; supplier submission; review status; audited |
| `reconciliation_records` | On-chain vs database comparison results | FK business + agreement; expected/observed/discrepancy JSON; resolution status; audit-only, never auto-corrects financial state |

Payment status values are `prepared`, `verifying`, `confirmed`, `failed` (not `pending`/`submitted`). Agreement milestones carry `sort_order`, `release_transaction_hash` and `released_at`; there is no separate `approved_at` column. Notifications use `is_read`, not `read_at`.

## Status derivation

Invoice status is **computed** from payment records whose linked blockchain
transaction is `successful=true` and `confirmed_at` is set:

- no confirmed payment + `draft` → `draft`
- no confirmed payment + submitted → `pending`
- confirmed payments sum < amount → `partially_paid`
- confirmed payments sum >= amount → `paid`
- past due date and unpaid → `overdue`
- explicitly cancelled with no confirmed payment → `cancelled`

Agreement status follows an explicit state machine:
`draft → awaiting_acceptance → active → completed`, with `cancelled`/`disputed`
transitions guarded by authorization and the absence of released funds where required.

## Duplicate / replay protection

- `payment_records.transaction_hash` is unique.
- A milestone can be released once (`released_at` guard + unique payment link).
- Verification rejects a transaction hash already linked to another payment.
- `prepare` refuses a second pending payment for the same invoice amount.

See `API_CONTRACT.md` for endpoint semantics and `ARCHITECTURE.md` for flows.
