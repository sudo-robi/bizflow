"""Business and membership tests."""

from __future__ import annotations

import uuid


def test_list_businesses_returns_member_business(client, owner):
    response = client.get("/api/v1/businesses", headers=owner.headers)
    assert response.status_code == 200, response.text
    assert any(item["id"] == owner.business_id for item in response.json())


def test_create_business_makes_creator_owner(client, owner):
    response = client.post(
        "/api/v1/businesses",
        headers=owner.headers,
        json={"name": "Second Business", "country": "US", "currency": "eur"},
    )
    assert response.status_code == 201, response.text
    assert response.json()["currency"] == "EUR"
    me = client.get("/api/v1/auth/me", headers=owner.headers)
    roles = {m["business"]["id"]: m["role"] for m in me.json()["memberships"]}
    assert roles[response.json()["id"]] == "owner"


def test_add_unknown_member_creates_pending_invite_activated_on_register(client, owner):
    email = f"invite-{uuid.uuid4().hex[:8]}@example.com"
    invited = client.post(
        f"/api/v1/businesses/{owner.business_id}/members",
        headers=owner.headers,
        json={"email": email, "role": "finance_manager"},
    )
    assert invited.status_code == 201, invited.text
    assert invited.json()["status"] == "pending"
    registered = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Str0ngPassw0rd!", "full_name": "Invited"},
    )
    assert registered.status_code == 201
    members = client.get(
        f"/api/v1/businesses/{owner.business_id}/members", headers=owner.headers
    ).json()
    member = next(m for m in members if m["email"] == email)
    assert member["status"] == "active"
    assert member["role"] == "finance_manager"


def test_non_member_cannot_read_business(client, owner, second_owner):
    response = client.get(
        f"/api/v1/businesses/{owner.business_id}", headers=second_owner.headers
    )
    assert response.status_code == 403


def test_finance_cannot_update_business(client, owner, finance_actor):
    response = client.patch(
        f"/api/v1/businesses/{owner.business_id}",
        headers=finance_actor.headers,
        json={"name": "Hijacked"},
    )
    assert response.status_code == 403


def test_owner_can_update_business_and_last_owner_cannot_be_removed(client, owner):
    updated = client.patch(
        f"/api/v1/businesses/{owner.business_id}",
        headers=owner.headers,
        json={"legal_name": "Legal Name Ltd"},
    )
    assert updated.status_code == 200
    assert updated.json()["legal_name"] == "Legal Name Ltd"
    removed = client.delete(
        f"/api/v1/businesses/{owner.business_id}/members/{owner.user_id}",
        headers=owner.headers,
    )
    assert removed.status_code == 400
    assert removed.json()["code"] == "LAST_OWNER"
