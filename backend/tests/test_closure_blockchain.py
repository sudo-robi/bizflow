"""Reproducible LOCAL integration tests for escrow closure.

Two distinct deployed contract ids and two agreements are used throughout. Only
the Soroban/Horizon RPC boundary is faked: XDR is built and parsed with the real
stellar-sdk, and every state/event value is synthesised in-process. Nothing here
claims a real Testnet result.
"""

from __future__ import annotations

from decimal import Decimal
from types import SimpleNamespace

import pytest
from stellar_sdk import (
    Account,
    Asset,
    Keypair,
    StrKey,
    TransactionBuilder,
    scval,
)
from stellar_sdk.soroban_rpc import GetTransactionStatus

from app import models
from app.config import get_settings
from app.errors import BizError
from app.services import reconciliation, stellar, verification
from tests.conftest import TestSession, create_supplier

SETTINGS = get_settings()
PASSPHRASE = SETTINGS.stellar_network_passphrase
CONTRACT_A = StrKey.encode_contract(Keypair.random().raw_public_key())
CONTRACT_B = StrKey.encode_contract(Keypair.random().raw_public_key())
PAYER_A = Keypair.random()
PAYER_B = Keypair.random()


def _u32(value: int) -> str:
    return scval.to_uint32(value).to_xdr()


def _symbol(value: str) -> str:
    return scval.to_symbol(value).to_xdr()


def _i128(value: int) -> str:
    return scval.to_int128(value).to_xdr()


def _address(value: str) -> str:
    return scval.to_address(value).to_xdr()


def _contract_state(
    agreement_id: int, payer: str, *, asset: str, total: int,
    milestone_count: int, funded: int = 0, released: int = 0, status: str = "Created",
) -> dict:
    """A decoded dict shaped like the Rust `Agreement` struct in lib.rs."""
    return {
        "agreement_id": agreement_id,
        "payer": payer,
        "payee": PAYER_B.public_key,
        "asset": asset,
        "total_amount": total,
        "milestone_count": milestone_count,
        "funded": funded,
        "released": released,
        "remaining": funded - released,
        "authorized": PAYER_A.public_key,
        "status": status,
    }


def _state_xdr(state: dict) -> str:
    values = {
        "agreement_id": scval.to_uint64(state["agreement_id"]),
        "payer": scval.to_address(state["payer"]),
        "payee": scval.to_address(state["payee"]),
        "asset": scval.to_address(state["asset"]) if state["asset"] else scval.to_void(),
        "total_amount": scval.to_int128(state["total_amount"]),
        "milestone_count": scval.to_uint32(state["milestone_count"]),
        "funded": scval.to_int128(state["funded"]),
        "released": scval.to_int128(state["released"]),
        "remaining": scval.to_int128(state["remaining"]),
        "authorized": scval.to_address(state["authorized"]),
        "status": scval.to_symbol(state["status"]),
    }
    return scval.to_map(
        {scval.to_symbol(key): value for key, value in values.items()}
    ).to_xdr()


