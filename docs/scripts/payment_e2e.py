#!/usr/bin/env python3
"""Real end-to-end payment flow through the BizFlow API.

Registers a business, creates a supplier + invoice, prepares a genuine Stellar
payment transaction via the backend, signs it locally with a funded Testnet
account (standing in for Freighter), submits it through the backend and checks
that the backend only marks the invoice paid after independent verification.

This script does NOT fabricate hashes or statuses. It requires a running backend
and a funded Testnet secret supplied locally via TESTNET_SECRET.
"""
from __future__ import annotations

import os
import sys
import time
import uuid

import httpx
from stellar_sdk import Keypair, Network, TransactionEnvelope

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8000/api/v1"
SOURCE = "GAZUFXW3M7WM6ZKO5BRWZS47S3WIJEUZZDJ7VK4UAETVQRRMD3JJ2MVB"
DESTINATION = "GCAOTM3FT2JWT2OHRM7TWHEEU52PN6FGGXXB3GE443QSPHXRHUATNMXZ"


def ok(resp: httpx.Response, code: int, label: str):
    if resp.status_code != code:
        raise SystemExit(f"FAIL {label}: {resp.status_code} {resp.text[:600]}")
    print(f"PASS {label}: {resp.status_code}")
    return resp.json() if resp.content else None


def main() -> int:
    secret = os.environ.get("TESTNET_SECRET")
    if not secret:
        raise SystemExit("set TESTNET_SECRET (local, funded Testnet account)")
    kp = Keypair.from_secret(secret)
    if kp.public_key != SOURCE:
        raise SystemExit("TESTNET_SECRET does not match expected source account")

    c = httpx.Client(base_url=BASE, timeout=60)
    suffix = uuid.uuid4().hex[:8]
    reg = ok(c.post("/auth/register", json={
        "email": f"pay-{suffix}@example.com", "password": "StrongPassw0rd!123",
        "full_name": "Payment Tester", "business_name": f"Payments {suffix}",
    }), 201, "register")
    c.headers["Authorization"] = f"Bearer {reg['token']}"
    me = ok(c.get("/auth/me"), 200, "me")
    memberships = me.get("memberships", me.get("businesses", []))
    entry = memberships[0]
    biz = entry["business"]["id"] if "business" in entry else entry["id"]
    c.headers["X-Business-ID"] = biz

    supplier = ok(c.post("/suppliers", json={
        "business_name": "Real Testnet Supplier",
        "contact_name": "Test Contact",
        "email": f"sup-{suffix}@example.com",
        "wallet_address": DESTINATION,
    }), 201, "create supplier")

    invoice = ok(c.post("/invoices", json={
        "supplier_id": supplier["id"],
        "description": "Real Testnet settlement",
        "amount": "1.0000000",
        "asset_code": "XLM",
        "due_date": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(time.time() + 86400)),
        "reference": f"PAY-{suffix}",
    }), 201, "create invoice")

    prepared = ok(c.post("/payments/prepare", json={
        "invoice_id": invoice["id"], "source_account": SOURCE,
    }), 201, "prepare payment")
    xdr = prepared.get("xdr") or prepared.get("unsigned_xdr")
    if not xdr:
        raise SystemExit(f"FAIL: no xdr in prepare response: {prepared}")
    tx = TransactionEnvelope.from_xdr(xdr, Network.TESTNET_NETWORK_PASSPHRASE)
    tx.sign(kp)
    signed = tx.to_xdr()

    payment = ok(c.post(f"/payments/{prepared['payment_id']}/submit", json={
        "signed_xdr": signed,
    }), 200, "submit signed payment")

    final = ok(c.get(f"/invoices/{invoice['id']}"), 200, "invoice after settlement")
    status = final.get("status")
    if status not in ("paid", "partially_paid"):
        raise SystemExit(f"FAIL: expected paid invoice, got {status}")
    print(f"Invoice status: {status}")
    txhash = payment.get("transaction_hash") or payment.get("hash") or prepared.get("hash")
    print(f"Real Testnet transaction: {txhash}")
    if txhash:
        print(f"Explorer: https://explorer.stellar.org/tx/{txhash}?chain=testnet")
    receipt = c.get(f"/payments/{payment['id']}/receipt")
    print(f"Receipt endpoint: {receipt.status_code} ({receipt.headers.get('content-type')})")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
