"""Agreement state machine, funding and Soroban milestone release tests."""

from __future__ import annotations

from datetime import datetime, timezone

import pytest

from app.config import get_settings
from app import models
from app.services import stellar, verification
from tests.conftest import TestSession, create_supplier

CONTRACT_ID = get_settings().stellar_escrow_contract_id


@pytest.fixture(autouse=True)
def _stub_contract_identity(monkeypatch):
    """These tests stub the chain at the event layer; identity reads are covered in test_closure_blockchain."""
    from app.services import reconciliation

    monkeypatch.setattr(reconciliation, "assert_contract_identity", lambda *a, **k: {})


def _set_onchain_id(agreement_id: str, value: int = 1) -> None:
    db = TestSession()
    try:
        row = db.get(models.PaymentAgreement, agreement_id)
        row.onchain_agreement_id = value
        row.escrow_contract_id = CONTRACT_ID
        db.commit()
    finally:
        db.close()


def _verifiable_horizon(agreement, fake_horizon, amount: str) -> None:
    """Bind the fake Horizon payment to the configured escrow contract/memo."""
    fake_horizon.destination = CONTRACT_ID
    fake_horizon.amount = amount
    fake_horizon.memo = agreement["reference"]


HASH = "f" * 64
RELEASE_HASH = "b" * 64


def _agreement_body(supplier_id: str, total: str = "100.00", milestones=None):
    return {
        "supplier_id": supplier_id,
        "title": "Phase 1 delivery",
        "description": "Two milestones",
        "total_amount": total,
        "asset_code": "XLM",
        "expiry_date": "2030-12-31T00:00:00",
        "milestones": milestones
        or [
            {"description": "Design", "amount": "40.00"},
            {"description": "Build", "amount": "60.00"},
        ],
    }


def _create(client, owner, supplier_id):
    response = client.post(
        "/api/v1/agreements", headers=owner.headers, json=_agreement_body(supplier_id)
    )
    assert response.status_code == 201, response.text
    return response.json()


def test_create_agreement_with_milestones(client, owner):
    supplier = create_supplier(client, owner)
    agreement = _create(client, owner, supplier["id"])
    assert agreement["reference"].startswith("AGR-")
    assert agreement["status"] == "draft"
    assert len(agreement["milestones"]) == 2
    assert agreement["total_amount"] == "100"
    assert agreement["milestones"][0]["sort_order"] == 0


def test_milestone_sum_must_equal_total(client, owner):
    supplier = create_supplier(client, owner)
    response = client.post(
        "/api/v1/agreements",
        headers=owner.headers,
        json=_agreement_body(
            supplier["id"], milestones=[{"description": "Only", "amount": "10.00"}]
        ),
    )
    assert response.status_code == 422


