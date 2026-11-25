"""Pytest fixtures: real in-memory SQLite DB, isolated per test; mocks only network."""

from __future__ import annotations

import os
import uuid
from dataclasses import dataclass

os.environ["USE_SQLITE"] = "true"
os.environ["SQLITE_PATH"] = ":memory:"
os.environ["JWT_SECRET"] = "test-jwt-secret-at-least-32-bytes-long"
os.environ["RATE_LIMIT_PER_MINUTE"] = "100000/minute"
os.environ["CORS_ORIGINS"] = "http://localhost:3000"
# These suites stub the chain boundary at the *event* layer (verification.py).
# Post-operation contract-state reads are a separate RPC boundary and are covered
# by dedicated tests that explicitly re-enable the flag with a mocked getter.
os.environ["ENFORCE_ESCROW_STATE_VERIFICATION"] = "false"

from stellar_sdk import Keypair as _Keypair, StrKey as _StrKey

os.environ["STELLAR_ESCROW_CONTRACT_ID"] = _StrKey.encode_contract(
    _Keypair.random().raw_public_key()
)

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker
from sqlalchemy.pool import StaticPool
from stellar_sdk import Account, Keypair, StrKey

from app import models
from app.database import Base, get_db
from app.main import app
from app.services import stellar

CONTRACT_ID = os.environ["STELLAR_ESCROW_CONTRACT_ID"]

TEST_ENGINE = create_engine(
    "sqlite://", connect_args={"check_same_thread": False}, poolclass=StaticPool
)
TestSession = sessionmaker(bind=TEST_ENGINE, autoflush=False, expire_on_commit=False)


@pytest.fixture(autouse=True)
def database():
    Base.metadata.create_all(TEST_ENGINE)

    def override_get_db():
        db = TestSession()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    yield
    app.dependency_overrides.clear()
    Base.metadata.drop_all(TEST_ENGINE)


@pytest.fixture
def client(database):
    with TestClient(app, raise_server_exceptions=False) as test_client:
        yield test_client


@dataclass
class Actor:
    token: str
    business_id: str
    user_id: str
    email: str

    @property
    def headers(self) -> dict[str, str]:
        return {
            "Authorization": f"Bearer {self.token}",
            "X-Business-ID": self.business_id,
        }


def register(client: TestClient, *, business: bool = True, role: str | None = None) -> Actor:
    email = f"user-{uuid.uuid4().hex[:12]}@example.com"
    body = {
        "email": email,
        "password": "Str0ngPassw0rd!",
        "full_name": "Test User",
    }
    if business:
        body["business_name"] = f"Business {uuid.uuid4().hex[:8]}"
    response = client.post("/api/v1/auth/register", json=body)
    assert response.status_code == 201, response.text
    data = response.json()
    return Actor(
        token=data["token"],
        business_id=data["business"]["id"] if business else "",
        user_id=data["user"]["id"],
        email=email,
    )


@pytest.fixture
def owner(client) -> Actor:
    return register(client)


@pytest.fixture
def second_owner(client) -> Actor:
    return register(client)


@pytest.fixture
def finance_actor(client, owner) -> Actor:
    email = f"finance-{uuid.uuid4().hex[:12]}@example.com"
    response = client.post(
        f"/api/v1/businesses/{owner.business_id}/members",
        headers=owner.headers,
        json={"email": email, "role": "finance_manager"},
    )
    assert response.status_code == 201, response.text
    login = client.post(
        "/api/v1/auth/login", json={"email": email, "password": "Str0ngPassw0rd!"}
    )
    # Unknown users are pending invites; register to activate, then log in.
    assert login.status_code == 401
    created = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Str0ngPassw0rd!", "full_name": "Finance User"},
    )
    assert created.status_code == 201, created.text
    return Actor(
        token=created.json()["token"],
        business_id=owner.business_id,
        user_id=created.json()["user"]["id"],
        email=email,
    )


@pytest.fixture
def supplier_actor(client, owner) -> Actor:
    email = f"supplier-{uuid.uuid4().hex[:12]}@example.com"
    response = client.post(
        f"/api/v1/businesses/{owner.business_id}/members",
        headers=owner.headers,
        json={"email": email, "role": "supplier"},
    )
    assert response.status_code == 201, response.text
    created = client.post(
        "/api/v1/auth/register",
        json={"email": email, "password": "Str0ngPassw0rd!", "full_name": "Supplier User"},
    )
    assert created.status_code == 201, created.text
    return Actor(
        token=created.json()["token"],
        business_id=owner.business_id,
        user_id=created.json()["user"]["id"],
        email=email,
    )


def create_supplier(client: TestClient, actor: Actor, email: str | None = None, wallet: str | None = None) -> dict:
    response = client.post(
        "/api/v1/suppliers",
        headers=actor.headers,
        json={
            "business_name": "Acme Supply",
            "contact_name": "Jane Doe",
            "email": email or f"supplier-{uuid.uuid4().hex[:8]}@example.com",
            "wallet_address": wallet or Keypair.random().public_key,
            "country": "PT",
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


def create_invoice(client: TestClient, actor: Actor, supplier_id: str, amount: str = "1250.50") -> dict:
    response = client.post(
        "/api/v1/invoices",
        headers=actor.headers,
        json={
            "supplier_id": supplier_id,
            "description": "Consulting services",
            "amount": amount,
            "asset_code": "XLM",
            "due_date": "2030-12-31T00:00:00",
            "items": [
                {"description": "Work", "quantity": "1", "unit_price": amount}
            ],
        },
    )
    assert response.status_code == 201, response.text
    return response.json()


class FakeHorizon:
    """Horizon response objects controlled by the test; no real network calls."""

    def __init__(self, source: str, destination: str, amount: str, memo: str):
        self.source = source
        self.destination = destination
        self.amount = amount
        self.memo = memo
        self.last_hash = ""
        self.ledger = 12345

    def load_account(self, account_id: str):
        return Account(account_id, 1)

    def fetch_base_fee(self) -> int:
        return 100

    def submit_transaction(self, xdr: str):
        return {"hash": self.last_hash, "successful": True, "ledger": self.ledger}

    def transactions(self):
        return self

    def operations(self):
        return self

    def transaction(self, tx_hash: str):
        self.last_hash = tx_hash
        return self

    def for_transaction(self, tx_hash: str):
        self.last_hash = tx_hash
        return self

    def call(self):
        return {
            "hash": self.last_hash,
            "successful": True,
            "ledger": self.ledger,
            "source_account": self.source,
            "memo": self.memo,
            "memo_type": "text",
        }

    def operations_response(self):
        return {
            "_embedded": {
                "records": [
                    {
                        "type": "payment",
                        "from": self.source,
                        "to": self.destination,
                        "asset_type": "native",
                        "amount": self.amount,
                        "transaction_successful": True,
                    }
                ]
            }
        }


@pytest.fixture
def fake_horizon(monkeypatch):
    """Patch only the Horizon boundary; real XDR building and verification run."""
    source = Keypair.random().public_key
    destination = Keypair.random().public_key
    horizon = FakeHorizon(source, destination, "1250.5000000", "INV-2026-0001")

    class PatchedHorizon(FakeHorizon):
        def operations(self):
            return _Ops(self)

    class _Ops:
        def __init__(self, parent):
            self.parent = parent

        def for_transaction(self, tx_hash: str):
            self.parent.last_hash = tx_hash
            return self

        def call(self):
            return self.parent.operations_response()

    patched = PatchedHorizon(source, destination, "1250.5000000", "INV-2026-0001")
    monkeypatch.setattr(stellar, "horizon_server", lambda: patched)
    return patched
