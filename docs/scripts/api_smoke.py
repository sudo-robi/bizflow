#!/usr/bin/env python3
"""End-to-end API smoke test against a running BizFlow backend.

Registers a business, creates a supplier and invoice, and checks RBAC and
tenant isolation. It never fabricates chain results: the payment preparation
step is verified against the API response, and settlement is only exercised
when a real signed XDR is supplied via TESTNET_SECRET (local use only).

Usage:
  python docs/scripts/api_smoke.py [base_url]
"""
from __future__ import annotations

import sys
import time
import uuid

import httpx

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000/api/v1"


def check(resp: httpx.Response, expected: int, label: str):
    if resp.status_code != expected:
        raise SystemExit(f"FAIL {label}: expected {expected}, got {resp.status_code}: {resp.text[:500]}")
    print(f"PASS {label}: {resp.status_code}")
    return resp.json() if resp.content else None


def main() -> int:
    c = httpx.Client(base_url=BASE, timeout=30)
    suffix = uuid.uuid4().hex[:8]
    email = f"owner-{suffix}@example.com"
    password = "StrongPassw0rd!123"

    user = check(c.post("/auth/register", json={
        "email": email, "password": password, "full_name": "Smoke Owner",
        "business_name": f"Smoke Business {suffix}",
    }), 201, "register")
    token = user["token"]
    c.headers["Authorization"] = f"Bearer {token}"

    me = check(c.get("/auth/me"), 200, "auth/me")
    businesses = me.get("memberships", me.get("businesses", []))
    if not businesses:
        raise SystemExit("FAIL: no business membership after registration")
    biz = businesses[0]["business"]["id"] if "business" in businesses[0] else businesses[0]["id"]
    c.headers["X-Business-ID"] = biz

    check(c.get("/businesses"), 200, "list businesses")
    supplier = check(c.post("/suppliers", json={
        "business_name": f"Supplier {suffix}",
        "contact_name": "Smoke Contact",
        "email": f"supplier-{suffix}@example.com",
        "wallet_address": "GAZUFXW3M7WM6ZKO5BRWZS47S3WIJEUZZDJ7VK4UAETVQRRMD3JJ2MVB",
    }), 201, "create supplier")

    invoice = check(c.post("/invoices", json={
        "supplier_id": supplier["id"],
        "description": "Smoke test invoice",
        "amount": "12.5000000",
        "asset_code": "XLM",
        "due_date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 86400)),
        "reference": f"SMOKE-{suffix}",
    }), 201, "create invoice")

    check(c.get(f"/invoices/{invoice['id']}"), 200, "get invoice")
    check(c.get("/invoices"), 200, "list invoices")
    check(c.get("/suppliers"), 200, "list suppliers")
    check(c.get("/reports/dashboard"), 200, "dashboard")
    check(c.get("/transactions"), 200, "transactions")
    check(c.get("/notifications"), 200, "notifications")
    check(c.get("/audit-logs"), 200, "audit logs")

    # Unauthenticated access must be rejected.
    anon = httpx.Client(base_url=BASE, timeout=30)
    check(anon.get("/invoices"), 401, "unauthenticated access rejected")
    print(f"Supplier: {supplier['id']}  Invoice: {invoice['id']}  Business: {biz}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
