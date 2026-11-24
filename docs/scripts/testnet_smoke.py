#!/usr/bin/env python3
"""Real Stellar Testnet smoke test.

Builds, signs and submits a genuine payment transaction, then independently
verifies it against Horizon. This script never fabricates hashes or pretends a
submission is confirmed.

Usage:
  export TESTNET_SECRET=S...   # funded testnet account secret (local only)
  python docs/scripts/testnet_smoke.py
"""
from __future__ import annotations

import os
import sys
import time

from stellar_sdk import Asset, Keypair, Network, Server, TextMemo, TransactionBuilder

HORIZON = "https://horizon-testnet.stellar.org"
PASSPHRASE = Network.TESTNET_NETWORK_PASSPHRASE


def main() -> int:
    secret = os.environ.get("TESTNET_SECRET")
    if not secret:
        print("ERROR: set TESTNET_SECRET to a funded Stellar Testnet account secret", file=sys.stderr)
        return 2
    source = Keypair.from_secret(secret)
    destination = Keypair.random()
    server = Server(HORIZON)

    # Fund a fresh destination account through Friendbot so the payment can land.
    import requests

    r = requests.get("https://friendbot.stellar.org/", params={"addr": destination.public_key}, timeout=30)
    r.raise_for_status()
    print(f"friendbot funding hash: {r.json().get('hash')}")

    account = server.load_account(source.public_key)
    memo = f"BIZFLOW-SMOKE-{int(time.time())}"
    tx = (
        TransactionBuilder(account, PASSPHRASE, base_fee=100)
        .append_payment_op(destination.public_key, Asset.native(), "1.0000000")
        .add_memo(TextMemo(memo))
        .set_timeout(180)
        .build()
    )
    tx.sign(source)
    response = server.submit_transaction(tx)
    if not response.get("successful"):
        print(f"ERROR: submission not successful: {response}", file=sys.stderr)
        return 1
    tx_hash = response["hash"]
    print(f"submitted hash: {tx_hash}")

    # Independent verification: fetch from Horizon and check the operation.
    record = server.transactions().transaction(tx_hash).call()
    if record.get("successful") is not True:
        print("ERROR: transaction not successful on ledger", file=sys.stderr)
        return 1
    operations = server.operations().for_transaction(tx_hash).call()
    op = operations["_embedded"]["records"][0]
    assert op["type"] == "payment", op["type"]
    assert op["asset_type"] == "native", op["asset_type"]
    assert op["to"] == destination.public_key
    assert op["source_account"] == source.public_key
    assert record.get("memo") == memo, (record.get("memo"), memo)
    print(f"VERIFIED: source={source.public_key} dest={destination.public_key} memo={memo}")
    print(f"explorer: https://explorer.stellar.org/tx/{tx_hash}?chain=testnet")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
