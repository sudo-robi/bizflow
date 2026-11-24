# BizFlow — Second-Pass Security Report

See `BIZFLOW_FINAL_SECURITY_REPORT.md` for severity, file/module, root cause, remediation status and test evidence.

Summary of second-pass security findings:

1. **CRITICAL (fixed)** — client-controlled escrow contract and unbound Horizon funding could false-mark an agreement funded. Bound to server state; tests added.
2. **CRITICAL (fixed)** — Soroban XDR decoder used wrong SDK accessors, rejecting all real signed invocations. Corrected and verified against a real invocation.
3. **HIGH (fixed)** — approve/release submit paths skipped state/expiry/kind checks. Re-validated.
4. **HIGH (fixed)** — transaction verification authorization and global hash blocking. Role-gated, business-scoped.
5. **HIGH (partially mitigated)** — one configured contract shared across agreements; per-agreement binding enforced, per-instance deployment requires funded keys.
6. **MEDIUM (partially mitigated)** — CSRF token absent; SameSite=Lax cookie plus custom business header on tenant writes.
7. **MEDIUM (fixed)** — attachment uploads validated and business-bound.
8. **BLOCKED** — live deployment/packages due to missing host credentials and token scope.

The application is **not** claimed production-ready; it remains a Stellar Testnet system.
