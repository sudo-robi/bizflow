"""Business feature completeness: invitations, approvals, evidence, escrow refunds.

Only network boundaries are mocked; every state change goes through the real API
and is persisted in the isolated in-memory test database.
"""

from __future__ import annotations

import uuid
from decimal import Decimal

import pytest
from pydantic import ValidationError
from stellar_sdk import Keypair

from app import models, schemas
from app.config import get_settings
from app.services import stellar, verification
from tests.conftest import TestSession, create_invoice, create_supplier

CONTRACT = get_settings().stellar_escrow_contract_id
FUND_HASH = "f" * 64
REFUND_HASH = "9" * 64


def _agreement(client, owner, supplier_id, *, milestones=None):
    body = {
        "supplier_id": supplier_id,
        "title": "Delivery agreement",
        "total_amount": "100.00",
        "asset_code": "XLM",
        "expiry_date": "2030-12-31T00:00:00",
        "milestones": milestones or [{"description": "Build", "amount": "100.00"}],
    }
    response = client.post("/api/v1/agreements", headers=owner.headers, json=body)
    assert response.status_code == 201, response.text
    return response.json()


def _activate_agreement(client, owner, supplier_actor, agreement):
    assert client.post(
        f"/api/v1/agreements/{agreement['id']}/submit", headers=owner.headers
    ).status_code == 200
    assert client.post(
        f"/api/v1/agreements/{agreement['id']}/accept", headers=supplier_actor.headers
    ).status_code == 200


def _funded_agreement(client, owner, supplier_actor, fake_horizon):
    supplier = create_supplier(
        client, owner, email=supplier_actor.email, wallet=fake_horizon.destination
    )
    agreement = _agreement(client, owner, supplier["id"])
    _activate_agreement(client, owner, supplier_actor, agreement)
    db = TestSession()
    try:
        db.get(models.PaymentAgreement, agreement["id"]).onchain_agreement_id = 1
        db.commit()
    finally:
        db.close()
    fake_horizon.destination = CONTRACT
    fake_horizon.amount = "100.0000000"
    fake_horizon.memo = agreement["reference"]
    funded = client.post(
        f"/api/v1/agreements/{agreement['id']}/fund",
        headers=owner.headers,
        json={"transaction_hash": FUND_HASH, "funded_amount": "100.00"},
    )
    assert funded.status_code == 200, funded.text
    return agreement


def _verification_result(hash_value: str, amount: Decimal) -> verification.VerificationResult:
    return verification.VerificationResult(
        hash=hash_value,
        confirmed=True,
        successful=True,
        settled=True,
        status="SUCCESS",
        ledger=10,
        source_account=Keypair.random().public_key,
        destination_account=CONTRACT,
        asset_code="XLM",
        asset_issuer=None,
        amount=amount,
        memo=None,
        network="testnet",
        contract_id=CONTRACT,
        event_matched=True,
    )


# --- 1. Supplier invitations -------------------------------------------------

def test_supplier_invitation_requires_explicit_acceptance(client, owner, second_owner):
    invited_email = f"invited-{uuid.uuid4().hex[:8]}@example.com"
    supplier = create_supplier(client, owner, email=invited_email)

    invited = client.post(
        f"/api/v1/suppliers/{supplier['id']}/invitations",
        headers=owner.headers,
        json={"email": invited_email},
    )
    assert invited.status_code == 201, invited.text
    invite = invited.json()
    assert invite["status"] == "pending" and invite["token"]

    # The invite is durable but scoped to the inviting business.
    listed = client.get("/api/v1/suppliers/invitations", headers=owner.headers)
    assert listed.status_code == 200 and listed.json()[0]["id"] == invite["id"]
    assert listed.json()[0]["token"] is None
    assert client.get(
        "/api/v1/suppliers/invitations", headers=second_owner.headers
    ).json() == []
    assert client.post(
        f"/api/v1/suppliers/{supplier['id']}/invitations",
        headers=second_owner.headers, json={"email": invited_email},
    ).status_code == 404

    # Registering the email must NOT silently grant supplier access.
    registered = client.post(
        "/api/v1/auth/register",
        json={
            "email": invited_email,
            "password": "Str0ngPassw0rd!",
            "full_name": "Invited Supplier",
        },
    )
    assert registered.status_code == 201, registered.text
    actor_token = registered.json()["token"]
    headers = {"Authorization": f"Bearer {actor_token}", "X-Business-ID": owner.business_id}
    assert client.get("/api/v1/businesses", headers=headers).json() == []
    assert client.post(
        f"/api/v1/suppliers/invitations/{invite['token']}/accept", headers=headers
    ).status_code == 200

    accepted = client.get("/api/v1/businesses", headers=headers)
    assert accepted.status_code == 200
    assert any(row["id"] == owner.business_id and row["role"] == "supplier" for row in accepted.json())

    # A different account cannot use the capability, even with a valid token.
    stranger = client.post(
        "/api/v1/auth/register",
        json={
            "email": f"stranger-{uuid.uuid4().hex[:8]}@example.com",
            "password": "Str0ngPassw0rd!",
            "full_name": "Stranger",
        },
    ).json()
    stranger_headers = {
        "Authorization": f"Bearer {stranger['token']}",
        "X-Business-ID": owner.business_id,
    }
    second_supplier = create_supplier(
        client, owner, email=f"other-{uuid.uuid4().hex[:8]}@example.com"
    )
    second_invite = client.post(
        f"/api/v1/suppliers/{second_supplier['id']}/invitations",
        headers=owner.headers,
        json={"email": second_supplier["email"]},
    ).json()
    assert client.post(
        f"/api/v1/suppliers/invitations/{second_invite['token']}/accept",
        headers=stranger_headers,
    ).status_code == 403


