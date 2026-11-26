"""Security closure regressions: invitations, session-bound CSRF and request-id logs."""

from __future__ import annotations

import json
import logging
import uuid
from datetime import timedelta

import jwt
from sqlalchemy import select

from app import models
from app.config import get_settings
from app.database import get_db
from app.main import (
    RequestIdFilter,
    RequestIdJsonFormatter,
    app,
    request_id_var,
)
from app.security import csrf_token_for_jwt
from app.utils import utcnow
from tests.conftest import TestSession

OWNER_PASSWORD = "Str0ngPassw0rd!"


def _invite(client, owner, role: str = "admin") -> tuple[str, str]:
    email = f"closure-{uuid.uuid4().hex[:10]}@example.com"
    response = client.post(
        f"/api/v1/businesses/{owner.business_id}/members",
        headers=owner.headers,
        json={"email": email, "role": role},
    )
    assert response.status_code == 201, response.text
    body = response.json()
    assert body["status"] == "invited"
    return email, body["invitation_token"]


def _register(client, email: str) -> dict:
    response = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": OWNER_PASSWORD, "full_name": "Invitee"},
    )
    assert response.status_code == 201, response.text
    return response.json()


def _accept(client, owner, token: str, headers: dict[str, str]):
    return client.post(
        f"/api/v1/businesses/{owner.business_id}/members/invitations/{token}/accept",
        headers=headers,
    )


# --- (A) Invitation privilege inheritance ----------------------------------

def test_register_alone_grants_no_membership_for_invited_email(client, owner):
    email, token = _invite(client, owner, role="owner")
    body = _register(client, email)
    headers = {"Authorization": f"Bearer {body['token']}"}

    me = client.get("/api/v1/auth/me", headers=headers)
    assert me.status_code == 200
    assert me.json()["memberships"] == []
    assert client.get("/api/v1/businesses", headers=headers).json() == []

    db = TestSession()
    try:
        member = db.scalar(select(models.BusinessMember).where(models.BusinessMember.email == email))
        assert member is not None
        assert member.status == "invited"
        assert member.user_id is None
        assert member.invitation_token != token  # only a digest is persisted
    finally:
        db.close()

    accepted = _accept(client, owner, token, headers)
    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["role"] == "owner"
    assert "invitation_token" not in accepted.json()
    me = client.get("/api/v1/auth/me", headers=headers)
    assert len(me.json()["memberships"]) == 1
    assert me.json()["memberships"][0]["role"] == "owner"


def test_accept_rejects_wrong_token_wrong_email_and_replay(client, owner):
    email, token = _invite(client, owner, role="finance_manager")
    body = _register(client, email)
    invitee_headers = {"Authorization": f"Bearer {body['token']}"}

    wrong_token = _accept(client, owner, "not-the-token", invitee_headers)
    assert wrong_token.status_code == 400
    assert wrong_token.json()["code"] == "INVITATION_INVALID"

    # The inviter cannot accept on the invitee's behalf, even with the token.
    on_behalf = _accept(client, owner, token, owner.headers)
    assert on_behalf.status_code == 403
    assert on_behalf.json()["code"] == "FORBIDDEN"

    assert _accept(client, owner, token, invitee_headers).status_code == 200
    replay = _accept(client, owner, token, invitee_headers)
    assert replay.status_code == 400
    assert replay.json()["code"] == "INVITATION_INVALID"

    listing = client.get(
        f"/api/v1/businesses/{owner.business_id}/members", headers=owner.headers
    ).json()
    member = next(m for m in listing if m["email"] == email)
    assert member["status"] == "active"
    assert "invitation_token" not in member


def test_expired_invitation_cannot_be_accepted(client, owner):
    email, token = _invite(client, owner, role="admin")
    body = _register(client, email)
    headers = {"Authorization": f"Bearer {body['token']}"}
    db = TestSession()
    try:
        member = db.scalar(select(models.BusinessMember).where(models.BusinessMember.email == email))
        member.invitation_expires_at = utcnow() - timedelta(seconds=1)
        db.commit()
    finally:
        db.close()

    expired = _accept(client, owner, token, headers)
    assert expired.status_code == 400
    assert expired.json()["code"] == "INVITATION_EXPIRED"
    assert _accept(client, owner, token, headers).status_code == 400
    assert client.get("/api/v1/auth/me", headers=headers).json()["memberships"] == []


def test_legacy_pending_membership_is_not_activated_by_registration(client, owner):
    email = f"legacy-{uuid.uuid4().hex[:10]}@example.com"
    db = TestSession()
    try:
        db.add(
            models.BusinessMember(
                business_id=owner.business_id,
                user_id=None,
                email=email,
                role="owner",
                status="pending",
                invited_by=owner.user_id,
            )
        )
        db.commit()
    finally:
        db.close()

    body = _register(client, email)
    headers = {"Authorization": f"Bearer {body['token']}"}
    assert client.get("/api/v1/auth/me", headers=headers).json()["memberships"] == []
    db = TestSession()
    try:
        member = db.scalar(select(models.BusinessMember).where(models.BusinessMember.email == email))
        assert member.status == "pending"
        assert member.user_id is None
    finally:
        db.close()


# --- (B) Session-bound CSRF -------------------------------------------------

