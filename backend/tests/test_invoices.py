"""Invoice creation, derived status, cancellation, PDF and visibility tests."""

from __future__ import annotations

from tests.conftest import create_invoice, create_supplier


def test_create_invoice_with_items_and_number(client, owner):
    supplier = create_supplier(client, owner)
    invoice = create_invoice(client, owner, supplier["id"])
    assert invoice["invoice_number"].startswith("INV-")
    assert invoice["status"] == "draft"
    assert invoice["amount"] == "1250.5"
    assert invoice["amount_paid"] == "0"
    assert len(invoice["items"]) == 1
    assert invoice["items"][0]["unit_price"] == "1250.5"


def test_submit_changes_draft_to_pending_and_patch_restrictions(client, owner):
    supplier = create_supplier(client, owner)
    invoice = create_invoice(client, owner, supplier["id"])
    submitted = client.post(
        f"/api/v1/invoices/{invoice['id']}/submit", headers=owner.headers
    )
    assert submitted.status_code == 200
    assert submitted.json()["status"] == "pending"
    patched = client.patch(
        f"/api/v1/invoices/{invoice['id']}", headers=owner.headers, json={"description": "New"}
    )
    assert patched.status_code == 200
    assert patched.json()["description"] == "New"


def test_cancel_invoice(client, owner):
    supplier = create_supplier(client, owner)
    invoice = create_invoice(client, owner, supplier["id"])
    response = client.post(
        f"/api/v1/invoices/{invoice['id']}/cancel", headers=owner.headers
    )
    assert response.status_code == 200
    assert response.json()["status"] == "cancelled"
    submit = client.post(
        f"/api/v1/invoices/{invoice['id']}/submit", headers=owner.headers
    )
    assert submit.status_code == 409


def test_invoice_pdf_is_generated(client, owner):
    supplier = create_supplier(client, owner)
    invoice = create_invoice(client, owner, supplier["id"])
    response = client.get(
        f"/api/v1/invoices/{invoice['id']}/pdf", headers=owner.headers
    )
    assert response.status_code == 200
    assert response.headers["content-type"] == "application/pdf"
    assert response.content.startswith(b"%PDF")


def test_invoice_isolation_between_businesses(client, owner, second_owner):
    supplier = create_supplier(client, owner)
    invoice = create_invoice(client, owner, supplier["id"])
    assert client.get(
        f"/api/v1/invoices/{invoice['id']}", headers=second_owner.headers
    ).status_code == 404
    assert client.get("/api/v1/invoices", headers=second_owner.headers).json()["total"] == 0


def test_linked_supplier_sees_invoice_unlinked_does_not(client, owner, supplier_actor, second_owner):
    supplier = create_supplier(client, owner, email=supplier_actor.email)
    invoice = create_invoice(client, owner, supplier["id"])
    visible = client.get(
        f"/api/v1/invoices/{invoice['id']}", headers=supplier_actor.headers
    )
    assert visible.status_code == 200
    assert visible.json()["invoice_number"] == invoice["invoice_number"]
    other = create_supplier(client, second_owner, email=supplier_actor.email)
    assert client.get(
        f"/api/v1/invoices/{invoice['id']}", headers=second_owner.headers
    ).status_code == 404
    assert other["business_id"] == second_owner.business_id


def test_invalid_amount_returns_validation_error(client, owner):
    supplier = create_supplier(client, owner)
    response = client.post(
        "/api/v1/invoices",
        headers=owner.headers,
        json={
            "supplier_id": supplier["id"],
            "description": "Bad amount",
            "amount": "-5",
            "due_date": "2030-01-01T00:00:00",
        },
    )
    assert response.status_code == 422
