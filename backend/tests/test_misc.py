"""Wallets, notifications, reports, audit trail and public verification."""

from __future__ import annotations

from stellar_sdk import Keypair

from app import models
from tests.conftest import TestSession, create_invoice, create_supplier


def test_analytics_and_reconciliation_use_real_records(client, owner, fake_horizon):
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    create_invoice(client, owner, supplier["id"], amount="100")
    analytics = client.get("/api/v1/reports/analytics", headers=owner.headers)
    assert analytics.status_code == 200, analytics.text
    assert analytics.json()["outstanding_liabilities"] == "100"
    reconciliation = client.get("/api/v1/reports/reconciliation", headers=owner.headers)
    assert reconciliation.status_code == 200, reconciliation.text
    assert reconciliation.json()["unmatched_transactions"] == []


def test_wallet_connect_list_and_disconnect(client, owner):
    key = Keypair.random().public_key
    created = client.post(
        "/api/v1/wallets", headers=owner.headers, json={"public_key": key, "label": "Main"}
    )
    assert created.status_code == 201, created.text
    assert created.json()["network"] == "testnet"
    duplicate = client.post(
        "/api/v1/wallets", headers=owner.headers, json={"public_key": key}
    )
    assert duplicate.status_code == 409
    listing = client.get("/api/v1/wallets", headers=owner.headers)
    assert len(listing.json()) == 1
    deleted = client.delete(
        f"/api/v1/wallets/{created.json()['id']}", headers=owner.headers
    )
    assert deleted.status_code == 200
    assert client.get("/api/v1/wallets", headers=owner.headers).json() == []


def test_wallet_rejects_invalid_key_and_mainnet(client, owner):
    bad = client.post(
        "/api/v1/wallets", headers=owner.headers, json={"public_key": "not-a-key"}
    )
    assert bad.status_code == 422
    mainnet = client.post(
        "/api/v1/wallets",
        headers=owner.headers,
        json={"public_key": Keypair.random().public_key, "network": "mainnet"},
    )
    assert mainnet.status_code == 422


def test_notifications_read_flow(client, owner):
    db = TestSession()
    try:
        for index in range(2):
            db.add(
                models.Notification(
                    business_id=owner.business_id,
                    user_id=owner.user_id,
                    title=f"Notice {index}",
                    message="Message",
                    type="info",
                )
            )
        db.commit()
    finally:
        db.close()
    listing = client.get("/api/v1/notifications", headers=owner.headers)
    assert len(listing.json()) == 2
    unread = client.get(
        "/api/v1/notifications?unread_only=true", headers=owner.headers
    )
    assert len(unread.json()) == 2
    read = client.patch(
        f"/api/v1/notifications/{listing.json()[0]['id']}/read", headers=owner.headers
    )
    assert read.status_code == 200 and read.json()["is_read"] is True
    client.patch("/api/v1/notifications/read-all", headers=owner.headers)
    assert client.get(
        "/api/v1/notifications?unread_only=true", headers=owner.headers
    ).json() == []


def test_dashboard_has_useful_empty_state(client, owner):
    response = client.get("/api/v1/reports/dashboard", headers=owner.headers)
    assert response.status_code == 200
    body = response.json()
    assert body["counts"]["invoices"] == 0
    assert body["total_paid"] == "0"
    assert body["recent_transactions"] == []
    assert body["has_data"] is False


def test_dashboard_and_csv_reflect_real_data(client, owner, fake_horizon):
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    invoice = create_invoice(client, owner, supplier["id"])
    prepared = client.post(
        "/api/v1/payments/prepare",
        headers=owner.headers,
        json={"invoice_id": invoice["id"], "source_account": fake_horizon.source},
    ).json()
    fake_horizon.amount = "1250.5000000"
    fake_horizon.memo = invoice["invoice_number"]
    client.post(
        f"/api/v1/payments/{prepared['payment_id']}/submit",
        headers=owner.headers,
        json={"signed_xdr": prepared["xdr"]},
    )
    dashboard = client.get("/api/v1/reports/dashboard", headers=owner.headers).json()
    assert dashboard["counts"]["payments_confirmed"] == 1
    assert dashboard["total_paid"] == "1250.5"
    csv = client.get("/api/v1/reports/payments.csv", headers=owner.headers)
    assert csv.status_code == 200
    assert "1250.5" in csv.text
    assert "confirmed" in csv.text


def test_audit_logs_are_listable_and_scoped(client, owner, second_owner):
    create_supplier(client, owner)
    logs = client.get("/api/v1/audit-logs", headers=owner.headers)
    assert logs.status_code == 200
    assert logs.json()["total"] >= 1
    filtered = client.get(
        "/api/v1/audit-logs?action=supplier.created", headers=owner.headers
    )
    assert filtered.json()["total"] >= 1
    assert client.get(
        "/api/v1/audit-logs", headers=second_owner.headers
    ).json()["total"] == 0


def test_public_verify_hides_internal_user_data(client, owner, fake_horizon):
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    invoice = create_invoice(client, owner, supplier["id"])
    prepared = client.post(
        "/api/v1/payments/prepare",
        headers=owner.headers,
        json={"invoice_id": invoice["id"], "source_account": fake_horizon.source},
    ).json()
    fake_horizon.amount = "1250.5000000"
    fake_horizon.memo = invoice["invoice_number"]
    client.post(
        f"/api/v1/payments/{prepared['payment_id']}/submit",
        headers=owner.headers,
        json={"signed_xdr": prepared["xdr"]},
    )
    response = client.get(f"/api/v1/verify/{prepared['hash']}")
    assert response.status_code == 200
    body = response.json()
    assert body["invoice_number"] == invoice["invoice_number"]
    assert "email" not in body and "notes" not in body and "user_id" not in body
