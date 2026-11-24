"""Coverage for escrow-refund preparation, validation and settlement."""

from __future__ import annotations

from datetime import datetime, timezone
from decimal import Decimal

from stellar_sdk import Keypair

from app import models
from app.config import get_settings
from app.services import stellar, verification
from app.utils import utcnow
from tests.conftest import TestSession, create_supplier

CONTRACT_ID = get_settings().stellar_escrow_contract_id
HASH = "9" * 64


def _agreement(client, owner):
    supplier = create_supplier(client, owner)
    response = client.post(
        "/api/v1/agreements",
        headers=owner.headers,
        json={
            "supplier_id": supplier["id"], "title": "Work", "total_amount": "100",
            "asset_code": "XLM", "expiry_date": "2030-12-31T00:00:00",
            "milestones": [{"description": "A", "amount": "100"}],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def _fund(db, agreement_id, *, amount="100", onchain_id=1, hash_value=HASH):
    agreement = db.get(models.PaymentAgreement, agreement_id)
    agreement.status = "active"
    agreement.fund_transaction_hash = hash_value
    agreement.funded_amount = Decimal(amount)
    agreement.onchain_agreement_id = onchain_id
    agreement.escrow_contract_id = CONTRACT_ID
    db.commit()


def _result(settled=True, reason=None):
    return verification.VerificationResult(
        hash=HASH, confirmed=True, successful=True, settled=settled, status="SUCCESS",
        ledger=10, source_account=None, destination_account=CONTRACT_ID, asset_code=None,
        asset_issuer=None, amount=Decimal("100"), memo=None, network="testnet",
        event_matched=settled, checked_at=datetime.now(timezone.utc), reason=reason,
    )


def test_prepare_refund_rejects_invalid_states(client, owner, monkeypatch):
    draft = _agreement(client, owner)
    path = f"/api/v1/agreements/{draft['id']}/prepare-refund"
    body = {"source_account": Keypair.random().public_key}
    assert client.post(path, headers=owner.headers, json=body).json()["code"] == "AGREEMENT_STATE"

    db = TestSession()
    try:
        _fund(db, draft["id"])
        db.get(models.PaymentAgreement, draft["id"]).fund_transaction_hash = None
        db.commit()
    finally:
        db.close()
    assert client.post(path, headers=owner.headers, json=body).json()["code"] == "NOT_FUNDED"

    db = TestSession()
    try:
        _fund(db, draft["id"])
        milestone = db.scalar(
            models.AgreementMilestone.__table__.select().where(
                models.AgreementMilestone.agreement_id == draft["id"]
            )
        )
    finally:
        db.close()
    # Mark the milestone released directly, then expect MILESTONE_RELEASED.
    db = TestSession()
    try:
        rows = db.query(models.AgreementMilestone).filter_by(agreement_id=draft["id"]).all()
        rows[0].status = "released"
        db.commit()
    finally:
        db.close()
    assert client.post(path, headers=owner.headers, json=body).json()["code"] == "MILESTONE_RELEASED"

    db = TestSession()
    try:
        db.query(models.AgreementMilestone).filter_by(agreement_id=draft["id"]).update({"status": "pending"})
        db.get(models.PaymentAgreement, draft["id"]).funded_amount = Decimal("0")
        db.commit()
    finally:
        db.close()
    assert client.post(path, headers=owner.headers, json=body).json()["code"] == "NO_BALANCE"

    db = TestSession()
    try:
        _fund(db, draft["id"], onchain_id=None)
    finally:
        db.close()
    assert client.post(path, headers=owner.headers, json=body).json()["code"] == "NO_ONCHAIN_ID"


def test_prepare_and_submit_refund_success_and_rejections(client, owner, monkeypatch):
    agreement = _agreement(client, owner)
    db = TestSession()
    try:
        _fund(db, agreement["id"])
    finally:
        db.close()
    monkeypatch.setattr(
        stellar, "build_soroban_refund_xdr",
        lambda *a, **k: stellar.PreparedTransaction(xdr="AAAA-refund", hash=HASH),
    )
    prepared = client.post(
        f"/api/v1/agreements/{agreement['id']}/prepare-refund",
        headers=owner.headers, json={"source_account": Keypair.random().public_key},
    )
    assert prepared.status_code == 200, prepared.text
    submit_path = f"/api/v1/agreements/{agreement['id']}/refund"
    monkeypatch.setattr(stellar, "transaction_hash", lambda _xdr: HASH)

    # Confirm a submitted refund fails when the ledger does not confirm it.
    monkeypatch.setattr(
        stellar, "submit_soroban",
        lambda *a, **k: stellar.ChainResult(
            hash=HASH, status="FAILED", confirmed=False, successful=False, reason="rpc declined"
        ),
    )
    unconfirmed = client.post(submit_path, headers=owner.headers, json={"signed_xdr": "AAAA-refund"})
    assert unconfirmed.status_code == 409 and unconfirmed.json()["code"] == "UNCONFIRMED_TX"

    db = TestSession()
    try:
        payment = db.query(models.PaymentRecord).filter_by(kind="escrow_refund").one()
        payment.status = "prepared"
        payment.failure_reason = None
        db.commit()
    finally:
        db.close()

    monkeypatch.setattr(
        stellar, "submit_soroban",
        lambda *a, **k: stellar.ChainResult(hash=HASH, status="SUCCESS", confirmed=True, successful=True),
    )
    monkeypatch.setattr(verification, "verify_soroban_refund", lambda *a, **k: _result(settled=False, reason="no event"))
    unverified = client.post(submit_path, headers=owner.headers, json={"signed_xdr": "AAAA-refund"})
    assert unverified.status_code == 409 and unverified.json()["code"] == "UNVERIFIED_EVENT"

    db = TestSession()
    try:
        payment = db.query(models.PaymentRecord).filter_by(kind="escrow_refund").one()
        payment.status = "prepared"
        payment.failure_reason = None
        db.commit()
    finally:
        db.close()

    monkeypatch.setattr(verification, "verify_soroban_refund", lambda *a, **k: _result())
    settled = client.post(submit_path, headers=owner.headers, json={"signed_xdr": "AAAA-refund"})
    assert settled.status_code == 200, settled.text
    assert settled.json()["status"] == "refunded"


def test_refund_rejects_expired_and_already_confirmed(client, owner, monkeypatch):
    agreement = _agreement(client, owner)
    db = TestSession()
    try:
        _fund(db, agreement["id"])
    finally:
        db.close()
    monkeypatch.setattr(
        stellar, "build_soroban_refund_xdr",
        lambda *a, **k: stellar.PreparedTransaction(xdr="AAAA-refund", hash=HASH),
    )
    assert client.post(
        f"/api/v1/agreements/{agreement['id']}/prepare-refund", headers=owner.headers,
        json={"source_account": Keypair.random().public_key},
    ).status_code == 200
    monkeypatch.setattr(stellar, "transaction_hash", lambda _xdr: HASH)
    monkeypatch.setattr(
        stellar, "submit_soroban",
        lambda *a, **k: stellar.ChainResult(hash=HASH, status="SUCCESS", confirmed=True, successful=True),
    )
    monkeypatch.setattr(verification, "verify_soroban_refund", lambda *a, **k: _result())

    db = TestSession()
    try:
        db.query(models.PaymentRecord).filter_by(kind="escrow_refund").one().expires_at = utcnow() - __import__("datetime").timedelta(seconds=1)
        db.commit()
    finally:
        db.close()
    expired = client.post(
        f"/api/v1/agreements/{agreement['id']}/refund", headers=owner.headers,
        json={"signed_xdr": "AAAA-refund"},
    )
    assert expired.status_code == 409 and expired.json()["code"] == "EXPIRED_XDR"

    db = TestSession()
    try:
        payment = db.query(models.PaymentRecord).filter_by(kind="escrow_refund").one()
        payment.status = "confirmed"
        db.commit()
    finally:
        db.close()
    confirmed = client.post(
        f"/api/v1/agreements/{agreement['id']}/refund", headers=owner.headers,
        json={"signed_xdr": "AAAA-refund"},
    )
    assert confirmed.status_code == 409 and confirmed.json()["code"] == "ALREADY_REFUNDED"
