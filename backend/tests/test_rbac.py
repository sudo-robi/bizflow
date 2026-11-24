"""Role-based access control tests."""

from __future__ import annotations

from tests.conftest import create_invoice, create_supplier


def test_supplier_cannot_create_supplier_or_invoice(client, owner, supplier_actor):
    supplier = create_supplier(client, owner, email=supplier_actor.email)
    denied = client.post(
        "/api/v1/suppliers",
        headers=supplier_actor.headers,
        json={"business_name": "Nope", "wallet_address": "GABC"},
    )
    assert denied.status_code == 403
    invoice = client.post(
        "/api/v1/invoices",
        headers=supplier_actor.headers,
        json={
            "supplier_id": supplier["id"],
            "description": "Nope",
            "amount": "1",
            "due_date": "2030-01-01T00:00:00",
        },
    )
    assert invoice.status_code == 403


def test_finance_cannot_create_agreement_or_archive(client, owner, finance_actor):
    supplier = create_supplier(client, owner)
    agreement = client.post(
        "/api/v1/agreements",
        headers=finance_actor.headers,
        json={
            "supplier_id": supplier["id"],
            "title": "Nope",
            "total_amount": "1",
            "expiry_date": "2030-01-01T00:00:00",
            "milestones": [{"description": "One", "amount": "1"}],
        },
    )
    assert agreement.status_code == 403
    archive = client.post(
        f"/api/v1/suppliers/{supplier['id']}/archive", headers=finance_actor.headers
    )
    assert archive.status_code == 403


def test_finance_can_manage_invoices_and_payments(client, owner, finance_actor, fake_horizon):
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    invoice = create_invoice(client, owner, supplier["id"], amount="10.00")
    submitted = client.post(
        f"/api/v1/invoices/{invoice['id']}/submit", headers=finance_actor.headers
    )
    assert submitted.status_code == 200
    prepared = client.post(
        "/api/v1/payments/prepare",
        headers=finance_actor.headers,
        json={"invoice_id": invoice["id"], "source_account": fake_horizon.source},
    )
    assert prepared.status_code == 201


def test_missing_business_header_is_rejected(client, owner):
    response = client.get(
        "/api/v1/invoices",
        headers={"Authorization": f"Bearer {owner.token}"},
    )
    assert response.status_code == 422
    assert response.json()["code"] == "VALIDATION_ERROR"


def test_invalid_token_is_unauthorized(client, owner):
    response = client.get(
        "/api/v1/invoices",
        headers={"Authorization": "Bearer invalid", "X-Business-ID": owner.business_id},
    )
    assert response.status_code == 401


def test_supplier_sees_only_linked_payments(client, owner, supplier_actor, fake_horizon):
    linked = create_supplier(
        client, owner, email=supplier_actor.email, wallet=fake_horizon.destination
    )
    other = create_supplier(client, owner)
    linked_invoice = create_invoice(client, owner, linked["id"], amount="10.00")
    other_invoice = create_invoice(client, owner, other["id"], amount="10.00")
    visible = client.get(
        f"/api/v1/invoices/{linked_invoice['id']}", headers=supplier_actor.headers
    )
    hidden = client.get(
        f"/api/v1/invoices/{other_invoice['id']}", headers=supplier_actor.headers
    )
    assert visible.status_code == 200
    assert hidden.status_code == 403
