# BIZFLOW — Security Assurance Report

Branch: `blockchain-security-deployment-hardening`.

## Verification results (this branch)

- Backend pytest: **262 passed, 0 failed**
- Frontend Vitest: **262 passed, 0 failed**
- Soroban `cargo test`: **47 passed, 0 failed**
- Raw logs: `/home/robi/tmp/opencode/bizflow-baseline/`

## Finding 1 — No CSRF protection for cookie-authenticated mutations

- **Severity:** HIGH
- **Root cause:** Authentication uses an httpOnly session cookie; the only anti-CSRF measures were `SameSite=Lax` and a comment claiming the `X-Business-ID` header was sufficient. Three state-changing endpoints (`logout`, invitation accept/reject) required only the cookie. No token, Origin or Referer check existed anywhere in the backend or frontend.
- **Files affected:** `backend/app/main.py`, `backend/app/routers/auth.py`, `backend/app/config.py`, `frontend/src/lib/api.ts`.
- **Changes made:** implemented defense in depth:
  - login/register set a non-httpOnly `bizflow_csrf` double-submit token alongside the session cookie;
  - frontend sends `X-CSRF-Token` on POST/PUT/PATCH/DELETE;
  - backend middleware rejects unsafe methods that present a session cookie without either a matching double-submit token, an allowed `Origin`/`Referer`, or a same-origin `Sec-Fetch-Site`; Bearer-token API clients are explicitly exempt;
  - the CSRF header is added to the CORS allowlist; logout clears both cookies.
  - Controlled by `ENFORCE_CSRF_ORIGIN_CHECK` (default `true`).
- **Tests performed:** `test_csrf_blocks_cookie_authenticated_mutation`, `test_csrf_rejects_foreign_origin_without_token`; full backend and frontend suites.
- **Actual test results:** backend pytest 262 passed / 0 failed; frontend Vitest 262 passed / 0 failed; Soroban cargo test 47 passed / 0 failed (final run). Raw logs: `/home/robi/tmp/opencode/bizflow-baseline/`.
- **Status:** **VERIFIED COMPLETE** at the API layer. SameSite remains `lax` as a second layer.

## Finding 2 — No browser security headers / request limits / input redaction

- **Severity:** MEDIUM
- **Root cause:** middleware only echoed `X-Request-ID`; no HSTS, nosniff, frame, referrer, permission or CSP headers; 422 bodies echoed raw submitted values; no global body-size limit; `X-Request-ID` was never logged.
- **Files affected:** `backend/app/main.py`, `backend/app/config.py`, `backend/app/schemas.py`.
- **Changes made:** `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy`, `Permissions-Policy`, restrictive `Content-Security-Policy`, and HSTS when secure cookies are enabled. Request bodies above `MAX_REQUEST_BODY_BYTES` (default 8 MiB) get a structured 413. Validation errors no longer echo `input`/`url`. Correlation ids are written to every request log line. `signed_xdr` is length-bounded.
- **Tests performed:** `test_security_headers_and_correlation_id`, `test_validation_errors_do_not_echo_submitted_secrets`, `test_oversized_request_is_rejected`, `test_malformed_transaction_hash_is_rejected`.
- **Status:** **VERIFIED COMPLETE**.

## Finding 3 — Publicly known development JWT fallback

- **Severity:** HIGH
- **Root cause:** an unset/weak `JWT_SECRET` in development silently became the fixed literal `dev-only-jwt-secret-change-me`, which anyone could use to forge tokens.
- **Files affected:** `backend/app/config.py`, `backend/tests/test_coverage_final_gaps.py`, `backend/tests/test_coverage_units.py`.
- **Changes made:** the fixed fallback was removed. An empty secret now either raises at startup or, *only* for the local SQLite fallback, generates an ephemeral random secret with a warning. Production/staging still require ≥32 characters, secure cookies and a real database URL. `ACCESS_TOKEN_EXPIRE_MINUTES` and `SQLITE_URL` are now consumed instead of silently ignored; explicit `SQLITE_PATH` takes precedence over the alias.
- **Tests performed:** config guard tests (updated to the new intended behavior), full backend suite.
- **Status:** **VERIFIED COMPLETE**.

