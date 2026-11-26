# BizFlow API Contract (v1)

All business-scoped endpoints require headers:
- `Authorization: Bearer <jwt>` (JWT from `/auth/login` or `/auth/register`)
- `X-Business-ID: <uuid>` (the active business; backend verifies membership)

Base URL: `/api/v1`. All request/response bodies are JSON. Monetary amounts are strings
(e.g. `"1250.50"`) to preserve decimal precision. Dates are ISO-8601 strings.

Cookie-authenticated state-changing requests must also send the double-submit CSRF
header `X-CSRF-Token` with the value of the readable `bizflow_csrf` cookie issued at
login/register. Missing, invalid or cross-origin tokens return `403` with code
`CSRF_TOKEN_MISSING`, `CSRF_TOKEN_INVALID` or `CSRF_ORIGIN_DENIED`. Bearer-authenticated
API calls are unaffected. Every response echoes the correlation id as `X-Request-ID`
(the same id is written to request logs). Unauthenticated probes: `GET /health`,
`GET /health/ready` (real database check) and `GET /openapi.json`.

## Error envelope
```json
{ "detail": "Human readable message", "code": "MACHINE_CODE" }
```
Validation errors use FastAPI's standard `detail` array. HTTP statuses: 400 invalid,
401 unauthenticated, 403 forbidden/role, 404 missing, 409 conflict, 422 validation,
429 rate limited, 500 unexpected.

## Auth & businesses
| Method | Path | Roles | Body / Notes | Returns |
|---|---|---|---|---|
| POST | `/auth/register` | public | `{email,password,full_name,business_name?}` | `{user, business?, token, token_type}` |
| POST | `/auth/login` | public | `{email,password}` | `{user, token, token_type}` |
| POST | `/auth/logout` | auth | - | `{ok:true}` |
| GET | `/auth/me` | auth | - | `{user, memberships:[{business,role}]}` |
| GET | `/businesses` | auth | - | `[{id,name,role,...}]` |
| POST | `/businesses` | auth | `{name,legal_name?,country?,currency?}` | business |
| GET | `/businesses/{id}` | member | - | business |
| PATCH | `/businesses/{id}` | owner/admin | partial | business |
| GET | `/businesses/{id}/members` | member | - | `[{user,role,status}]` |
| POST | `/businesses/{id}/members` | owner/admin | `{email,role}` | membership (creates pending invite if user unknown) |
| PATCH | `/businesses/{id}/members/{user_id}` | owner/admin | `{role}` | membership |
| DELETE | `/businesses/{id}/members/{user_id}` | owner/admin | - | `{ok:true}` |

Roles: `owner`, `admin`, `finance_manager`, `supplier`. Permissions:
- owner/admin: everything
- finance_manager: suppliers read, invoices create/read/edit/cancel/submit, agreements read, payments prepare/submit/approve, reports, transactions, notifications
- supplier: agreements read + accept, invoices read (only linked to their supplier profile), payments read (linked), receipts, notifications

## Suppliers
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/suppliers?search=&status=&page=1&per_page=20` | owner/admin/finance | paginated `{items,total,page,per_page}` |
| POST | `/suppliers` | owner/admin/finance | `{business_name,contact_name?,email?,phone?,wallet_address,country?,notes?}` — wallet_address must be a valid Stellar public key (G...) |
| GET | `/suppliers/{id}` | member | detail |
| PATCH | `/suppliers/{id}` | owner/admin/finance | partial |
| POST | `/suppliers/{id}/archive` | owner/admin | sets status archived |
| GET | `/suppliers/{id}/invoices` | member | list |
| GET | `/suppliers/{id}/payments` | member | list of verified/pending payments |

## Invoices
Statuses: `draft`, `pending`, `partially_paid`, `paid`, `overdue`, `cancelled`. Derived server-side from
payment_records whose linked blockchain_transaction is confirmed.
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/invoices?status=&supplier_id=&page=&per_page=` | member | paginated |
| POST | `/invoices` | owner/admin/finance | `{supplier_id,description,amount,asset_code,asset_issuer?,due_date,reference?,items?:[{description,quantity,unit_price}]}`; generates unique `invoice_number` like `INV-YYYY-0001` |
| GET | `/invoices/{id}` | member | detail incl. payments + computed status |
| PATCH | `/invoices/{id}` | owner/admin/finance | only draft/pending |
| POST | `/invoices/{id}/submit` | owner/admin/finance | draft -> pending |
| POST | `/invoices/{id}/cancel` | owner/admin/finance | only if no confirmed payment |
| GET | `/invoices/{id}/pdf` | member | `application/pdf` professional invoice |

