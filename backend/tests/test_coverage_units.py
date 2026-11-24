"""Edge-case unit tests for utilities, auth helpers, configuration and logging."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from decimal import Decimal

import jwt
import pytest

from app import models
from app.config import MAINNET_PASSPHRASE, TESTNET_PASSPHRASE, Settings, get_settings
from app.database import Base, create_tables, get_db
from app.errors import BizError
from app.security import (
    create_access_token,
    decode_access_token,
    hash_password,
    membership_for,
    revoke_token,
    supplier_scope,
    verify_password,
)
from app.services import notifications
from app.utils import (
    Pagination,
    add_seconds,
    from_json,
    jsonify,
    money_str,
    naive,
    next_reference,
    paginate,
    parse_datetime,
    to_decimal,
    utcnow,
)
from tests.conftest import TestSession

# --- utils ------------------------------------------------------------------

def test_naive_normalizes_aware_datetime_and_none():
    aware = datetime(2030, 1, 1, tzinfo=timezone.utc)
    plain = datetime(2030, 1, 1)
    assert naive(aware) == plain
    assert naive(plain) == plain
    assert naive(None) is None


def test_parse_datetime_accepts_empty_datetime_and_z_suffix():
    assert parse_datetime(None) is None
    assert parse_datetime("") is None
    assert parse_datetime(datetime(2030, 1, 1, tzinfo=timezone.utc)) == datetime(2030, 1, 1)
    assert parse_datetime("2030-01-01T00:00:00Z") == datetime(2030, 1, 1)
    assert parse_datetime("2030-01-01T00:00:00") == datetime(2030, 1, 1)


def test_parse_datetime_rejects_garbage():
    with pytest.raises(BizError) as exc:
        parse_datetime("not-a-date", "due_date")
    assert exc.value.code == "INVALID_DATE"
    assert "due_date" in exc.value.detail


def test_to_decimal_rejects_bool_none_and_garbage():
    for value in (True, None, "abc"):
        with pytest.raises(BizError) as exc:
            to_decimal(value)
        assert exc.value.code == "INVALID_AMOUNT"


def test_to_decimal_rejects_non_finite_and_non_positive():
    for value in ("NaN", "Infinity", "-Infinity"):
        with pytest.raises(BizError) as exc:
            to_decimal(value)
        assert "finite" in exc.value.detail
    with pytest.raises(BizError) as exc:
        to_decimal("-1", "amount", positive=True)
    assert "greater than zero" in exc.value.detail


def test_to_decimal_quantizes_to_money_quantum():
    assert to_decimal("1.123456789") == Decimal("1.1234568")


def test_money_str_normalizes_zero_and_trailing_zeros():
    assert money_str("0") == "0"
    assert money_str("-0") == "0"
    assert money_str("12.5000000") == "12.5"
    assert money_str(Decimal("0.0000001")) == "0.0000001"


def test_jsonify_handles_non_json_values():
    assert jsonify({"amount": Decimal("1.5")}) == '{"amount":"1.5"}'
    assert jsonify({"at": datetime(2030, 1, 1)}) == '{"at":"2030-01-01 00:00:00"}'


def test_from_json_handles_empty_valid_and_corrupt_values():
    assert from_json(None, "fallback") == "fallback"
    assert from_json("", "fallback") == "fallback"
    assert from_json('{"a": 1}', {}) == {"a": 1}
    with pytest.raises(BizError) as exc:
        from_json("{bad", {})
    assert exc.value.code == "CORRUPT_DATA"


def test_pagination_offset_and_paginate():
    page = Pagination(page=3, per_page=20)
    assert page.offset == 40
    result = paginate([1, 2], 10, page)
    assert result == {"items": [1, 2], "total": 10, "page": 3, "per_page": 20}


def test_next_reference_skips_existing_candidates():
    db = TestSession()
    try:
        from tests.conftest import register
        from fastapi.testclient import TestClient
        from app.main import app

        with TestClient(app, raise_server_exceptions=False) as client:
            actor = register(client)
        supplier_id = _make_supplier(db, actor.business_id)
        for number in (2, 3):
            db.add(models.PaymentAgreement(
                business_id=actor.business_id,
                supplier_id=supplier_id,
                reference=f"AGR-{utcnow().year}-{number:04d}",
                title="Existing", total_amount=Decimal("1"), asset_code="XLM",
                expiry_date=utcnow() + timedelta(days=1), status="draft",
            ))
        db.commit()
        assert next_reference(
            db, models.PaymentAgreement, models.PaymentAgreement.reference, "AGR"
        ) == f"AGR-{utcnow().year}-0004"
    finally:
        db.close()


def _make_supplier(db, business_id):
    supplier = models.Supplier(
        business_id=business_id, business_name="S", wallet_address="G" + "a" * 55,
        status="active",
    )
    db.add(supplier)
    db.flush()
    return supplier.id


def test_add_seconds_returns_future_naive_utc():
    target = add_seconds(60)
    assert naive(target) == target
    assert target > utcnow()


# --- security ---------------------------------------------------------------

def test_password_hash_round_trip_and_corrupt_hash():
    hashed = hash_password("Str0ngPassw0rd!")
    assert verify_password("Str0ngPassw0rd!", hashed) is True
    assert verify_password("wrong", hashed) is False
    assert verify_password("anything", "not-a-hash") is False


def test_token_with_extra_claims_round_trips():
    token = create_access_token("user-1", {"scope": "admin"})
    assert decode_access_token(token)["scope"] == "admin"


def test_invalid_and_missing_subject_tokens_are_rejected():
    with pytest.raises(BizError) as exc:
        decode_access_token("garbage")
    assert exc.value.status_code == 401
    token = jwt.encode({"exp": 9999999999}, get_settings().jwt_secret, algorithm="HS256")
    with pytest.raises(BizError) as exc:
        decode_access_token(token)
    assert "Invalid authentication token" in exc.value.detail


def test_revoke_token_handles_missing_jti_and_already_revoked():
    db = TestSession()
    try:
        token = jwt.encode({"sub": "u", "exp": 9999999999}, get_settings().jwt_secret, algorithm="HS256")
        revoke_token(db, token, "u")
        assert db.query(models.RevokedToken).count() == 0
        normal = create_access_token("u")
        revoke_token(db, normal, "u")
        assert db.query(models.RevokedToken).count() == 1
        revoke_token(db, normal, "u")
        assert db.query(models.RevokedToken).count() == 1
    finally:
        db.close()


def test_membership_for_requires_business_header():
    db = TestSession()
    try:
        with pytest.raises(BizError) as exc:
            membership_for(db, models.User(id="u"), "")
        assert exc.value.code == "MISSING_BUSINESS"
    finally:
        db.close()


def test_supplier_scope_returns_supplier_ids_for_supplier_role():
    db = TestSession()
    try:
        from fastapi.testclient import TestClient
        from app.main import app
        from tests.conftest import register, create_supplier

        with TestClient(app, raise_server_exceptions=False) as client:
            actor = register(client)
            supplier = create_supplier(client, actor, email=actor.email)
        from sqlalchemy import select
        membership = db.scalar(
            select(models.BusinessMember).where(models.BusinessMember.business_id == actor.business_id)
        )
        user = db.get(models.User, actor.user_id)
        membership.role = "supplier"
        assert supplier_scope(db, user, membership) == [supplier["id"]]
        membership.role = "finance_manager"
        assert supplier_scope(db, user, membership) is None
    finally:
        db.close()


# --- config / database ------------------------------------------------------

def test_rate_limit_normalization_and_testnet_guard():
    settings = Settings(
        jwt_secret="32-byte-minimum-secret-for-tests",
        rate_limit_per_minute="120",
        stellar_escrow_contract_id="",
    )
    assert settings.rate_limit_per_minute == "120/minute"
    assert settings.cors_origins_list == [o.strip() for o in settings.cors_origins.split(",")]
    assert settings.escrow_configured is False
    assert Settings(jwt_secret="dev-only-jwt-secret-change-me").jwt_secret == "dev-only-jwt-secret-change-me"
    with pytest.raises(ValueError, match="Unsupported Stellar network"):
        Settings(
            jwt_secret="32-byte-minimum-secret-for-tests",
            stellar_network_passphrase="Some Other Network",
        )
    with pytest.raises(ValueError, match="mainnet"):
        Settings(
            jwt_secret="32-byte-minimum-secret-for-tests",
            stellar_soroban_rpc_url="https://soroban-mainnet.example.org",
        )
    with pytest.raises(ValueError, match="testnet"):
        Settings(jwt_secret="32-byte-minimum-secret-for-tests", stellar_network_passphrase=MAINNET_PASSPHRASE)
    assert TESTNET_PASSPHRASE == get_settings().stellar_network_passphrase


def test_create_tables_and_get_db_yield_a_session():
    create_tables()
    assert Base.metadata.tables
    generator = get_db()
    session = next(generator)
    try:
        assert session is not None
    finally:
        generator.close()


# --- notification helpers ---------------------------------------------------

def test_notify_truncates_long_title():
    db = TestSession()
    try:
        notification = notifications.notify(db, "b", "u", "T" * 300, "message")
        assert len(notification.title) == 255
    finally:
        db.close()


def test_notify_business_targets_active_members_with_users():
    db = TestSession()
    try:
        from tests.conftest import register

        from fastapi.testclient import TestClient
        from app.main import app

        with TestClient(app, raise_server_exceptions=False) as client:
            actor = register(client)
        created = notifications.notify_business(db, actor.business_id, "Title", "Body")
        assert len(created) == 1
        assert created[0].user_id == actor.user_id
    finally:
        db.close()


def test_log_event_swallows_audit_failures(monkeypatch):
    db = TestSession()
    try:
        def boom(*args, **kwargs):
            raise RuntimeError("db gone")

        monkeypatch.setattr(notifications, "audit", boom)
        notifications.log_event(db, "b", "u", "action", "entity", "id", {"k": "v"})
    finally:
        db.close()


def test_log_event_writes_audit_entry():
    db = TestSession()
    try:
        notifications.log_event(db, "b", None, "action", "entity", "id", {"k": "v"})
        db.commit()
        assert db.query(models.AuditLog).filter_by(action="action").count() == 1
    finally:
        db.close()
