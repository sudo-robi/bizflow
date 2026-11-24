# BizFlow Frontend

Premium B2B fintech frontend for Stellar-based business payments. Built with Next.js 15 (App Router), TypeScript, Tailwind CSS 3, React Hook Form + Zod, Recharts and lucide-react.

## Setup

```bash
cd frontend
npm install
npm run dev
```

The app expects the backend at `/api/v1` by default. Override with:

```bash
NEXT_PUBLIC_API_BASE_URL=https://your-api.example/api/v1
```

## Commands

| Command | Description |
|---|---|
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm start` | Serve the production build |
| `npm run typecheck` | TypeScript check |
| `npm test -- --run` | Run Vitest unit tests |

## Authentication & business context

- Sessions live in an **httpOnly cookie** set by the backend. All API calls use `credentials: 'include'`.
- The JWT is never read or stored by the browser code.
- The active business id is sent via `X-Business-ID`. It is a non-sensitive preference persisted in `localStorage` only.

## Stellar / Freighter security model

- Testnet is enforced (`Test SDF Network ; September 2015`) before any signature is requested.
- `POST /payments/prepare` (or the Soroban milestone `prepare-release` endpoint) returns the **real unsigned XDR**, which is parsed and displayed in full before signing.
- The user must click **Approve & Sign**, which triggers a local Freighter signature. Only then is `signed_xdr` submitted to the backend.
- Transaction hashes are always returned by the backend / signed transaction — never fabricated in the browser.
- The app never requests private keys, seed phrases or mnemonic phrases.

## Pages

Public: `/`, `/login`, `/register`, `/verify/[hash]`
Authenticated: `/onboarding`, `/dashboard`, `/suppliers`, `/suppliers/[id]`, `/invoices`, `/invoices/new`, `/invoices/[id]`, `/agreements`, `/agreements/new`, `/agreements/[id]`, `/payments/approve`, `/wallet`, `/transactions`, `/transactions/[hash]`, `/notifications`, `/reports`, `/settings`

All endpoints and data shapes follow `docs/API_CONTRACT.md` at the repository root.
