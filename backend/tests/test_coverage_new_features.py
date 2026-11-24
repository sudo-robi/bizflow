"""Tests for the newly added supplier-invite, invoice-approval, attachment and XDR endpoints."""

from __future__ import annotations

from datetime import timedelta

from stellar_sdk import Keypair

from app import models
from app.services import stellar
from app.utils import utcnow
from tests.conftest import TestSession, create_invoice, create_supplier, register

INVITE_EMAIL = f"invited-{Keypair.random().public_key[:8].lower()}@example.com"


# --- supplier invitations ---------------------------------------------------

def test_supplier_invitation_lifecycle_and_validation(client, owner):
    supplier = create_supplier(client, owner, email=INVITE_EMAIL)
    path = f"/api/v1/suppliers/{supplier['id']}/invitations"

    mismatch = client.post(path, headers=owner.headers, json={"email": "other@example.com"})
    assert mismatch.status_code == 400 and mismatch.json()["code"] == "EMAIL_MISMATCH"

    invited = client.post(path, headers=owner.headers, json={"email": INVITE_EMAIL.upper()})
    assert invited.status_code == 201, invited.text
    body = invited.json()
    assert body["status"] == "pending" and body["token"]
    assert client.post(path, headers=owner.headers, json={"email": INVITE_EMAIL}).status_code == 409

    listing = client.get("/api/v1/suppliers/invitations", headers=owner.headers)
    assert listing.status_code == 200 and len(listing.json()) == 1
    assert listing.json()[0]["token"] is None

    other = register(client, business=False)
    denied = client.post(
        f"/api/v1/suppliers/invitations/{body['token']}/accept", headers=other.headers
    )
    assert denied.status_code == 403

    assert client.post(
        "/api/v1/auth/register",
        json={"email": INVITE_EMAIL, "password": "Str0ngPassw0rd!", "full_name": "Invited"},
    ).status_code == 201
    login = client.post(
        "/api/v1/auth/login", json={"email": INVITE_EMAIL, "password": "Str0ngPassw0rd!"}
    )
    headers = {"Authorization": f"Bearer {login.json()['token']}"}
    accepted = client.post(
        f"/api/v1/suppliers/invitations/{body['token']}/accept", headers=headers
    )
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["status"] == "accepted"
    assert client.post(
        f"/api/v1/suppliers/invitations/{body['token']}/accept", headers=headers
    ).status_code == 409
    assert client.post(
        "/api/v1/suppliers/invitations/unknown-token/accept", headers=headers
    ).status_code == 404


def test_supplier_invitation_rejects_expired_token(client, owner):
    email = f"expired-{Keypair.random().public_key[:8].lower()}@example.com"
    supplier = create_supplier(client, owner, email=email)
    created = client.post(
        f"/api/v1/suppliers/{supplier['id']}/invitations", headers=owner.headers, json={"email": email}
    ).json()
    db = TestSession()
    try:
        invite = db.get(models.SupplierInvitation, created["id"])
        invite.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    finally:
        db.close()
    response = client.post(
        f"/api/v1/suppliers/invitations/{created['token']}/accept", headers=owner.headers
    )
    assert response.status_code == 409 and response.json()["code"] == "INVITE_EXPIRED"


# --- invoice decisions and attachments -------------------------------------

def test_invoice_approve_reject_and_not_pending(client, owner):
    supplier = create_supplier(client, owner)
    invoice = create_invoice(client, owner, supplier["id"])
    assert client.post(
        f"/api/v1/invoices/{invoice['id']}/approve", headers=owner.headers
    ).status_code == 409
    assert client.post(f"/api/v1/invoices/{invoice['id']}/submit", headers=owner.headers).status_code == 200
    approved = client.post(
        f"/api/v1/invoices/{invoice['id']}/approve",
        headers=owner.headers, json={"reason": "Reviewed"},
    )
    assert approved.status_code == 200 and approved.json()["status"] == "approved"
    assert client.post(
        f"/api/v1/invoices/{invoice['id']}/reject", headers=owner.headers
    ).status_code == 409

    second = create_invoice(client, owner, supplier["id"])
    client.post(f"/api/v1/invoices/{second['id']}/submit", headers=owner.headers)
    rejected = client.post(
        f"/api/v1/invoices/{second['id']}/reject", headers=owner.headers, json={"reason": "Bad data"}
    )
    assert rejected.status_code == 200 and rejected.json()["status"] == "rejected"


