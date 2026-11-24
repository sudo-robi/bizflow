"""Authentication tests."""

from __future__ import annotations


def test_register_creates_user_business_and_owner_membership(client):
    response = client.post(
        "/api/v1/auth/register",
        json={
            "email": "new@example.com",
            "password": "Str0ngPassw0rd!",
            "full_name": "New User",
            "business_name": "New Co",
        },
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["token_type"] == "bearer"
    assert body["business"]["name"] == "New Co"
    assert body["user"]["email"] == "new@example.com"
    assert "password" not in str(body)


def test_login_returns_usable_token(client, owner):
    response = client.post(
        "/api/v1/auth/login",
        json={"email": owner.email, "password": "Str0ngPassw0rd!"},
    )
    assert response.status_code == 200, response.text
    token = response.json()["token"]
    me = client.get("/api/v1/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status_code == 200
    assert me.json()["user"]["id"] == owner.user_id


def test_login_wrong_password_is_unauthorized(client, owner):
    response = client.post(
        "/api/v1/auth/login", json={"email": owner.email, "password": "wrong-password"}
    )
    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHENTICATED"


def test_me_requires_auth(client):
    assert client.get("/api/v1/auth/me").status_code == 401


def test_duplicate_email_conflict(client, owner):
    response = client.post(
        "/api/v1/auth/register",
        json={
            "email": owner.email,
            "password": "Str0ngPassw0rd!",
            "full_name": "Duplicate",
        },
    )
    assert response.status_code == 409
    assert response.json()["code"] == "EMAIL_IN_USE"


def test_logout_returns_ok(client, owner):
    response = client.post("/api/v1/auth/logout", headers=owner.headers)
    assert response.status_code == 200
    assert response.json()["ok"] is True


def test_logout_revokes_the_presented_token(client, owner):
    """A token used for logout must not work afterwards (session revocation)."""
    client.post("/api/v1/auth/logout", headers=owner.headers)
    response = client.get("/api/v1/auth/me", headers=owner.headers)
    assert response.status_code == 401
    assert response.json()["code"] == "UNAUTHENTICATED"


def test_http_only_cookie_authenticates_browser_requests(client):
    """Browser flow: cookie set by register, no Authorization header sent."""
    import re

    response = client.post(
        "/api/v1/auth/register",
        json={
            "email": "cookie@example.com",
            "password": "Str0ngPassw0rd!",
            "full_name": "Cookie User",
            "business_name": "Cookie Co",
        },
    )
    assert response.status_code == 201
    set_cookie = response.headers.get("set-cookie", "")
    assert "bizflow_session=" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "SameSite=lax" in set_cookie
    token = re.search(r"bizflow_session=([^;]+)", set_cookie).group(1)
    client.cookies.clear()
    me = client.get("/api/v1/auth/me")
    assert me.status_code == 401
    client.cookies.set("bizflow_session", token)
    me = client.get("/api/v1/auth/me")
    assert me.status_code == 200
    assert me.json()["user"]["email"] == "cookie@example.com"


def test_password_is_hashed_not_stored_in_plaintext(client, owner):
    from tests.conftest import TestSession
    from app.models import User

    db = TestSession()
    try:
        stored = db.get(User, owner.user_id)
        assert stored is not None
        assert stored.password_hash != "Str0ngPassw0rd!"
        assert stored.password_hash.startswith("$2")
    finally:
        db.close()


def test_invalid_business_header_is_forbidden(client, owner, second_owner):
    response = client.get(
        "/api/v1/invoices",
        headers={**owner.headers, "X-Business-ID": second_owner.business_id},
    )
    assert response.status_code == 403
    assert response.json()["code"] == "FORBIDDEN"