def test_submit_and_supplier_accept(client, owner, supplier_actor):
    supplier = create_supplier(client, owner, email=supplier_actor.email)
    agreement = _create(client, owner, supplier["id"])
    submitted = client.post(
        f"/api/v1/agreements/{agreement['id']}/submit", headers=owner.headers
    )
    assert submitted.json()["status"] == "awaiting_acceptance"
    accepted = client.post(
        f"/api/v1/agreements/{agreement['id']}/accept", headers=supplier_actor.headers
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "active"
    assert accepted.json()["accepted_at"] is not None


def test_owner_cannot_accept_and_unlinked_supplier_cannot(client, owner, supplier_actor):
    supplier = create_supplier(client, owner, email=supplier_actor.email)
    agreement = _create(client, owner, supplier["id"])
    client.post(f"/api/v1/agreements/{agreement['id']}/submit", headers=owner.headers)
    denied = client.post(
        f"/api/v1/agreements/{agreement['id']}/accept", headers=owner.headers
    )
    assert denied.status_code == 403
    other_agreement = _create(client, owner, create_supplier(client, owner)["id"])
    client.post(f"/api/v1/agreements/{other_agreement['id']}/submit", headers=owner.headers)
    unlinked = client.post(
        f"/api/v1/agreements/{other_agreement['id']}/accept", headers=supplier_actor.headers
    )
    assert unlinked.status_code == 403


def test_cancel_records_reason_and_dispute(client, owner, supplier_actor):
    supplier = create_supplier(client, owner, email=supplier_actor.email)
    agreement = _create(client, owner, supplier["id"])
    cancelled = client.post(
        f"/api/v1/agreements/{agreement['id']}/cancel",
        headers=owner.headers,
        json={"reason": "Budget revoked"},
    )
    assert cancelled.status_code == 200
    assert cancelled.json()["cancellation_reason"] == "Budget revoked"
    active = _create(client, owner, supplier["id"])
    client.post(f"/api/v1/agreements/{active['id']}/submit", headers=owner.headers)
    client.post(f"/api/v1/agreements/{active['id']}/accept", headers=supplier_actor.headers)
    disputed = client.post(
        f"/api/v1/agreements/{active['id']}/dispute", headers=supplier_actor.headers
    )
    assert disputed.json()["status"] == "disputed"


def test_fund_requires_verified_transaction(client, owner, supplier_actor, fake_horizon):
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination, email=supplier_actor.email)
    agreement = _create(client, owner, supplier["id"])
    client.post(f"/api/v1/agreements/{agreement['id']}/submit", headers=owner.headers)
    assert client.post(
        f"/api/v1/agreements/{agreement['id']}/accept", headers=supplier_actor.headers
    ).status_code == 200
    _set_onchain_id(agreement["id"])
    _verifiable_horizon(agreement, fake_horizon, "100.0000000")
    response = client.post(
        f"/api/v1/agreements/{agreement['id']}/fund",
        headers=owner.headers,
        json={"transaction_hash": HASH, "funded_amount": "100.00"},
    )
    assert response.status_code == 200, response.text
    assert response.json()["funded_amount"] == "100"
    assert response.json()["escrow_contract_id"]
    again = client.post(
        f"/api/v1/agreements/{agreement['id']}/fund",
        headers=owner.headers,
        json={"transaction_hash": "a" * 64, "funded_amount": "100.00"},
    )
    assert again.status_code == 409