class FakeSorobanRPC:
    """Only the RPC boundary is replaced; XDR is produced by the real SDK."""

    def __init__(self):
        self.contracts: dict[str, dict] = {}
        self.milestones: dict[str, dict[int, dict]] = {}
        self.events: dict[str, list[dict]] = {}
        self.transactions: dict[str, SimpleNamespace] = {}
        self.simulate_error: Exception | None = None
        self.events_error: Exception | None = None
        self.poll_error: Exception | None = None
        self.send_error: Exception | None = None
        self.sent: list[str] = []
        self.simulations: list[tuple[str, str]] = []

    def load_account(self, account_id: str):
        return Account(account_id, 1)

    def prepare_transaction(self, transaction):
        return transaction

    def simulate_transaction(self, envelope):
        if self.simulate_error:
            raise self.simulate_error
        operation = envelope.transaction.operations[0]
        invocation = operation.host_function.invoke_contract
        function = invocation.function_name.sc_symbol.decode()
        contract_id = StrKey.encode_contract(
            invocation.contract_address.contract_id.contract_id.hash
        )
        self.simulations.append((contract_id, function))
        state = self.contracts.get(contract_id)
        if state is None or function not in ("get_agreement", "get_balance", "get_milestone"):
            return SimpleNamespace(
                model_dump=lambda: {"error": "unsupported function", "results": [], "latest_ledger": 100}
            )
        if function == "get_agreement":
            value = _state_xdr(state)
        elif function == "get_balance":
            value = scval.to_map(
                {
                    scval.to_symbol(key): scval.to_int128(state[key])
                    for key in ("funded", "released", "remaining")
                }
            ).to_xdr()
        else:
            index = scval.to_native(invocation.args[0])
            milestone = self.milestones.get(contract_id, {}).get(index)
            if milestone is None:
                return SimpleNamespace(
                    model_dump=lambda: {"error": "missing milestone", "results": [], "latest_ledger": 100}
                )
            value = scval.to_map(
                {
                    scval.to_symbol("index"): scval.to_uint32(milestone["index"]),
                    scval.to_symbol("description"): scval.to_string(milestone["description"]),
                    scval.to_symbol("amount"): scval.to_int128(milestone["amount"]),
                    scval.to_symbol("approved"): scval.to_bool(milestone["approved"]),
                    scval.to_symbol("released"): scval.to_bool(milestone["released"]),
                }
            ).to_xdr()
        payload = {"error": None, "results": [{"xdr": value}], "latest_ledger": 100}
        return SimpleNamespace(model_dump=lambda: payload)

    def get_events(self, **kwargs):
        if self.events_error:
            raise self.events_error
        contract_ids = kwargs["filters"][0].contract_ids
        rows = []
        for contract_id in contract_ids:
            for event in self.events.get(contract_id, []):
                rows.append(
                    SimpleNamespace(
                        contract_id=contract_id,
                        topic=event["topic"],
                        value=event["value"],
                        ledger=event.get("ledger", 100),
                        transaction_hash=event["transaction_hash"],
                        model_dump=lambda e=event, c=contract_id: {
                            "contract_id": c,
                            "topic": e["topic"],
                            "value": e["value"],
                            "ledger": e.get("ledger", 100),
                            "transaction_hash": e["transaction_hash"],
                        },
                    )
                )
        return SimpleNamespace(events=rows)

    def get_transaction(self, tx_hash: str):
        return self.transactions.get(
            tx_hash,
            SimpleNamespace(
                status=GetTransactionStatus.NOT_FOUND, ledger=None, latest_ledger=100
            ),
        )

    def send_transaction(self, signed_xdr: str):
        if self.send_error:
            raise self.send_error
        self.sent.append(signed_xdr)

    def poll_transaction(self, tx_hash: str, max_attempts: int = 20):
        if self.poll_error:
            raise self.poll_error
        return self.get_transaction(tx_hash)

    def confirm(self, tx_hash: str, ledger: int = 100) -> None:
        self.transactions[tx_hash] = SimpleNamespace(
            status=GetTransactionStatus.SUCCESS, ledger=ledger, latest_ledger=100
        )

    def event(
        self, contract_id: str, tx_hash: str, symbol: str, agreement_id: int,
        third, value: str,
    ) -> None:
        topic = [_symbol(symbol), _u32(agreement_id)]
        topic.append(_address(third) if isinstance(third, str) and third.startswith("G") else _u32(int(third)))
        self.events.setdefault(contract_id, []).append(
            {
                "topic": topic,
                "value": value,
                "transaction_hash": tx_hash,
                "ledger": 100,
            }
        )


@pytest.fixture
def rpc(monkeypatch):
    server = FakeSorobanRPC()
    monkeypatch.setattr(stellar, "soroban_server", lambda: server)
    return server