## Finding 4 — Authorization gaps on sensitive endpoints

- **Severity:** HIGH
- **Root cause:** wallet connect/disconnect, all reports, audit log and business member listing required only active membership, so a `supplier` could modify payment configuration and read full financial data/member emails.
- **Files affected:** `backend/app/routers/wallets.py`, `reports.py`, `audit.py`, `businesses.py`.
- **Changes made:** wallet mutation is owner/admin only, wallet list/reports/audit/member-list require `finance_manager` or higher; tenant scoping was preserved. Frontend-only role gating was confirmed never to be the authority for any settlement action.
- **Tests performed:** `test_supplier_cannot_manage_wallets_or_read_financial_reports`, existing RBAC suites.
- **Status:** **VERIFIED COMPLETE**.

## Finding 5 — Log/error hygiene and transaction validation

- **Severity:** MEDIUM
- **Root cause:** upstream exception strings were interpolated into client-facing errors; some path parameters accepted arbitrary strings; no secrets were logged but there was no redaction filter.
- **Files affected:** `backend/app/routers/transactions.py`, `backend/app/main.py`, `backend/app/schemas.py`.
- **Changes made:** 64-hex validation on transaction path parameters, stricter XDR and text limits, removal of submitted values from validation responses, and correlation-id logging. The existing pattern of logging provider detail while returning stable codes is retained.
- **Tests performed:** targeted validation tests plus full suite.
- **Status:** **VERIFIED COMPLETE** for the covered paths. Generic exception strings from some legacy chain calls are still propagated; see limitations.

## Finding 6 — Wallet integration

- **Severity:** LOW (after verification)
- **Root cause:** testnet detection accepted any network whose *name* matched `/testnet/i`, and Freighter access denial could be swallowed during connect.
- **Files affected:** `frontend/src/lib/stellar.ts`.
- **Changes made:** `assertTestnet()` now requires an exact match to the Testnet passphrase. No private key, seed phrase or recovery phrase is requested anywhere (re-confirmed by source scan); signing remains user-controlled in Freighter; backend authorization does not depend on frontend checks. Client-side display of parsed XDR remains imperfect (only the first recognized operation is shown) — backend checks are authoritative.
- **Tests performed:** `frontend/tests/stellar.test.ts` (updated to exact-passphrase semantics), full frontend suite.
- **Status:** **PARTIALLY IMPLEMENTED** — passphrase enforcement verified; full multi-operation XDR display/validation not implemented.

## Finding 7 — Secrets and configuration

- **Severity:** INFO after verification
- **Actual result:** no real secret in tracked files or git history; `.env` files are gitignored and excluded by `backend/.dockerignore`; `POSTGRES_PASSWORD` is required by Compose interpolation. Added `frontend/.dockerignore` so a future frontend `.env` cannot enter the image build context.
- **Status:** **VERIFIED COMPLETE**. No secret values are reproduced in this report.

## Remaining limitations

1. Rate limiting is per remote IP with in-process `MemoryStorage`; behind the Next.js rewrite all users may share a bucket and limits reset on restart. (**PARTIALLY IMPLEMENTED**)
2. Registration activates pending memberships — including `owner`/`admin`/`finance_manager` — solely by matching an unconfirmed email. This is a real cross-tenant privilege-claim path (**NOT IMPLEMENTED** — fixing it requires an email-verification flow and changes to long-standing test fixtures; not attempted here).
3. Some legacy chain error paths still return provider-derived text; a blanket sanitizer was not applied to avoid breaking documented error codes.
4. No DAST/secret-scanning run was performed locally beyond available tooling; CI audits were added but cannot be verified until GitHub runs them.
