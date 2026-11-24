"""Payment preparation, verification, duplicate prevention and receipts."""

from __future__ import annotations

from tests.conftest import create_invoice, create_supplier


def _prepare(client, owner, supplier, source, amount="1250.50"):
    invoice = create_invoice(client, owner, supplier["id"], amount=amount)
    response = client.post(
        "/api/v1/payments/prepare",
        headers=owner.headers,
        json={"invoice_id": invoice["id"], "source_account": source},
    )
    assert response.status_code == 201, response.text
    return invoice, response.json()


def test_prepare_stores_pending_payment_and_xdr(client, owner, fake_horizon):
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    invoice, prepared = _prepare(client, owner, supplier, fake_horizon.source)
    assert prepared["hash"] and len(prepared["hash"]) == 64
    assert prepared["xdr"]
    payment = client.get(
        f"/api/v1/payments/{prepared['payment_id']}", headers=owner.headers
    ).json()
    assert payment["status"] == "prepared"
    assert payment["memo"] == invoice["invoice_number"]
    assert payment["amount"] == "1250.5"


def test_duplicate_payment_for_invoice_amount_is_rejected(client, owner, fake_horizon):
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    invoice = create_invoice(client, owner, supplier["id"])
    body = {"invoice_id": invoice["id"], "source_account": fake_horizon.source}
    assert client.post("/api/v1/payments/prepare", headers=owner.headers, json=body).status_code == 201
    duplicate = client.post(
        "/api/v1/payments/prepare", headers=owner.headers, json=body
    )
    assert duplicate.status_code == 409
    assert duplicate.json()["code"] == "DUPLICATE_PAYMENT"


def test_submit_confirmed_payment_sets_invoice_paid(client, owner, fake_horizon):
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    invoice, prepared = _prepare(client, owner, supplier, fake_horizon.source)
    fake_horizon.amount = "1250.5000000"
    fake_horizon.memo = invoice["invoice_number"]
    submit = client.post(
        f"/api/v1/payments/{prepared['payment_id']}/submit",
        headers=owner.headers,
        json={"signed_xdr": prepared["xdr"]},
    )
    assert submit.status_code == 200, submit.text
    assert submit.json()["status"] == "confirmed"
    detail = client.get(
        f"/api/v1/invoices/{invoice['id']}", headers=owner.headers
    ).json()
    assert detail["status"] == "paid"
    assert detail["amount_paid"] == "1250.5"
    transactions = client.get("/api/v1/transactions", headers=owner.headers).json()
    assert transactions["total"] == 1
    assert transactions["items"][0]["successful"] is True


def test_failed_transaction_never_credits_invoice(client, owner, fake_horizon, monkeypatch):
    from app.services import stellar

    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    invoice, prepared = _prepare(client, owner, supplier, fake_horizon.source)

    def failed_submit(signed_xdr):
        return stellar.ChainResult(
            hash=prepared["hash"], status="failed", confirmed=True, successful=False,
            reason="tx_failed",
        )

    monkeypatch.setattr(stellar, "submit_transaction", failed_submit)
    submit = client.post(
        f"/api/v1/payments/{prepared['payment_id']}/submit",
        headers=owner.headers,
        json={"signed_xdr": prepared["xdr"]},
    )
    assert submit.status_code == 409
    detail = client.get(
        f"/api/v1/invoices/{invoice['id']}", headers=owner.headers
    ).json()
    assert detail["status"] == "pending" or detail["status"] == "draft"
    assert detail["amount_paid"] == "0"


def test_hash_mismatch_rejected(client, owner, fake_horizon):
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    _, prepared = _prepare(client, owner, supplier, fake_horizon.source)
    other = client.post(
        "/api/v1/auth/register",
        json={"email": "other@example.com", "password": "Str0ngPassw0rd!", "full_name": "Other"},
    )
    bad_xdr = prepared["xdr"][:-4] + "AAAA"
    response = client.post(
        f"/api/v1/payments/{prepared['payment_id']}/submit",
        headers=owner.headers,
        json={"signed_xdr": bad_xdr},
    )
    assert response.status_code in (400, 409)
    assert other.status_code == 201