def _asset_contract(code: str = "XLM", issuer: str | None = None) -> str:
    return Asset(code, issuer).contract_id(PASSPHRASE) if code != "XLM" else Asset.native().contract_id(PASSPHRASE)


def _agreement(client, owner, total: str = "100", milestones=None) -> dict:
    supplier = create_supplier(client, owner)
    body = {
        "supplier_id": supplier["id"],
        "title": "Closure test agreement",
        "total_amount": total,
        "asset_code": "XLM",
        "expiry_date": "2030-12-31T00:00:00",
        "milestones": milestones or [{"description": "M1", "amount": total}],
    }
    response = client.post("/api/v1/agreements", headers=owner.headers, json=body)
    assert response.status_code == 201, response.text
    agreement = response.json()
    client.post(f"/api/v1/agreements/{agreement['id']}/submit", headers=owner.headers)
    db = TestSession()
    try:
        row = db.get(models.PaymentAgreement, agreement["id"])
        row.status = "active"
        db.commit()
    finally:
        db.close()
    return agreement


def _bind(client, owner, agreement_id: str, contract_id: str, source: str):
    return client.post(
        f"/api/v1/agreements/{agreement_id}/bind-contract",
        headers=owner.headers,
        json={"escrow_contract_id": contract_id, "source_account": source},
    )


def _prepare(client, owner, agreement_id: str, source: str, amount: str | None = None, **extra):
    body = {"source_account": source, **extra}
    if amount is not None:
        body["amount"] = amount
    return client.post(
        f"/api/v1/agreements/{agreement_id}/prepare-fund",
        headers=owner.headers, json=body,
    )


def _sign(xdr: str, signer: Keypair) -> str:
    envelope = TransactionBuilder.from_xdr(xdr, PASSPHRASE)
    envelope.sign(signer)
    return envelope.to_xdr()


def _detail(client, owner, agreement_id: str) -> dict:
    return client.get(
        f"/api/v1/agreements/{agreement_id}", headers=owner.headers
    ).json()


# --- binding derives identity server-side -----------------------------------

def test_binding_derives_id_from_getter_and_is_idempotent(client, owner, rpc):
    agreement = _agreement(client, owner, "10")
    rpc.contracts[CONTRACT_A] = _contract_state(
        42, PAYER_A.public_key, asset=_asset_contract(), total=100000000,
        milestone_count=1,
    )
    first = _bind(client, owner, agreement["id"], CONTRACT_A, PAYER_A.public_key)
    assert first.status_code == 200, first.text
    assert first.json()["onchain_agreement_id"] == 42
    assert first.json()["escrow_contract_id"] == CONTRACT_A
    again = _bind(client, owner, agreement["id"], CONTRACT_A, PAYER_A.public_key)
    assert again.status_code == 200
    assert again.json()["onchain_agreement_id"] == 42
    db = TestSession()
    try:
        assert db.scalar(
            __import__("sqlalchemy").select(models.AuditLog).where(
                models.AuditLog.action == "agreement.contract_bound"
            )
        ) is not None
        db.commit()
    finally:
        db.close()


def test_binding_rejects_getter_mismatch_without_writing(client, owner, rpc):
    agreement = _agreement(client, owner, "10")
    rpc.contracts[CONTRACT_A] = _contract_state(
        42, PAYER_A.public_key, asset=_asset_contract(), total=999999999,
        milestone_count=1,
    )
    response = _bind(client, owner, agreement["id"], CONTRACT_A, PAYER_A.public_key)
    assert response.status_code == 409
    assert response.json()["code"] == "CONTRACT_STATE_MISMATCH"
    detail = _detail(client, owner, agreement["id"])
    assert detail["onchain_agreement_id"] is None
    assert detail["escrow_contract_id"] is None