def test_milestone_prepare_and_release_completes_agreement(client, owner, supplier_actor, fake_horizon, monkeypatch):
    supplier = create_supplier(
        client, owner, email=supplier_actor.email, wallet=fake_horizon.destination
    )
    agreement = _create(client, owner, supplier["id"])
    client.post(f"/api/v1/agreements/{agreement['id']}/submit", headers=owner.headers)
    client.post(f"/api/v1/agreements/{agreement['id']}/accept", headers=supplier_actor.headers)
    _set_onchain_id(agreement["id"])
    _verifiable_horizon(agreement, fake_horizon, "100.0000000")
    assert client.post(
        f"/api/v1/agreements/{agreement['id']}/fund",
        headers=owner.headers,
        json={"transaction_hash": HASH, "funded_amount": "100.00"},
    ).status_code == 200

    milestones = client.get(
        f"/api/v1/agreements/{agreement['id']}/milestones", headers=owner.headers
    ).json()
    # On-chain approval must precede release; mock only the RPC boundary.
    APPROVE_HASH = "a" * 64
    monkeypatch.setattr(
        stellar, "build_soroban_approve_xdr",
        lambda *a, **kwargs: stellar.PreparedTransaction(xdr="AAAA-approve", hash=APPROVE_HASH),
    )
    monkeypatch.setattr(
        stellar, "transaction_hash",
        lambda xdr: APPROVE_HASH if xdr == "AAAA-approve" else RELEASE_HASH,
    )
    monkeypatch.setattr(
        stellar, "submit_soroban",
        lambda xdr, contract_id=None, function_name=None, **kwargs: stellar.ChainResult(
            hash=APPROVE_HASH if xdr == "AAAA-approve" else RELEASE_HASH,
            status="SUCCESS", confirmed=True, successful=True, ledger=10,
        ),
    )
    verified_result = verification.VerificationResult(
        hash=APPROVE_HASH, confirmed=True, successful=True, settled=True,
        status="SUCCESS", ledger=10, source_account=None, destination_account="C",
        asset_code=None, asset_issuer=None, amount=None, memo=None, network="testnet",
        contract_id="C", event_matched=True, checked_at=datetime.now(timezone.utc),
    )
    monkeypatch.setattr(verification, "verify_soroban_approval", lambda *a, **k: verified_result)
    milestone_path = f"/api/v1/agreements/{agreement['id']}/milestones/{milestones[0]['id']}"
    approval_prepared = client.post(
        f"{milestone_path}/prepare-approve",
        headers=owner.headers,
        json={},
    )
    assert approval_prepared.status_code == 200, approval_prepared.text
    approved = client.post(
        f"{milestone_path}/approve",
        headers=owner.headers,
        json={"signed_xdr": "AAAA-approve"},
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["milestones"][0]["status"] == "approved"

    monkeypatch.setattr(
        stellar,
        "build_soroban_release_xdr",
        lambda **kwargs: stellar.PreparedTransaction(xdr="AAAA-prepared", hash=RELEASE_HASH),
    )
    prepared = client.post(
        f"/api/v1/agreements/{agreement['id']}/milestones/{milestones[0]['id']}/prepare-release",
        headers=owner.headers,
        json={},
    )
    assert prepared.status_code == 200, prepared.text
    assert prepared.json()["hash"] == RELEASE_HASH
    assert prepared.json()["payment_id"]

    monkeypatch.setattr(
        stellar, "transaction_hash", lambda xdr: RELEASE_HASH
    )
    monkeypatch.setattr(
        stellar,
        "submit_soroban",
        lambda xdr, contract_id=None, function_name=None, **kwargs: stellar.ChainResult(
            hash=RELEASE_HASH, status="SUCCESS", confirmed=True, successful=True, ledger=10
        ),
    )
    monkeypatch.setattr(
        verification,
        "verify_soroban_release",
        lambda *args, **kwargs: verification.VerificationResult(
            hash=RELEASE_HASH, confirmed=True, successful=True, settled=True,
            status="SUCCESS", ledger=10, source_account=None, destination_account="C",
            asset_code=None, asset_issuer=None, amount=None, memo=None, network="testnet",
            contract_id="C", event_matched=True, checked_at=datetime.now(timezone.utc),
        ),
    )
    released = client.post(
        f"/api/v1/agreements/{agreement['id']}/milestones/{milestones[0]['id']}/release",
        headers=owner.headers,
        json={"signed_xdr": "AAAA-signed"},
    )
    assert released.status_code == 200, released.text
    assert released.json()["milestones"][0]["status"] == "released"
    assert released.json()["funded_amount"] == "100"
    events = client.get(
        f"/api/v1/agreements/{agreement['id']}/events", headers=owner.headers
    )
    assert events.status_code == 200
    assert any(item["source"] == "audit" for item in events.json())


def test_supplier_can_reject_and_expired_agreement_cannot_be_submitted(client, owner, supplier_actor):
    supplier = create_supplier(client, owner, email=supplier_actor.email)
    agreement = _create(client, owner, supplier["id"])
    client.post(f"/api/v1/agreements/{agreement['id']}/submit", headers=owner.headers)
    rejected = client.post(
        f"/api/v1/agreements/{agreement['id']}/reject",
        headers=supplier_actor.headers,
        json={"reason": "Scope is unclear"},
    )
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["status"] == "cancelled"
    assert "Rejected by supplier" in rejected.json()["cancellation_reason"]

    expired = _create(client, owner, supplier["id"])
    client.patch(
        f"/api/v1/agreements/{expired['id']}",
        headers=owner.headers,
        json={"expiry_date": "2000-01-01T00:00:00"},
    )
    submitted = client.post(
        f"/api/v1/agreements/{expired['id']}/submit", headers=owner.headers
    )
    assert submitted.status_code == 400
    assert submitted.json()["code"] == "AGREEMENT_EXPIRED"


def test_release_requires_onchain_approval(client, owner, supplier_actor, fake_horizon, monkeypatch):
    supplier = create_supplier(client, owner, email=supplier_actor.email, wallet=fake_horizon.destination)
    agreement = _create(client, owner, supplier["id"])
    client.post(f"/api/v1/agreements/{agreement['id']}/submit", headers=owner.headers)
    client.post(f"/api/v1/agreements/{agreement['id']}/accept", headers=supplier_actor.headers)
    _set_onchain_id(agreement["id"])
    _verifiable_horizon(agreement, fake_horizon, "100.0000000")
    assert client.post(
        f"/api/v1/agreements/{agreement['id']}/fund",
        headers=owner.headers,
        json={"transaction_hash": HASH, "funded_amount": "100.00"},
    ).status_code == 200
    milestones = client.get(
        f"/api/v1/agreements/{agreement['id']}/milestones", headers=owner.headers
    ).json()
    monkeypatch.setattr(
        stellar, "build_soroban_release_xdr",
        lambda *a, **k: stellar.PreparedTransaction(xdr="AAAA-prepared", hash=RELEASE_HASH),
    )
    response = client.post(
        f"/api/v1/agreements/{agreement['id']}/milestones/{milestones[0]['id']}/prepare-release",
        headers=owner.headers,
        json={},
    )
    assert response.status_code == 409
    assert response.json()["code"] == "MILESTONE_NOT_APPROVED"


def test_escrow_fund_and_approve_require_verified_events(client, owner, supplier_actor, monkeypatch):
    """Escrow fund/approval paths never mark state without a matching event."""
    supplier = create_supplier(client, owner, email=supplier_actor.email)
    agreement = _create(client, owner, supplier["id"])
    client.post(f"/api/v1/agreements/{agreement['id']}/submit", headers=owner.headers)
    client.post(f"/api/v1/agreements/{agreement['id']}/accept", headers=supplier_actor.headers)
    _set_onchain_id(agreement["id"])
    fund_hash = "c" * 64
    monkeypatch.setattr(
        stellar, "build_soroban_fund_xdr",
        lambda *a, **k: stellar.PreparedTransaction(xdr="AAAA-fund", hash=fund_hash),
    )
    monkeypatch.setattr(stellar, "transaction_hash", lambda xdr: fund_hash)
    monkeypatch.setattr(
        stellar, "submit_soroban",
        lambda *a, **k: stellar.ChainResult(hash=fund_hash, status="SUCCESS", confirmed=True, successful=True),
    )
    failed = verification.VerificationResult(
        hash=fund_hash, confirmed=True, successful=True, settled=False, status="SUCCESS",
        ledger=1, source_account=None, destination_account="C", asset_code=None,
        asset_issuer=None, amount=None, memo=None, network="testnet", event_matched=False,
        reason="No matching funded event",
    )
    monkeypatch.setattr(verification, "verify_soroban_funding", lambda *a, **k: failed)
    from stellar_sdk import Keypair
    prepared = client.post(
        f"/api/v1/agreements/{agreement['id']}/prepare-fund",
        headers=owner.headers,
        json={"source_account": Keypair.random().public_key},
    )
    assert prepared.status_code == 200, prepared.text
    submitted = client.post(
        f"/api/v1/agreements/{agreement['id']}/fund-escrow",
        headers=owner.headers, json={"signed_xdr": "AAAA-fund"},
    )
    assert submitted.status_code == 409
    assert submitted.json()["code"] == "UNVERIFIED_EVENT"
    detail = client.get(f"/api/v1/agreements/{agreement['id']}", headers=owner.headers).json()
    assert detail["funded_amount"] == "0"
    assert detail["fund_transaction_hash"] is None


def test_agreement_isolation(client, owner, second_owner):
    supplier = create_supplier(client, owner)
    agreement = _create(client, owner, supplier["id"])
    assert client.get(
        f"/api/v1/agreements/{agreement['id']}", headers=second_owner.headers
    ).status_code == 404
    assert client.get("/api/v1/agreements", headers=second_owner.headers).json()["items"] == []