# --- 2. Invoice approval / rejection ----------------------------------------

def test_invoice_approve_and_reject_audit_and_notify(client, owner, finance_actor):
    supplier = create_supplier(client, owner)
    first = create_invoice(client, owner, supplier["id"])
    assert client.post(
        f"/api/v1/invoices/{first['id']}/submit", headers=finance_actor.headers
    ).status_code == 200
    approved = client.post(
        f"/api/v1/invoices/{first['id']}/approve", headers=finance_actor.headers
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "approved"

    second = create_invoice(client, owner, supplier["id"])
    client.post(f"/api/v1/invoices/{second['id']}/submit", headers=owner.headers)
    rejected = client.post(
        f"/api/v1/invoices/{second['id']}/reject",
        headers=finance_actor.headers,
        json={"reason": "Duplicate invoice"},
    )
    assert rejected.status_code == 200 and rejected.json()["status"] == "rejected"

    db = TestSession()
    try:
        actions = [
            row.action
            for row in db.query(models.AuditLog).filter(
                models.AuditLog.business_id == owner.business_id
            ).all()
        ]
        notifications = db.query(models.Notification).filter(
            models.Notification.business_id == owner.business_id
        ).count()
    finally:
        db.close()
    assert "invoice.approved" in actions
    assert "invoice.rejected" in actions
    assert notifications >= 2


def test_invoice_decision_is_authorized_and_business_scoped(client, owner, supplier_actor, second_owner):
    supplier = create_supplier(client, owner)
    invoice = create_invoice(client, owner, supplier["id"])
    client.post(f"/api/v1/invoices/{invoice['id']}/submit", headers=owner.headers)
    assert client.post(
        f"/api/v1/invoices/{invoice['id']}/approve", headers=supplier_actor.headers
    ).status_code == 403
    assert client.post(
        f"/api/v1/invoices/{invoice['id']}/approve", headers=second_owner.headers
    ).status_code == 404


# --- 3. Invoice attachments --------------------------------------------------

def test_invoice_attachment_upload_list_download_and_isolation(client, owner, second_owner):
    supplier = create_supplier(client, owner)
    invoice = create_invoice(client, owner, supplier["id"])
    path = f"/api/v1/invoices/{invoice['id']}/attachments"

    uploaded = client.post(
        path,
        headers=owner.headers,
        files={"file": ("proof.txt", b"delivered goods", "text/plain")},
    )
    assert uploaded.status_code == 201, uploaded.text
    attachment = uploaded.json()
    assert attachment["invoice_id"] == invoice["id"]
    assert attachment["size"] == len(b"delivered goods")

    listed = client.get(path, headers=owner.headers)
    assert listed.status_code == 200 and listed.json()[0]["id"] == attachment["id"]
    downloaded = client.get(
        f"{path}/{attachment['id']}/download", headers=owner.headers
    )
    assert downloaded.status_code == 200
    assert downloaded.content == b"delivered goods"
    assert "proof.txt" in downloaded.headers["content-disposition"]

    assert client.get(
        f"{path}/{attachment['id']}/download", headers=second_owner.headers
    ).status_code == 404
    assert client.post(
        path, headers=owner.headers,
        files={"file": ("secret.env", b"TOKEN=1", "text/plain")},
    ).status_code == 400
    assert client.post(
        path, headers=owner.headers,
        files={"file": ("payload.exe", b"MZ", "application/octet-stream")},
    ).status_code == 400
    assert client.post(
        path, headers=owner.headers,
        files={"file": ("huge.txt", b"x" * (5 * 1024 * 1024 + 1), "text/plain")},
    ).status_code == 400


# --- 4. Milestone evidence ---------------------------------------------------

def test_milestone_evidence_submission_and_offchain_approval(client, owner, supplier_actor, finance_actor):
    supplier = create_supplier(client, owner, email=supplier_actor.email)
    agreement = _agreement(client, owner, supplier["id"])
    _activate_agreement(client, owner, supplier_actor, agreement)
    milestone = agreement["milestones"][0]
    base = f"/api/v1/agreements/{agreement['id']}/milestones/{milestone['id']}/evidence"

    # Business staff cannot impersonate the supplier.
    assert client.post(base, headers=owner.headers, data={"note": "fake"}).status_code == 403
    submitted = client.post(
        base,
        headers=supplier_actor.headers,
        data={"note": "Work completed", "url": "https://example.com/proof"},
    )
    assert submitted.status_code == 201, submitted.text
    evidence = submitted.json()
    assert evidence["status"] == "submitted"

    state = client.get(
        f"/api/v1/agreements/{agreement['id']}", headers=owner.headers
    ).json()
    assert state["milestones"][0]["status"] == "submitted"

    approved = client.post(
        f"{base}/{evidence['id']}/approve", headers=finance_actor.headers
    )
    assert approved.status_code == 200, approved.text
    assert approved.json()["status"] == "approved"

    # Evidence approval must not fabricate an on-chain approval/release.
    state = client.get(
        f"/api/v1/agreements/{agreement['id']}", headers=owner.headers
    ).json()
    assert state["milestones"][0]["status"] == "submitted"
    db = TestSession()
    try:
        actions = [
            row.action for row in db.query(models.AuditLog).filter(
                models.AuditLog.business_id == owner.business_id
            ).all()
        ]
    finally:
        db.close()
    assert "milestone.evidence_submitted" in actions
    assert "milestone.evidence_approved" in actions


def test_submitted_milestone_needs_approved_evidence_for_onchain_approval(
    client, owner, supplier_actor, fake_horizon
):
    agreement = _funded_agreement(client, owner, supplier_actor, fake_horizon)
    milestone = client.get(
        f"/api/v1/agreements/{agreement['id']}/milestones", headers=owner.headers
    ).json()[0]
    db = TestSession()
    try:
        db.get(models.AgreementMilestone, milestone["id"]).status = "submitted"
        db.commit()
    finally:
        db.close()
    response = client.post(
        f"/api/v1/agreements/{agreement['id']}/milestones/{milestone['id']}/prepare-approve",
        headers=owner.headers, json={},
    )
    assert response.status_code == 409 and response.json()["code"] == "MILESTONE_STATE"


# --- 5. Escrow refund --------------------------------------------------------

def test_refund_builder_invokes_real_contract_function(monkeypatch):
    captured = {}

    def fake_build(contract_id, source, function_name, parameters, passphrase=None):
        captured.update(
            contract_id=contract_id, source=source,
            function_name=function_name, parameters=parameters,
        )
        return stellar.PreparedTransaction(xdr="AAAA-refund", hash=REFUND_HASH)

    monkeypatch.setattr(stellar, "build_soroban_invoke_xdr", fake_build)
    source = Keypair.random().public_key
    prepared = stellar.build_soroban_refund_xdr(CONTRACT, source)
    assert prepared.hash == REFUND_HASH
    assert captured["function_name"] == "refund"
    assert captured["contract_id"] == CONTRACT and captured["source"] == source
    assert len(captured["parameters"]) == 1


def test_escrow_refund_prepare_and_verified_submit(client, owner, supplier_actor, second_owner, fake_horizon, monkeypatch):
    agreement = _funded_agreement(client, owner, supplier_actor, fake_horizon)
    path = f"/api/v1/agreements/{agreement['id']}"

    monkeypatch.setattr(
        stellar, "build_soroban_refund_xdr",
        lambda *a, **kw: stellar.PreparedTransaction(xdr="AAAA-refund", hash=REFUND_HASH),
    )
    monkeypatch.setattr(stellar, "transaction_hash", lambda xdr: REFUND_HASH)
    monkeypatch.setattr(
        stellar, "submit_soroban",
        lambda xdr, contract_id=None, function_name=None, **kwargs: stellar.ChainResult(
            hash=REFUND_HASH, status="SUCCESS", confirmed=True, successful=True, ledger=11,
        ),
    )
    monkeypatch.setattr(
        verification, "verify_soroban_refund",
        lambda *a, **kw: _verification_result(REFUND_HASH, Decimal("100")),
    )

    prepared = client.post(
        f"{path}/prepare-refund", headers=owner.headers, json={}
    )
    assert prepared.status_code == 200, prepared.text
    assert prepared.json()["hash"] == REFUND_HASH

    refunded = client.post(
        f"{path}/refund", headers=owner.headers, json={"signed_xdr": "AAAA-refund"}
    )
    assert refunded.status_code == 200, refunded.text
    assert refunded.json()["status"] == "refunded"

    db = TestSession()
    try:
        actions = [
            row.action for row in db.query(models.AuditLog).filter(
                models.AuditLog.entity_id == agreement["id"]
            ).all()
        ]
        assert "agreement.refunded" in actions
        payment = db.query(models.PaymentRecord).filter(
            models.PaymentRecord.hash == REFUND_HASH
        ).first()
        assert payment is not None and payment.status == "confirmed"
    finally:
        db.close()

    assert client.post(
        f"{path}/prepare-refund", headers=supplier_actor.headers, json={}
    ).status_code == 403
    assert client.post(
        f"{path}/prepare-refund", headers=second_owner.headers, json={}
    ).status_code == 404


# --- 6. Prepared XDR retrieval -----------------------------------------------

def test_prepared_xdr_is_only_available_for_prepared_payments(client, owner, second_owner, finance_actor, fake_horizon):
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    invoice = create_invoice(client, owner, supplier["id"], amount="10.00")
    prepared = client.post(
        "/api/v1/payments/prepare",
        headers=finance_actor.headers,
        json={"invoice_id": invoice["id"], "source_account": fake_horizon.source},
    )
    assert prepared.status_code == 201, prepared.text
    payment = prepared.json()
    path = f"/api/v1/payments/{payment['payment_id']}/prepared-xdr"

    fetched = client.get(path, headers=finance_actor.headers)
    assert fetched.status_code == 200, fetched.text
    assert fetched.json()["xdr"] == payment["xdr"]
    assert fetched.json()["status"] == "prepared"
    assert client.get(path, headers=second_owner.headers).status_code == 404

    db = TestSession()
    try:
        record = db.get(models.PaymentRecord, payment["payment_id"])
        record.status = "confirmed"
        db.commit()
    finally:
        db.close()
    hidden = client.get(path, headers=finance_actor.headers)
    assert hidden.status_code == 409 and hidden.json()["code"] == "PAYMENT_NOT_PREPARED"


# --- 7. Validators and transactions verify ----------------------------------

def test_update_validators_apply_asset_and_quantized_amount_rules():
    key = Keypair.random().public_key
    with pytest.raises(ValidationError):
        schemas.InvoiceUpdate(asset_code="USDC")
    with pytest.raises(ValidationError):
        schemas.AgreementUpdate(asset_code="USD")
    assert schemas.InvoiceUpdate(asset_code="USDC", asset_issuer=key).asset_code == "USDC"
    with pytest.raises(ValidationError):
        schemas.InvoiceUpdate(amount="0.00000001")
    with pytest.raises(ValidationError):
        schemas.AgreementUpdate(total_amount="0.00000001")


def test_tiny_amount_is_rejected_by_api(client, owner):
    supplier = create_supplier(client, owner)
    response = client.post(
        "/api/v1/invoices",
        headers=owner.headers,
        json={
            "supplier_id": supplier["id"],
            "description": "Dust",
            "amount": "0.00000001",
            "due_date": "2030-12-31T00:00:00",
        },
    )
    assert response.status_code == 422


def test_verify_requires_finance_role_and_is_not_globally_blocked(
    client, owner, supplier_actor, second_owner, fake_horizon
):
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    invoice = create_invoice(client, owner, supplier["id"], amount="10.00")
    prepared = client.post(
        "/api/v1/payments/prepare",
        headers=owner.headers,
        json={"invoice_id": invoice["id"], "source_account": fake_horizon.source},
    ).json()
    fake_horizon.amount = "10.0000000"
    fake_horizon.memo = invoice["invoice_number"]
    submitted = client.post(
        f"/api/v1/payments/{prepared['payment_id']}/submit",
        headers=owner.headers, json={"signed_xdr": prepared["xdr"]},
    )
    assert submitted.status_code == 200, submitted.text

    assert client.post(
        "/api/v1/transactions/verify", headers=supplier_actor.headers,
        json={"hash": prepared["hash"]},
    ).status_code == 403

    other_business = client.post(
        "/api/v1/transactions/verify", headers=second_owner.headers,
        json={"hash": prepared["hash"]},
    )
    assert other_business.status_code == 200, other_business.text
    assert other_business.json()["settled"] is True
    assert client.post(
        "/api/v1/transactions/verify", headers=owner.headers,
        json={"hash": prepared["hash"]},
    ).status_code == 409


def test_verify_does_not_leak_provider_exception(client, owner, monkeypatch):
    def boom(_hash):
        raise RuntimeError("secret upstream diagnostic 42")

    monkeypatch.setattr(verification, "verify_stellar_payment", boom)
    response = client.post(
        "/api/v1/transactions/verify", headers=owner.headers,
        json={"hash": "d" * 64},
    )
    assert response.status_code == 502
    assert response.json()["code"] == "CHAIN_ERROR"
    assert "secret upstream diagnostic" not in response.text