def test_binding_rejects_wrong_payer_and_rpc_timeout(client, owner, rpc):
    agreement = _agreement(client, owner, "10")
    rpc.contracts[CONTRACT_A] = _contract_state(
        42, PAYER_B.public_key, asset=_asset_contract(), total=100000000,
        milestone_count=1,
    )
    wrong = _bind(client, owner, agreement["id"], CONTRACT_A, PAYER_A.public_key)
    assert wrong.status_code == 409
    assert wrong.json()["code"] == "CONTRACT_STATE_MISMATCH"

    rpc.simulate_error = TimeoutError("rpc timeout")
    failed = _bind(client, owner, agreement["id"], CONTRACT_A, PAYER_A.public_key)
    assert failed.status_code == 409
    assert failed.json()["code"] == "CONTRACT_STATE_READ_FAILED"
    assert _detail(client, owner, agreement["id"])["onchain_agreement_id"] is None


def test_client_cannot_override_binding(client, owner, rpc):
    agreement = _agreement(client, owner, "10")
    rpc.contracts[CONTRACT_A] = _contract_state(
        42, PAYER_A.public_key, asset=_asset_contract(), total=100000000,
        milestone_count=1,
    )
    assert _bind(client, owner, agreement["id"], CONTRACT_A, PAYER_A.public_key).status_code == 200
    wrong_contract = _prepare(client, owner, agreement["id"], PAYER_A.public_key, escrow_contract_id=CONTRACT_B)
    assert wrong_contract.status_code == 400
    assert wrong_contract.json()["code"] == "CONTRACT_MISMATCH"
    wrong_id = _prepare(client, owner, agreement["id"], PAYER_A.public_key, onchain_agreement_id=43)
    assert wrong_id.status_code == 400
    assert wrong_id.json()["code"] == "ONCHAIN_ID_READ_ONLY"
    assert _detail(client, owner, agreement["id"])["onchain_agreement_id"] == 42


# --- two contracts / two agreements isolation -------------------------------

def _two_bound_agreements(client, owner, rpc):
    first = _agreement(client, owner, "10")
    second = _agreement(client, owner, "20")
    rpc.contracts[CONTRACT_A] = _contract_state(
        42, PAYER_A.public_key, asset=_asset_contract(), total=100000000,
        milestone_count=1,
    )
    rpc.contracts[CONTRACT_B] = _contract_state(
        77, PAYER_B.public_key, asset=_asset_contract(), total=200000000,
        milestone_count=1,
    )
    assert _bind(client, owner, first["id"], CONTRACT_A, PAYER_A.public_key).status_code == 200
    assert _bind(client, owner, second["id"], CONTRACT_B, PAYER_B.public_key).status_code == 200
    return first, second


def test_agreement_a_cannot_fund_or_release_agreement_b(client, owner, rpc, monkeypatch):
    from app.services import verification as verifier

    first, second = _two_bound_agreements(client, owner, rpc)
    prepared = _prepare(client, owner, first["id"], PAYER_A.public_key, amount="10")
    assert prepared.status_code == 200, prepared.text
    tx_hash = prepared.json()["hash"]
    rpc.confirm(tx_hash)
    rpc.event(
        CONTRACT_A, tx_hash, "funded", 42, PAYER_A.public_key,
        scval.to_vec([scval.to_int128(100000000), scval.to_int128(100000000)]).to_xdr(),
    )
    signed = _sign(prepared.json()["xdr"], PAYER_A)
    funded = client.post(
        f"/api/v1/agreements/{first['id']}/fund-escrow",
        headers=owner.headers, json={"signed_xdr": signed},
    )
    assert funded.status_code == 200, funded.text
    assert _detail(client, owner, second["id"])["fund_transaction_hash"] is None

    # Reusing A's funded transaction xdr against B cannot settle B: the signed
    # contract id and the getter's agreement id both differ from B's binding.
    monkeypatch.setattr(stellar, "transaction_hash", lambda _xdr: tx_hash)
    cross = client.post(
        f"/api/v1/agreements/{second['id']}/fund-escrow",
        headers=owner.headers, json={"signed_xdr": signed},
    )
    assert cross.status_code in (400, 409)
    assert cross.json()["code"] in ("CONTRACT_MISMATCH", "DUPLICATE_HASH", "CONTRACT_IN_USE")
    assert _detail(client, owner, second["id"])["fund_transaction_hash"] is None

    # A's event cannot be presented as B's: topic[1] is positional.
    monkeypatch.setattr(stellar.time, "sleep", lambda *_: None)
    bad = verifier.verify_soroban_funding(
        tx_hash, CONTRACT_A, Decimal("10"), agreement_id="77", payer=PAYER_B.public_key
    )
    assert not bad.settled


