"""Supplier CRUD, validation and business isolation tests."""

from __future__ import annotations

from stellar_sdk import Keypair

from tests.conftest import create_invoice, create_supplier


def test_create_supplier(client, owner):
    supplier = create_supplier(client, owner)
    assert supplier["status"] == "active"
    assert supplier["wallet_address"].startswith("G")
    assert supplier["business_id"] == owner.business_id


def test_invalid_wallet_rejected(client, owner):
    response = client.post(
        "/api/v1/suppliers",
        headers=owner.headers,
        json={"business_name": "Bad", "wallet_address": "not-a-key"},
    )
    assert response.status_code == 422


def test_duplicate_wallet_conflict(client, owner):
    wallet = Keypair.random().public_key
    create_supplier(client, owner, wallet=wallet)
    response = client.post(
        "/api/v1/suppliers",
        headers=owner.headers,
        json={"business_name": "Dup", "wallet_address": wallet},
    )
    assert response.status_code == 409


def test_search_and_pagination(client, owner):
    create_supplier(client, owner)
    create_supplier(client, owner)
    response = client.get(
        "/api/v1/suppliers?search=Acme&page=1&per_page=1", headers=owner.headers
    )
    assert response.status_code == 200
    body = response.json()
    assert body["total"] == 2
    assert len(body["items"]) == 1
    assert body["per_page"] == 1


def test_supplier_is_isolated_between_businesses(client, owner, second_owner):
    supplier = create_supplier(client, owner)
    response = client.get(
        f"/api/v1/suppliers/{supplier['id']}", headers=second_owner.headers
    )
    assert response.status_code == 404
    listing = client.get("/api/v1/suppliers", headers=second_owner.headers)
    assert listing.json()["total"] == 0


def test_archive_requires_owner_admin(client, owner, finance_actor):
    supplier = create_supplier(client, owner)
    denied = client.post(
        f"/api/v1/suppliers/{supplier['id']}/archive", headers=finance_actor.headers
    )
    assert denied.status_code == 403
    allowed = client.post(
        f"/api/v1/suppliers/{supplier['id']}/archive", headers=owner.headers
    )
    assert allowed.status_code == 200
    assert allowed.json()["status"] == "archived"


def test_supplier_related_lists(client, owner):
    supplier = create_supplier(client, owner)
    invoices = client.get(
        f"/api/v1/suppliers/{supplier['id']}/invoices", headers=owner.headers
    )
    payments = client.get(
        f"/api/v1/suppliers/{supplier['id']}/payments", headers=owner.headers
    )
    assert invoices.status_code == 200 and invoices.json()["total"] == 0
    assert payments.status_code == 200 and payments.json()["total"] == 0
