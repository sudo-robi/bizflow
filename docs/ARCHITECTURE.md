# BizFlow Architecture

## Overview

BizFlow is a business payments platform that combines a conventional fintech
backend (identity, business data, invoices, agreements, audit trail) with real
Stellar Testnet settlement and a Soroban escrow contract for milestone payments.
It is deliberately **not** a generic crypto dashboard: every blockchain artifact
is tied to a business record (invoice, agreement or milestone) and is independently
verified before it changes a payment status.

```
 Browser (Next.js)                Backend (FastAPI)              Data & Chains
 ┌──────────────────┐        ┌────────────────────────┐     ┌────────────────────┐
 │ App Router UI    │  JSON  │ Routers (RBAC + tenant │     │ PostgreSQL         │
 │ React Hook Form  ├───────►│ isolation on every     │────►│ normalized tables  │
 │ Zod validation   │  HTTP  │ query)                 │     │ Decimal amounts    │
 │ Freighter API    │        │ Services:              │     └────────────────────┘
 └────────┬─────────┘        │  - stellar.py          │              │
          │ signs            │  - verification.py     │              │
          ▼                  │  - receipts.py         │              ▼
   Freighter extension       │  - notifications.py    │     Horizon (Testnet)
   (public key only)         └───────────┬────────────┘     Soroban RPC (Testnet)
                                         │                  Soroban escrow contract
                                         └─────────────────►└────────────────────┘
```

## Technology choices

| Layer | Choice | Rationale |
|---|---|---|
| Frontend | Next.js 15 App Router, TypeScript, Tailwind, React Hook Form, Zod | Server-capable React, strong typing, accessible forms |
| Backend | Python FastAPI, Pydantic v2, SQLAlchemy 2.0, Alembic | Fast API development, schema validation, migrations |
| Database | PostgreSQL (SQLite only as a real-DB local test fallback) | Relational integrity, unique constraints, transactions |
| Auth | JWT in httpOnly cookie + bcrypt password hashing + RBAC dependencies | No secrets in browser storage |
| Blockchain | `stellar-sdk` (Python), `@stellar/stellar-sdk` (JS), Freighter API | Official SDKs |
| Contract | Rust + Soroban SDK 30 | Current Soroban SDK |
| Tests | pytest, Vitest, Playwright, `cargo test` | Each layer has executable tests |
| Infrastructure | Docker Compose (Postgres + backend + frontend) | Reproducible local/demo environment |

## Trust boundaries

1. **Browser → Backend**: JWT identifies the user; `X-Business-ID` selects the tenant.
   The backend re-verifies membership on every request. Hiding UI is never the
   authorization mechanism.
2. **Backend → Freighter**: the backend only ever receives a signed XDR and a public
   key. It never requests or stores a secret.
3. **Backend → Stellar**: transactions are built server-side with a source account
   supplied by the wallet; the wallet signs; the backend submits and then polls.
4. **Chain → Database**: a verified, confirmed, successful transaction is the only
   event allowed to mark an invoice or milestone paid. Submission responses alone
   are never trusted.

## Domain model

See `DATABASE.md` for the full schema. The central relations are:

- `users` ↔ `businesses` through `business_members` with a role.
- A `business` owns `suppliers`, `invoices`, `payment_agreements`, `notifications`,
  `audit_logs`.
- An `invoice` has `invoice_items` and links to `payment_records`.
- A `payment_agreement` has `agreement_milestones`; each milestone can have one
  released payment.
- A `payment_record` links at most one `blockchain_transaction` (unique hash).
- `wallet_connections` store only public keys and the network.

## Money and precision

All monetary values are stored as `NUMERIC(20,7)` and serialized as decimal strings.
No `float` is used for amounts. Stellar amounts use 7-decimal stroops internally.

## Settlement flows

### Ordinary invoice payment

1. `POST /payments/prepare` loads the source account sequence, builds a real payment
   transaction to the supplier's validated Stellar address, sets the invoice number
   as a memo, stores a pending `payment_record` with the precomputed hash.
2. The browser presents the full transaction to the user; Freighter signs it.
3. `POST /payments/{id}/submit` submits the signed XDR, polls Horizon until the
   transaction is confirmed or failed, then independently verifies source,
   destination, asset, amount and memo before crediting the invoice.
4. A PDF receipt, notification and audit entry are created from the verified record.

### Milestone escrow release

1. Agreement is created, submitted, and accepted by the supplier.
2. Business funds the agreement; the funding transaction is verified on-chain.
3. Business approves a milestone; a Soroban `invokeHostFunction` transaction is
   simulated, assembled, signed by Freighter, submitted to the RPC and polled.
4. The release is confirmed only when the RPC reports `SUCCESS` and the expected
   contract event is present. The milestone then becomes `released`.

## Failure handling

Network errors, rejected signatures, insufficient balances, duplicate releases and
failed transactions are recorded explicitly (`failed`, `rejected`, etc.) and surfaced
to the UI. No code path silently marks a payment successful without confirmation.