## Payment agreements
Statuses: `draft`, `awaiting_acceptance`, `active`, `completed`, `cancelled`, `disputed`.
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/agreements?status=` | member | list (suppliers see only their own) |
| POST | `/agreements` | owner/admin | `{supplier_id,title,description?,total_amount,asset_code,asset_issuer?,expiry_date,conditions?,approval_requirements?,milestones:[{description,amount,due_date?}]}`; generates `agreement_reference` `AGR-YYYY-0001`; sums milestone amounts must equal total_amount |
| GET | `/agreements/{id}` | member | detail incl. milestones + contract fields |
| PATCH | `/agreements/{id}` | owner/admin | draft only |
| POST | `/agreements/{id}/submit` | owner/admin | draft -> awaiting_acceptance |
| POST | `/agreements/{id}/accept` | supplier (of that supplier profile) | awaiting_acceptance -> active |
| POST | `/agreements/{id}/cancel` | owner/admin | refund policy: only if no milestone released; records reason |
| POST | `/agreements/{id}/dispute` | supplier or owner/admin | active -> disputed |
| POST | `/agreements/{id}/fund` | owner/admin | `{transaction_hash,funded_amount}`; verifies tx on-chain before marking funded. Also stores `escrow_contract_id` from config. |
| GET | `/agreements/{id}/milestones` | member | list |

## Escrow milestone release (Soroban)
| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | `/agreements/{id}/milestones/{milestone_id}/prepare-release` | owner/admin/finance | Builds Soroban invoke tx (simulate + assemble) for `release_milestone`, requires funded agreement, returns `{xdr,hash,payment_id}` |
| POST | `/agreements/{id}/milestones/{milestone_id}/release` | owner/admin/finance | `{signed_xdr}` submits, polls RPC, verifies event, marks milestone released + payment confirmed |
| GET | `/agreements/{id}/events` | member | on-chain/audit events for agreement |

## Payments (ordinary Stellar payments)
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/payments?status=&page=&per_page=` | member | paginated |
| POST | `/payments/prepare` | owner/admin/finance | `{invoice_id,source_account}`; loads source sequence, builds real payment tx with memo = invoice_number, asset, amount, destination = supplier wallet; stores pending payment + precomputed hash; returns `{payment_id,xdr,hash,expires_at}` |
| POST | `/payments/{id}/submit` | owner/admin/finance | `{signed_xdr}`; submits to Horizon, polls until confirmed/failed, independently verifies source/dest/asset/amount/memo, marks invoice paid/partially_paid, creates notification+audit+transaction record; returns payment |
| GET | `/payments/{id}` | member | detail |

Duplicate protection: a payment can only be prepared once per invoice for a given amount; a transaction hash can only be linked to one payment (unique constraint).

## Blockchain transactions & verification
| Method | Path | Roles | Notes |
|---|---|---|---|
| GET | `/transactions?page=&per_page=` | member | list |
| GET | `/transactions/{hash}` | member | detail from DB + fresh Horizon check |
| POST | `/transactions/verify` | owner/admin/finance | `{hash,invoice_id?}`; independent verification service; 200 with result or 409 if already used |
| GET | `/verify/{hash}` | public | limited public receipt data (no private notes/emails of internal users) |

Only `successful=true` AND confirmed-in-ledger transactions may settle invoices. Failed or
unconfirmed transactions are recorded with status `failed`/`pending` and never credited.

## Notifications, reports, audit, wallets
| Method | Path | Notes |
|---|---|---|
| GET | `/notifications?unread_only=` | list |
| PATCH | `/notifications/{id}/read` | mark read |
| PATCH | `/notifications/read-all` | mark all read |
| GET | `/reports/dashboard` | all metrics derived from DB |
| GET | `/reports/payments.csv` | CSV export |
| GET | `/audit-logs?action=&page=` | immutable audit trail |
| GET | `/wallets` | list connected public addresses |
| POST | `/wallets` | `{public_key,network}`; must equal `testnet`; never accepts secrets |
| DELETE | `/wallets/{id}` | disconnect |

## Endpoints added in the second pass (verified by tests)

| Method | Path | Roles | Notes |
|---|---|---|---|
| POST | `/suppliers/{id}/invitations` | owner/admin/finance | one-time token returned once; must match supplier contact email |
| GET | `/suppliers/invitations` | owner/admin/finance | lists invitations; marks expired ones |
| POST | `/suppliers/invitations/{token}/accept` | invited email only | authenticated acceptance; links existing user |
| POST | `/suppliers/invitations/{token}/reject` | invited email only | explicit decline with optional reason |
| POST | `/suppliers/{id}/invitations/{invitation_id}/revoke` | owner/admin/finance | revokes a pending invitation |
| POST | `/invoices/{id}/approve`, `/invoices/{id}/reject` | owner/admin/finance | approval history and rejection reason audited |
| GET/POST | `/invoices/{id}/attachments`, `DELETE /invoices/{id}/attachments/{id}` | member/owner | 5 MB limit, type validation, business-bound |
| POST | `/agreements/{id}/milestones/{id}/evidence` | linked supplier | evidence before on-chain approval |
| POST | `/agreements/{id}/prepare-refund`, `/agreements/{id}/refund` | owner/admin | real Soroban `refund` + event verification |
| GET | `/payments/{id}/prepared-xdr` | business member | prepared-only; never returns confirmed XDR |
| POST | `/agreements/{id}/reconcile` | owner/admin/finance | read-only on-chain state comparison + audit entry |
| GET | `/reports/analytics.pdf` | member | PDF export of DB-derived analytics |

Every response is tenant-scoped. Request IDs are echoed in `X-Request-ID`. The
reconciliation endpoint writes an audit entry only; it never alters financial records.

## Stellar config (server-side only, from env)
- Network: Testnet
- Passphrase: `Test SDF Network ; September 2015`
- Horizon: `https://horizon-testnet.stellar.org`
- Soroban RPC: `https://soroban-testnet.stellar.org`
- Native asset XLM (`asset_code` = `XLM`, `asset_issuer` = null)
- Escrow contract ID from env `STELLAR_ESCROW_CONTRACT_ID` (never invented)
