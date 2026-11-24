"""Stellar SDK construction tests (no network: only the account loader is faked)."""

from __future__ import annotations

import pytest
from stellar_sdk import Asset, Keypair, TextMemo, TransactionBuilder

from app.config import MAINNET_PASSPHRASE, Settings
from app.errors import BizError
from app.services import stellar


def test_build_payment_xdr_uses_asset_object_and_text_memo(monkeypatch):
    source, destination = Keypair.random().public_key, Keypair.random().public_key
    monkeypatch.setattr(
        stellar, "horizon_server", lambda: _FakeAccountServer(source)
    )
    prepared = stellar.build_payment_xdr(
        source, destination, "1250.50", "XLM", None, "INV-2026-0001"
    )
    envelope = TransactionBuilder.from_xdr(
        prepared.xdr, stellar.settings.stellar_network_passphrase
    )
    operation = envelope.transaction.operations[0]
    assert isinstance(operation.asset, Asset) and operation.asset.is_native()
    assert isinstance(envelope.transaction.memo, TextMemo)
    assert envelope.transaction.memo.memo_text == b"INV-2026-0001"
    assert operation.destination.account_id == destination
    assert operation.amount == "1250.5"
    assert prepared.hash == envelope.hash_hex() and len(prepared.hash) == 64


def test_credit_asset_requires_issuer(monkeypatch):
    source, destination = Keypair.random().public_key, Keypair.random().public_key
    monkeypatch.setattr(stellar, "horizon_server", lambda: _FakeAccountServer(source))
    with pytest.raises(BizError) as exc:
        stellar.build_payment_xdr(source, destination, "1", "USD", None, "REF")
    assert exc.value.status_code == 400


def test_invalid_public_key_is_rejected():
    with pytest.raises(BizError) as exc:
        stellar.build_payment_xdr("not-a-key", Keypair.random().public_key, "1", "XLM", None, "REF")
    assert exc.value.status_code == 400


def test_mainnet_configuration_is_refused():
    with pytest.raises(ValueError, match="testnet"):
        Settings(
            jwt_secret="32-byte-minimum-secret-for-tests",
            stellar_network_passphrase=MAINNET_PASSPHRASE,
        )


def test_mainnet_horizon_is_refused():
    with pytest.raises(ValueError, match="mainnet"):
        Settings(
            jwt_secret="32-byte-minimum-secret-for-tests",
            stellar_horizon_url="https://horizon-mainnet.example.org",
        )


class _FakeAccountServer:
    def __init__(self, account_id: str):
        self.account_id = account_id

    def load_account(self, account_id: str):
        from stellar_sdk import Account

        return Account(account_id, 1)

    def fetch_base_fee(self) -> int:
        return 100