def test_confirmed_payment_receipt_pdf(client, owner, fake_horizon):
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    invoice, prepared = _prepare(client, owner, supplier, fake_horizon.source)
    fake_horizon.amount = "1250.5000000"
    fake_horizon.memo = invoice["invoice_number"]
    client.post(
        f"/api/v1/payments/{prepared['payment_id']}/submit",
        headers=owner.headers,
        json={"signed_xdr": prepared["xdr"]},
    )
    pdf = client.get(
        f"/api/v1/payments/{prepared['payment_id']}/receipt", headers=owner.headers
    )
    assert pdf.status_code == 200
    assert pdf.content.startswith(b"%PDF")


def test_partial_payments_settle_invoice_only_when_fully_covered(client, owner, fake_horizon):
    """Workflow 2: two verified partial payments, then paid — never before."""
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    invoice = create_invoice(client, owner, supplier["id"], amount="1250.50")

    def prepare(amount):
        return client.post(
            "/api/v1/payments/prepare",
            headers=owner.headers,
            json={
                "invoice_id": invoice["id"],
                "source_account": fake_horizon.source,
                "amount": amount,
            },
        )

    first = prepare("500")
    assert first.status_code == 201, first.text
    fake_horizon.amount = "500.0000000"
    fake_horizon.memo = invoice["invoice_number"]
    submitted = client.post(
        f"/api/v1/payments/{first.json()['payment_id']}/submit",
        headers=owner.headers,
        json={"signed_xdr": first.json()["xdr"]},
    )
    assert submitted.status_code == 200, submitted.text
    detail = client.get(f"/api/v1/invoices/{invoice['id']}", headers=owner.headers).json()
    assert detail["status"] == "partially_paid"
    assert detail["amount_paid"] == "500"
    assert detail["remaining_amount"] == "750.5"

    second = prepare("750.5")
    assert second.status_code == 201, second.text
    fake_horizon.amount = "750.5000000"
    fake_horizon.memo = invoice["invoice_number"]
    submitted2 = client.post(
        f"/api/v1/payments/{second.json()['payment_id']}/submit",
        headers=owner.headers,
        json={"signed_xdr": second.json()["xdr"]},
    )
    assert submitted2.status_code == 200, submitted2.text
    detail = client.get(f"/api/v1/invoices/{invoice['id']}", headers=owner.headers).json()
    assert detail["status"] == "paid"
    assert detail["amount_paid"] == "1250.5"
    assert detail["remaining_amount"] == "0"


def test_overpayment_and_duplicate_partial_amount_are_rejected(client, owner, fake_horizon):
    supplier = create_supplier(client, owner, wallet=fake_horizon.destination)
    invoice = create_invoice(client, owner, supplier["id"], amount="100")

    body = {
        "invoice_id": invoice["id"],
        "source_account": fake_horizon.source,
        "amount": "101",
    }
    over = client.post("/api/v1/payments/prepare", headers=owner.headers, json=body)
    assert over.status_code == 400
    assert over.json()["code"] == "OVERPAYMENT"

    body["amount"] = "40"
    assert client.post("/api/v1/payments/prepare", headers=owner.headers, json=body).status_code == 201
    duplicate = client.post("/api/v1/payments/prepare", headers=owner.headers, json=body)
    assert duplicate.status_code == 409
    assert duplicate.json()["code"] == "DUPLICATE_PAYMENT"


def test_supplier_cannot_prepare_payment(client, owner, supplier_actor, fake_horizon):
    supplier = create_supplier(client, owner, email=supplier_actor.email, wallet=fake_horizon.destination)
    invoice = create_invoice(client, owner, supplier["id"])
    response = client.post(
        "/api/v1/payments/prepare",
        headers=supplier_actor.headers,
        json={"invoice_id": invoice["id"], "source_account": fake_horizon.source},
    )
    assert response.status_code == 403
