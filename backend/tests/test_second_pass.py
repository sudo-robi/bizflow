"""Second-pass regression tests: correlation ids, PDF reports, invitation lifecycle and contract isolation."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

from stellar_sdk import Keypair

from app import models
from app.config import get_settings
from app.routers import agreements_chain
from app.services import stellar
from tests.conftest import TestSession, create_supplier


def test_request_id_header_is_returned_and_echoed(client):
    response = client.get("/health", headers={"X-Request-ID": "trace-123"})
    assert response.status_code == 200
    assert response.headers["X-Request-ID"] == "trace-123"
    generated = client.get("/health")
    assert generated.headers["X-Request-ID"]


def test_analytics_pdf_is_generated_from_db(client, owner):
    create_supplier(client, owner)
    response = client.get("/api/v1/reports/analytics.pdf", headers=owner.headers)
    assert response.status_code == 200, response.text
    assert response.content.startswith(b"%PDF")
    assert "pdf" in response.headers["content-type"]


def test_invitation_reject_by_invited_email(client, owner):
    invited_email = f"invitee-{Keypair.random().public_key[:6].lower()}@example.com"
    supplier = create_supplier(client, owner, email=invited_email)
    invite = client.post(
        f"/api/v1/suppliers/{supplier['id']}/invitations",
        headers=owner.headers,
        json={"email": invited_email},
    )
    assert invite.status_code == 201, invite.text
    token = invite.json()["token"]

    created = client.post(
        "/api/v1/auth/register",
        json={
            "email": invited_email,
            "password": "Str0ngPassw0rd!",
            "full_name": "Invitee",
        },
    )
    assert created.status_code == 201, created.text
    headers = {"Authorization": f"Bearer {created.json()['token']}"}
    rejected = client.post(
        f"/api/v1/suppliers/invitations/{token}/reject",
        headers=headers,
        json={"reason": "Not interested"},
    )
    assert rejected.status_code == 200, rejected.text
    assert rejected.json()["status"] == "rejected"


def test_invitation_revoke_and_expiry(client, owner):
    supplier = create_supplier(client, owner)
    email = supplier["email"]
    invite_response = client.post(
        f"/api/v1/suppliers/{supplier['id']}/invitations",
        headers=owner.headers,
        json={"email": email},
    )
    assert invite_response.status_code == 201, invite_response.text
    invite = invite_response.json()
    revoked = client.post(
        f"/api/v1/suppliers/{supplier['id']}/invitations/{invite['id']}/revoke",
        headers=owner.headers,
        json={"reason": "No longer needed"},
    )
    assert revoked.status_code == 200, revoked.text
    assert revoked.json()["status"] == "revoked"

    expired_email = email
    expiring_response = client.post(
        f"/api/v1/suppliers/{supplier['id']}/invitations",
        headers=owner.headers,
        json={"email": expired_email},
    )
    assert expiring_response.status_code == 201, expiring_response.text
    expiring = expiring_response.json()
    db = TestSession()
    row = db.get(models.SupplierInvitation, expiring["id"])
    row.expires_at = datetime.now(timezone.utc) - timedelta(days=1)
    db.commit()
    db.close()
    listed = client.get("/api/v1/suppliers/invitations", headers=owner.headers).json()
    assert any(item["id"] == expiring["id"] and item["status"] == "expired" for item in listed)


def test_cross_business_cannot_prepare_escrow(client, owner, second_owner):
    """Agreement A's tenant cannot prepare funding for agreement B."""
    supplier = create_supplier(client, owner)
    due = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    created = client.post(
        "/api/v1/agreements",
        headers=owner.headers,
        json={
            "supplier_id": supplier["id"],
            "title": "Private agreement",
            "total_amount": "2",
            "expiry_date": due,
            "milestones": [{"description": "M1", "amount": "2"}],
        },
    ).json()
    response = client.post(
        f"/api/v1/agreements/{created['id']}/prepare-fund",
        headers=second_owner.headers,
        json={"source_account": Keypair.random().public_key, "onchain_agreement_id": 3},
    )
    assert response.status_code == 404, response.text


def test_contract_cannot_be_reused_for_second_funded_agreement(client, owner, monkeypatch):
    supplier = create_supplier(client, owner)
    due = (datetime.now(timezone.utc) + timedelta(days=30)).isoformat()
    ids = []
    for index in range(2):
        created = client.post(
            "/api/v1/agreements",
            headers=owner.headers,
            json={
                "supplier_id": supplier["id"],
                "title": f"Agreement {index}",
                "total_amount": "2",
                "expiry_date": due,
                "milestones": [{"description": "M1", "amount": "2"}],
            },
        )
        assert created.status_code == 201, created.text
        ids.append(created.json()["id"])

    db = TestSession()
    first = db.get(models.PaymentAgreement, ids[0])
    second = db.get(models.PaymentAgreement, ids[1])
    second.status = "active"
    first.status = "active"
    first.fund_transaction_hash = "d" * 64
    first.escrow_contract_id = get_settings().stellar_escrow_contract_id
    db.commit()
    db.close()

    monkeypatch.setattr(
        agreements_chain.stellar,
        "build_soroban_fund_xdr",
        lambda *a, **k: SimpleNamespace(xdr="xdr", hash="e" * 64),
    )
    response = client.post(
        f"/api/v1/agreements/{ids[1]}/prepare-fund",
        headers=owner.headers,
        json={"source_account": Keypair.random().public_key, "onchain_agreement_id": 2},
    )
    assert response.status_code == 409, response.text
    assert response.json()["code"] == "CONTRACT_IN_USE"