def test_csrf_token_is_bound_to_the_presented_session(client):
    owner_body = _register(client, f"a-{uuid.uuid4().hex[:10]}@example.com")
    session_a = client.cookies.get("bizflow_session")
    csrf_a = client.cookies.get("bizflow_csrf")
    assert csrf_a == csrf_token_for_jwt(session_a)

    _register(client, f"b-{uuid.uuid4().hex[:10]}@example.com")
    csrf_b = client.cookies.get("bizflow_csrf")
    client.cookies.set("bizflow_session", session_a)

    swapped = client.post(
        "/api/v1/businesses",
        json={"name": "Swapped"},
        headers={"X-CSRF-Token": csrf_b},
    )
    assert swapped.status_code == 403
    assert swapped.json()["code"] == "CSRF_TOKEN_INVALID"

    valid = client.post(
        "/api/v1/businesses",
        json={"name": "Valid"},
        headers={"X-CSRF-Token": csrf_a},
    )
    assert valid.status_code == 201, valid.text
    assert owner_body["user"]["id"]


def test_csrf_rejects_expired_and_forged_session_cookies(client):
    _register(client, f"cookie-{uuid.uuid4().hex[:10]}@example.com")
    settings = get_settings()
    expired = jwt.encode(
        {
            "sub": "some-user",
            "jti": "expired-jti",
            "iat": 1,
            "exp": 2,
        },
        settings.jwt_secret,
        algorithm=settings.jwt_algorithm,
    )
    for bad_cookie in (expired, "forged.session.value"):
        client.cookies.set(settings.session_cookie_name, bad_cookie)
        client.cookies.set("bizflow_csrf", "0" * 64)
        response = client.post(
            "/api/v1/businesses",
            json={"name": "Rejected"},
            headers={"X-CSRF-Token": "0" * 64},
        )
        assert response.status_code == 403
        assert response.json()["code"] == "CSRF_TOKEN_INVALID"


def test_logout_revokes_both_tokens_and_clears_cookies(client):
    body = _register(client, f"logout-{uuid.uuid4().hex[:10]}@example.com")
    cookie = client.cookies.get("bizflow_session")
    csrf = client.cookies.get("bizflow_csrf")
    headers = {"X-CSRF-Token": csrf}

    logout = client.post("/api/v1/auth/logout", headers=headers)
    assert logout.status_code == 200, logout.text
    set_cookies = logout.headers.get_list("set-cookie")
    assert any("bizflow_session=" in value for value in set_cookies)
    assert any("bizflow_csrf=" in value for value in set_cookies)

    # The revoked session cannot be resurrected with its old CSRF token.
    client.cookies.set("bizflow_session", cookie)
    client.cookies.set("bizflow_csrf", csrf)
    me = client.get("/api/v1/auth/me")
    assert me.status_code == 401
    mutated = client.post("/api/v1/businesses", json={"name": "Revived"}, headers=headers)
    assert mutated.status_code == 401
    assert body["token"]


def test_allowed_origin_with_valid_token_is_accepted(client):
    _register(client, f"origin-{uuid.uuid4().hex[:10]}@example.com")
    token = client.cookies.get("bizflow_csrf")
    response = client.post(
        "/api/v1/businesses",
        json={"name": "Allowed origin"},
        headers={"Origin": "http://localhost:3000", "X-CSRF-Token": token},
    )
    assert response.status_code == 201, response.text


# --- (C) Observability ------------------------------------------------------

def test_every_log_record_carries_request_id(client):
    class Capture(logging.Handler):
        def __init__(self):
            super().__init__()
            self.lines: list[str] = []

        def emit(self, record: logging.LogRecord) -> None:
            self.lines.append(self.format(record))

    handler = Capture()
    handler.setFormatter(RequestIdJsonFormatter())
    handler.addFilter(RequestIdFilter())
    root = logging.getLogger()
    root.addHandler(handler)
    try:
        success = client.get("/health", headers={"X-Request-ID": "success-123"})
        assert success.status_code == 200
        _register(client, f"logs-{uuid.uuid4().hex[:10]}@example.com")
        blocked = client.post(
            "/api/v1/businesses",
            json={"name": "Blocked"},
            headers={"X-Request-ID": "blocked-456"},
        )
        assert blocked.status_code == 403
        assert blocked.json()["code"] == "CSRF_TOKEN_MISSING"
        try:
            raise RuntimeError("simulated unexpected error")
        except RuntimeError:
            token = request_id_var.set("error-789")
            try:
                logging.getLogger("app.test.unexpected").exception("unexpected")
            finally:
                request_id_var.reset(token)

        records = [json.loads(line) for line in handler.lines]
        assert records and all("request_id" in record for record in records)
        ids = {record["request_id"] for record in records}
        assert "success-123" in ids
        assert "blocked-456" in ids
        assert "error-789" in ids
        assert any("exception" in record for record in records)
        assert any(
            isinstance(installed, RequestIdFilter)
            for installed_handler in root.handlers
            for installed in installed_handler.filters
        )
    finally:
        root.removeHandler(handler)


def test_readiness_success_reports_ready(client):
    response = client.get("/health/ready", headers={"X-Request-ID": "ready-ok"})
    assert response.status_code == 200
    assert response.json()["status"] == "ready"
    assert response.json()["database"] == "ok"
    assert response.headers["X-Request-ID"] == "ready-ok"


def test_readiness_database_failure_returns_503(client):
    class BrokenDb:
        def execute(self, *_args, **_kwargs):
            raise RuntimeError("database unavailable")

    def broken_get_db():
        yield BrokenDb()

    original = app.dependency_overrides.get(get_db)
    app.dependency_overrides[get_db] = broken_get_db
    try:
        response = client.get("/health/ready", headers={"X-Request-ID": "ready-bad"})
    finally:
        if original is None:
            app.dependency_overrides.pop(get_db, None)
        else:
            app.dependency_overrides[get_db] = original
    assert response.status_code == 503
    assert response.json()["status"] == "unavailable"
    assert response.json()["database"] == "unavailable"
    assert response.headers["X-Request-ID"] == "ready-bad"