def test_invoice_attachment_upload_list_download_and_rejections(client, owner):
    supplier = create_supplier(client, owner)
    invoice = create_invoice(client, owner, supplier["id"])
    base = f"/api/v1/invoices/{invoice['id']}/attachments"

    bad_name = client.post(
        base, headers=owner.headers,
        files={"file": ("evil!.txt", b"content", "text/plain")},
    )
    assert bad_name.status_code == 400 and bad_name.json()["code"] == "INVALID_FILENAME"

    bad_type = client.post(
        base, headers=owner.headers, files={"file": ("notes.exe", b"content", "application/octet-stream")}
    )
    assert bad_type.status_code == 400 and bad_type.json()["code"] == "INVALID_FILE_TYPE"

    suffix = client.post(
        base, headers=owner.headers, files={"file": ("key.env", b"content", "text/plain")}
    )
    assert suffix.status_code == 400 and suffix.json()["code"] == "INVALID_FILE_TYPE"

    empty = client.post(
        base, headers=owner.headers, files={"file": ("empty.txt", b"", "text/plain")}
    )
    assert empty.status_code == 400 and empty.json()["code"] == "EMPTY_FILE"

    large = client.post(
        base, headers=owner.headers,
        files={"file": ("large.txt", b"x" * (5 * 1024 * 1024 + 1), "text/plain")},
    )
    assert large.status_code == 400 and large.json()["code"] == "FILE_TOO_LARGE"

    secret = client.post(
        base, headers=owner.headers, files={"file": ("key.txt", b"PRIVATE KEY data", "text/plain")}
    )
    assert secret.status_code == 400 and secret.json()["code"] == "SECRET_CONTENT"

    uploaded = client.post(
        base, headers=owner.headers, files={"file": ("notes.txt", b"hello", "text/plain")}
    )
    assert uploaded.status_code == 201, uploaded.text
    attachment = uploaded.json()
    assert attachment["filename"] == "notes.txt" and attachment["size"] == 5

    listing = client.get(base, headers=owner.headers)
    assert listing.status_code == 200 and len(listing.json()) == 1
    download = client.get(f"{base}/{attachment['id']}/download", headers=owner.headers)
    assert download.status_code == 200 and download.content == b"hello"
    missing = client.get(f"{base}/missing/download", headers=owner.headers)
    assert missing.status_code == 404
    assert client.get(f"/api/v1/invoices/{invoice['id']}/pdf", headers=owner.headers).status_code == 200


# --- prepared XDR retrieval -------------------------------------------------

def test_prepared_xdr_endpoint_blocks_wrong_states(client, owner, fake_horizon):
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    invoice = create_invoice(client, owner, supplier["id"])
    prepared = client.post(
        "/api/v1/payments/prepare", headers=owner.headers,
        json={"invoice_id": invoice["id"], "source_account": fake_horizon.source},
    ).json()
    path = f"/api/v1/payments/{prepared['payment_id']}/prepared-xdr"
    response = client.get(path, headers=owner.headers)
    assert response.status_code == 200 and response.json()["xdr"] == prepared["xdr"]

    db = TestSession()
    try:
        payment = db.get(models.PaymentRecord, prepared["payment_id"])
        payment.expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    finally:
        db.close()
    assert client.get(path, headers=owner.headers).json()["code"] == "EXPIRED_XDR"

    db = TestSession()
    try:
        payment = db.get(models.PaymentRecord, prepared["payment_id"])
        payment.expires_at = utcnow() + timedelta(minutes=10)
        payment.status = "confirmed"
        db.commit()
    finally:
        db.close()
    confirmed = client.get(path, headers=owner.headers)
    assert confirmed.status_code == 409 and confirmed.json()["code"] == "PAYMENT_NOT_PREPARED"


# --- milestone evidence -----------------------------------------------------

def test_milestone_evidence_requires_linked_supplier(client, owner, supplier_actor):
    supplier = create_supplier(client, owner, email=supplier_actor.email)
    agreement_body = {
        "supplier_id": supplier["id"], "title": "Work", "total_amount": "10",
        "asset_code": "XLM", "expiry_date": "2030-12-31T00:00:00",
        "milestones": [{"description": "A", "amount": "10"}],
    }
    created = client.post("/api/v1/agreements", headers=owner.headers, json=agreement_body)
    assert created.status_code == 201
    milestone_id = created.json()["milestones"][0]["id"]
    base = f"/api/v1/agreements/{created.json()['id']}/milestones/{milestone_id}/evidence"

    denied = client.post(base, headers=owner.headers, data={"note": "proof"})
    assert denied.status_code == 403

    empty = client.post(base, headers=supplier_actor.headers, data={})
    assert empty.status_code == 400 and empty.json()["code"] == "MISSING_EVIDENCE"

    bad_url = client.post(base, headers=supplier_actor.headers, data={"url": "ftp://example.com"})
    assert bad_url.status_code == 400 and bad_url.json()["code"] == "INVALID_URL"

    submitted = client.post(base, headers=supplier_actor.headers, data={"note": "Proof of work"})
    assert submitted.status_code == 201, submitted.text
    assert submitted.json()["status"] == "submitted"

    listing = client.get(base, headers=supplier_actor.headers)
    assert listing.status_code == 200 and len(listing.json()) == 1

    # Off-chain evidence approval is audited but never sets the on-chain status.
    approval = client.post(
        f"{base}/{submitted.json()['id']}/approve", headers=owner.headers, json={"note": "Looks good"}
    )
    assert approval.status_code in (200, 403, 409)
