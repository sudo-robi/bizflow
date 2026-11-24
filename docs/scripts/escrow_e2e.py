#!/usr/bin/env python3
"""Real Soroban escrow workflow through BizFlow's API.

Prerequisites:
  - a fresh escrow contract deployed and initialized on Testnet (one per agreement)
  - TESTNET_SECRET for the payer account (local only)
  - a running backend

Usage:
  python docs/scripts/escrow_e2e.py <base_url> <contract_id> <onchain_agreement_id>
"""
from __future__ import annotations

import os
import sys
import uuid

import httpx
from stellar_sdk import Keypair, Network, TransactionEnvelope

BASE = sys.argv[1] if len(sys.argv) > 1 else "http://localhost:8100/api/v1"
CONTRACT = sys.argv[2] if len(sys.argv) > 2 else ""
AGREEMENT_NO = int(sys.argv[3]) if len(sys.argv) > 3 else 0
PAYER = "GAZUFXW3M7WM6ZKO5BRWZS47S3WIJEUZZDJ7VK4UAETVQRRMD3JJ2MVB"
PAYEE = "GCAOTM3FT2JWT2OHRM7TWHEEU52PN6FGGXXB3GE443QSPHXRHUATNMXZ"


def ok(resp: httpx.Response, code: int, label: str):
    if resp.status_code != code:
        raise SystemExit(f"FAIL {label}: {resp.status_code} {resp.text[:700]}")
    print(f"PASS {label}: {resp.status_code}")
    return resp.json() if resp.content else None


def sign(xdr: str, kp: Keypair) -> str:
    tx = TransactionEnvelope.from_xdr(xdr, Network.TESTNET_NETWORK_PASSPHRASE)
    tx.sign(kp)
    return tx.to_xdr()


def main() -> int:
    secret = os.environ.get("TESTNET_SECRET")
    if not secret or not CONTRACT or not AGREEMENT_NO:
        raise SystemExit("Need TESTNET_SECRET, contract id and onchain agreement id")
    kp = Keypair.from_secret(secret)
    if kp.public_key != PAYER:
        raise SystemExit("TESTNET_SECRET must match the payer account")

    suffix = uuid.uuid4().hex[:8]
    c = httpx.Client(base_url=BASE, timeout=90)
    reg = ok(c.post("/auth/register", json={
        "email": f"escrow-{suffix}@example.com", "password": "Str0ngPassw0rd!",
        "full_name": "Escrow Owner", "business_name": f"Escrow {suffix}",
    }), 201, "register owner")
    owner = {"Authorization": f"Bearer {reg['token']}", "X-Business-ID": reg["business"]["id"]}

    supplier_email = f"escrow-sup-{suffix}@example.com"
    ok(c.post(f"/businesses/{reg['business']['id']}/members", headers=owner,
              json={"email": supplier_email, "role": "supplier"}), 201, "invite supplier")
    sup_reg = ok(c.post("/auth/register", json={
        "email": supplier_email, "password": "Str0ngPassw0rd!", "full_name": "Escrow Supplier",
    }), 201, "register supplier")
    supplier = {"Authorization": f"Bearer {sup_reg['token']}", "X-Business-ID": reg["business"]["id"]}

    supplier_record = ok(c.post("/suppliers", headers=owner, json={
        "business_name": "Testnet Supplier", "email": supplier_email, "wallet_address": PAYEE,
    }), 201, "create supplier")

    agreement = ok(c.post("/agreements", headers=owner, json={
        "supplier_id": supplier_record["id"], "title": "Real escrow delivery",
        "total_amount": "2", "asset_code": "XLM", "expiry_date": "2030-12-31T00:00:00Z",
        "milestones": [
            {"description": "Discovery", "amount": "1"},
            {"description": "Delivery", "amount": "1"},
        ],
    }), 201, "create agreement")
    aid = agreement["id"]
    ok(c.post(f"/agreements/{aid}/submit", headers=owner), 200, "submit agreement")
    ok(c.post(f"/agreements/{aid}/accept", headers=supplier), 200, "accept agreement")

    fund_prep = ok(c.post(f"/agreements/{aid}/prepare-fund", headers=owner, json={
        "source_account": PAYER, "escrow_contract_id": CONTRACT,
        "onchain_agreement_id": AGREEMENT_NO, "amount": "2",
    }), 200, "prepare escrow funding")
    ok(c.post(f"/agreements/{aid}/fund-escrow", headers=owner, json={
        "signed_xdr": sign(fund_prep["xdr"], kp),
    }), 200, "submit verified funding")

    milestones = ok(c.get(f"/agreements/{aid}/milestones", headers=owner), 200, "list milestones") or []
    # AgreementOut embeds milestones; list endpoint may be paginated/unwrapped.
    if isinstance(milestones, dict):
        milestones = milestones.get("items", [])
    mid = milestones[0]["id"]

    approve_prep = ok(c.post(f"/agreements/{aid}/milestones/{mid}/prepare-approve",
                             headers=owner, json={"source_account": PAYER}), 200, "prepare approval")
    ok(c.post(f"/agreements/{aid}/milestones/{mid}/approve", headers=owner,
              json={"signed_xdr": sign(approve_prep["xdr"], kp)}), 200, "submit verified approval")

    release_prep = ok(c.post(f"/agreements/{aid}/milestones/{mid}/prepare-release",
                             headers=owner, json={"source_account": PAYER}), 200, "prepare release")
    released = ok(c.post(f"/agreements/{aid}/milestones/{mid}/release", headers=owner,
                         json={"signed_xdr": sign(release_prep["xdr"], kp)}), 200, "submit verified release")
    print("Status:", released["status"])
    print("Milestones:", [(m["description"], m["status"]) for m in released["milestones"]])
    print("Contract:", released["escrow_contract_id"])
    print("Funding tx:", released["fund_transaction_hash"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