def test_wrong_amount_or_payer_event_fails_and_opens_reconciliation(client, owner, rpc):
    from sqlalchemy import select

    agreement = _agreement(client, owner, "10")
    rpc.contracts[CONTRACT_A] = _contract_state(
        42, PAYER_A.public_key, asset=_asset_contract(), total=100000000,
        milestone_count=1,
    )
    assert _bind(client, owner, agreement["id"], CONTRACT_A, PAYER_A.public_key).status_code == 200
    prepared = _prepare(client, owner, agreement["id"], PAYER_A.public_key, amount="10")
    assert prepared.status_code == 200, prepared.text
    tx_hash = prepared.json()["hash"]
    rpc.confirm(tx_hash)
    rpc.event(
        CONTRACT_A, tx_hash, "funded", 42, PAYER_B.public_key,
        scval.to_vec([scval.to_int128(50000000), scval.to_int128(50000000)]).to_xdr(),
    )
    rejected = client.post(
        f"/api/v1/agreements/{agreement['id']}/fund-escrow",
        headers=owner.headers, json={"signed_xdr": _sign(prepared.json()["xdr"], PAYER_A)},
    )
    assert rejected.status_code == 409
    assert rejected.json()["code"] == "UNVERIFIED_EVENT"
    db = TestSession()
    try:
        row = db.scalar(
            select(models.ReconciliationRecord).where(
                models.ReconciliationRecord.agreement_id == agreement["id"]
            )
        )
        assert row is not None and row.resolution_status == "open"
        assert row.discrepancy and "UNVERIFIED_FUNDED_EVENT" in row.discrepancy[0]
        assert db.scalar(
            select(models.AuditLog).where(
                models.AuditLog.action == "agreement.reconciliation_opened"
            )
        ) is not None
        assert db.get(models.PaymentAgreement, agreement["id"]).fund_transaction_hash is None
        db.commit()
    finally:
        db.close()
    cancelled = client.post(
        f"/api/v1/agreements/{agreement['id']}/cancel", headers=owner.headers
    )
    assert cancelled.status_code == 409
    assert cancelled.json()["code"] == "RECONCILIATION_OPEN"


def test_correct_funding_event_and_approval_amount(client, owner, rpc):
    from sqlalchemy import select

    agreement = _agreement(client, owner, "10")
    rpc.contracts[CONTRACT_A] = _contract_state(
        42, PAYER_A.public_key, asset=_asset_contract(), total=100000000,
        milestone_count=1,
    )
    assert _bind(client, owner, agreement["id"], CONTRACT_A, PAYER_A.public_key).status_code == 200
    prepared = _prepare(client, owner, agreement["id"], PAYER_A.public_key, amount="10")
    tx_hash = prepared.json()["hash"]
    rpc.confirm(tx_hash)
    rpc.event(
        CONTRACT_A, tx_hash, "funded", 42, PAYER_A.public_key,
        scval.to_vec([scval.to_int128(100000000), scval.to_int128(100000000)]).to_xdr(),
    )
    assert client.post(
        f"/api/v1/agreements/{agreement['id']}/fund-escrow",
        headers=owner.headers, json={"signed_xdr": _sign(prepared.json()["xdr"], PAYER_A)},
    ).status_code == 200

    milestones = client.get(
        f"/api/v1/agreements/{agreement['id']}/milestones", headers=owner.headers
    ).json()
    approval = client.post(
        f"/api/v1/agreements/{agreement['id']}/milestones/{milestones[0]['id']}/prepare-approve",
        headers=owner.headers, json={"source_account": PAYER_A.public_key},
    )
    assert approval.status_code == 200, approval.text
    approve_hash = approval.json()["hash"]
    rpc.confirm(approve_hash)
    rpc.event(CONTRACT_A, approve_hash, "approved", 42, 0, _i128(99999999))
    rejected = client.post(
        f"/api/v1/agreements/{agreement['id']}/milestones/{milestones[0]['id']}/approve",
        headers=owner.headers, json={"signed_xdr": _sign(approval.json()["xdr"], PAYER_A)},
    )
    assert rejected.status_code == 409
    assert rejected.json()["code"] == "UNVERIFIED_EVENT"
    db = TestSession()
    try:
        assert db.scalar(
            select(models.ReconciliationRecord).where(
                models.ReconciliationRecord.agreement_id == agreement["id"]
            )
        ) is not None
        db.commit()
    finally:
        db.close()


# --- submission and network fail-closed -------------------------------------

def test_submit_soroban_requires_single_operation_and_ledger(monkeypatch):
    builder = TransactionBuilder(
        Account(PAYER_A.public_key, 1), network_passphrase=PASSPHRASE, base_fee=100
    )
    builder.append_invoke_contract_function_op(
        contract_id=CONTRACT_A, function_name="refund",
        parameters=[scval.to_address(PAYER_A.public_key)],
    )
    builder.append_payment_op(
        destination=PAYER_B.public_key, asset=Asset.native(), amount="1"
    )
    builder.set_timeout(600)
    envelope = builder.build()
    envelope.sign(PAYER_A)
    with pytest.raises(BizError) as exc:
        stellar.submit_soroban(envelope.to_xdr())
    assert exc.value.code == "INVALID_OPERATION_COUNT"

    builder = TransactionBuilder(
        Account(PAYER_A.public_key, 1), network_passphrase=PASSPHRASE, base_fee=100
    )
    builder.append_invoke_contract_function_op(
        contract_id=CONTRACT_A, function_name="refund",
        parameters=[scval.to_address(PAYER_A.public_key)],
    )
    builder.set_timeout(600)
    envelope = builder.build()
    envelope.sign(PAYER_A)
    signed = envelope.to_xdr()

    class NoLedger:
        def send_transaction(self, _xdr):
            return None

        def poll_transaction(self, _hash, max_attempts=20):
            return SimpleNamespace(
                status=GetTransactionStatus.SUCCESS, ledger=None, latest_ledger=100
            )

    monkeypatch.setattr(stellar, "soroban_server", lambda: NoLedger())
    result = stellar.submit_soroban(
        signed, CONTRACT_A, "refund", expected_parameters=[PAYER_A.public_key]
    )
    assert not result.confirmed and not result.successful
    assert result.reason and "ledger" in result.reason


def test_wrong_network_fails_closed(client, owner, rpc, monkeypatch):
    agreement = _agreement(client, owner, "10")
    rpc.contracts[CONTRACT_A] = _contract_state(
        42, PAYER_A.public_key, asset=_asset_contract(), total=100000000,
        milestone_count=1,
    )
    assert _bind(client, owner, agreement["id"], CONTRACT_A, PAYER_A.public_key).status_code == 200
    monkeypatch.setattr(
        stellar.settings, "stellar_network_passphrase", "Public Global Stellar Network ; September 2015"
    )
    with pytest.raises(BizError) as exc:
        verification.verify_soroban_event("a" * 64, CONTRACT_A, "funded")
    assert exc.value.code == "NETWORK_MISMATCH"
    with pytest.raises(BizError):
        stellar.network_name()


def test_settlement_fails_closed_when_getter_state_is_missing(client, owner, rpc):
    agreement = _agreement(client, owner, "10")
    # Bind against a valid getter, then simulate state disappearing (expired TTL).
    rpc.contracts[CONTRACT_A] = _contract_state(
        42, PAYER_A.public_key, asset=_asset_contract(), total=100000000,
        milestone_count=1,
    )
    assert _bind(client, owner, agreement["id"], CONTRACT_A, PAYER_A.public_key).status_code == 200
    prepared = _prepare(client, owner, agreement["id"], PAYER_A.public_key, amount="10")
    assert prepared.status_code == 200
    tx_hash = prepared.json()["hash"]
    rpc.confirm(tx_hash)
    rpc.event(
        CONTRACT_A, tx_hash, "funded", 42, PAYER_A.public_key,
        scval.to_vec([scval.to_int128(100000000), scval.to_int128(100000000)]).to_xdr(),
    )
    rpc.contracts.pop(CONTRACT_A)
    failed = client.post(
        f"/api/v1/agreements/{agreement['id']}/fund-escrow",
        headers=owner.headers, json={"signed_xdr": _sign(prepared.json()["xdr"], PAYER_A)},
    )
    assert failed.status_code == 502
    assert failed.json()["code"] == "CONTRACT_STATE_READ_FAILED"
    assert _detail(client, owner, agreement["id"])["fund_transaction_hash"] is None


# --- reconciliation covers more than balances --------------------------------

def test_reconciliation_reports_identity_events_and_payment_associations(client, owner, rpc):
    from datetime import datetime, timedelta, timezone

    agreement = _agreement(client, owner, "10")
    rpc.contracts[CONTRACT_A] = _contract_state(
        42, PAYER_A.public_key, asset=_asset_contract(), total=100000000,
        milestone_count=1,
    )
    assert _bind(client, owner, agreement["id"], CONTRACT_A, PAYER_A.public_key).status_code == 200
    tx_hash = "c" * 64
    db = TestSession()
    try:
        row = db.get(models.PaymentAgreement, agreement["id"])
        row.fund_transaction_hash = tx_hash
        row.funded_amount = Decimal("10")
        db.add(
            models.PaymentRecord(
                business_id=owner.business_id, agreement_id=agreement["id"],
                kind="escrow_fund", amount=Decimal("10"), asset_code="XLM",
                xdr="xdr", hash=tx_hash, status="confirmed",
                confirmed_at=datetime.now(timezone.utc),
            )
        )
        db.commit()
    finally:
        db.close()
    rpc.event(
        CONTRACT_A, tx_hash, "funded", 99, PAYER_A.public_key,
        scval.to_vec([scval.to_int128(100000000), scval.to_int128(100000000)]).to_xdr(),
    )
    rpc.events_error = RuntimeError("indexer offline")
    db = TestSession()
    try:
        row = db.get(models.PaymentAgreement, agreement["id"])
        report = reconciliation.reconcile_agreement(
            db, row, source_account=PAYER_A.public_key
        )
    finally:
        db.close()
    data = report.as_dict()
    assert "CONFIRMED_PAYMENT_WITHOUT_VERIFIED_TX" in data["discrepancies"]
    assert "ONCHAIN_EVENTS_READ_FAILED" in data["discrepancies"]
    assert data["payments"]

    rpc.events_error = None
    db = TestSession()
    try:
        row = db.get(models.PaymentAgreement, agreement["id"])
        report = reconciliation.reconcile_agreement(
            db, row, source_account=PAYER_A.public_key
        )
    finally:
        db.close()
    data = report.as_dict()
    assert "WRONG_AGREEMENT_EVENT_ASSOCIATION" in data["discrepancies"]
    assert data["contract_agreement"]["agreement_id"] == 42
    assert data["milestones"] == []
