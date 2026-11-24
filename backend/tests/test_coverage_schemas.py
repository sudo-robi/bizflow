"""Direct tests for schema validators (value objects, no network or DB)."""

from __future__ import annotations

from datetime import datetime

import pytest
from pydantic import ValidationError
from stellar_sdk import Keypair, StrKey

from app import schemas

KEY = Keypair.random().public_key
CONTRACT = StrKey.encode_contract(Keypair.random().raw_public_key())
NOW = "2030-12-31T00:00:00"


def _raises(fn, *args, **kwargs):
    with pytest.raises((ValueError, ValidationError)):
        fn(*args, **kwargs)


# --- primitives -------------------------------------------------------------

def test_quantized_accepts_valid_and_rejects_huge_amounts():
    assert schemas._quantized("1.23456789", "amount") == schemas.Decimal("1.2345679")
    with pytest.raises(ValueError, match="outside the supported money range"):
        schemas._quantized("1e30", "amount")


def test_positive_money_rejects_zero_negative_and_tiny_values():
    assert schemas._positive_money("1.5", "amount") == "1.5"
    for value in ("0", "-1", "0.00000001"):
        with pytest.raises(ValueError, match="greater than zero"):
            schemas._positive_money(value, "amount")


def test_issuer_required_covers_all_asset_combinations():
    assert schemas.issuer_required("USD", None) is True
    assert schemas.issuer_required("XLM", None) is False
    assert schemas.issuer_required(None, None) is False
    assert schemas.issuer_required("usd", KEY) is False


def test_decimal_string_validates_and_normalizes():
    assert schemas._decimal_string("12.500") == "12.5"
    assert schemas._decimal_string("-0") == "0"
    for value in (True, None, "bad", "NaN", "Infinity"):
        with pytest.raises(ValueError):
            schemas._decimal_string(value)


def test_stellar_key_validates_strkeys():
    assert schemas._stellar_key(KEY) == KEY
    for value in (123, "not-a-key", "G" + "!" * 55):
        with pytest.raises(ValueError, match="Stellar public key"):
            schemas._stellar_key(value)


def test_contract_id_validates_contract_strkeys():
    assert schemas._contract_id(CONTRACT) == CONTRACT
    for value in (123, KEY, "C-not-valid"):
        with pytest.raises(ValueError, match="contract ID"):
            schemas._contract_id(value)


# --- invoice schemas --------------------------------------------------------

def test_invoice_item_quantity_must_be_positive_money():
    item = schemas.InvoiceItemIn(description="Work", quantity="2", unit_price="5")
    assert item.quantity == "2"
    _raises(schemas.InvoiceItemIn, description="Work", quantity="0", unit_price="5")


def test_invoice_create_amount_and_asset_rules():
    valid = schemas.InvoiceCreate(
        supplier_id="s", description="Work", amount="10", due_date=NOW,
    )
    assert valid.amount == "10"
    _raises(schemas.InvoiceCreate, supplier_id="s", description="Work", amount="0", due_date=NOW)
    _raises(
        schemas.InvoiceCreate, supplier_id="s", description="Work", amount="10",
        asset_code="USD", due_date=NOW,
    )


def test_invoice_update_amount_and_asset_rules():
    assert schemas.InvoiceUpdate(amount="5").amount == "5"
    assert schemas.InvoiceUpdate(amount=None).amount is None
    _raises(schemas.InvoiceUpdate, amount="0")
    _raises(schemas.InvoiceUpdate, asset_code="USD")


# --- agreement schemas ------------------------------------------------------

def _agreement_body(**overrides):
    body = dict(
        supplier_id="s", title="Work", total_amount="100", expiry_date=NOW,
        milestones=[{"description": "A", "amount": "100"}],
    )
    body.update(overrides)
    return body


def test_agreement_create_validates_totals_and_asset():
    assert schemas.AgreementCreate(**_agreement_body()).total_amount == "100"
    _raises(schemas.AgreementCreate, **_agreement_body(total_amount="0", milestones=[{"description": "A", "amount": "0"}]))
    _raises(schemas.AgreementCreate, **_agreement_body(milestones=[{"description": "A", "amount": "99"}]))
    _raises(schemas.AgreementCreate, **_agreement_body(asset_code="USD"))


def test_agreement_update_validates_total_and_asset():
    assert schemas.AgreementUpdate(total_amount="50").total_amount == "50"
    assert schemas.AgreementUpdate(total_amount=None).total_amount is None
    _raises(schemas.AgreementUpdate, total_amount="0")
    _raises(schemas.AgreementUpdate, asset_code="USD")


def test_milestone_amount_must_be_positive():
    assert schemas.MilestoneIn(description="A", amount="1").amount == "1"
    _raises(schemas.MilestoneIn, description="A", amount="0")


# --- payment / escrow schemas ----------------------------------------------

def test_payment_prepare_amount_rules():
    assert schemas.PaymentPrepareIn(invoice_id="i", source_account=KEY).amount is None
    assert schemas.PaymentPrepareIn(invoice_id="i", source_account=KEY, amount="5").amount == "5"
    _raises(schemas.PaymentPrepareIn, invoice_id="i", source_account=KEY, amount="0")


def test_escrow_fund_prepare_amount_rules():
    assert schemas.EscrowFundPrepareIn().amount is None
    assert schemas.EscrowFundPrepareIn(amount="5", onchain_agreement_id=1).amount == "5"
    _raises(schemas.EscrowFundPrepareIn, amount="0")
    _raises(schemas.EscrowFundPrepareIn, escrow_contract_id=KEY)


def test_hash_and_wallet_patterns_are_enforced():
    assert schemas.VerifyIn(hash="a" * 64).hash == "a" * 64
    _raises(schemas.VerifyIn, hash="short")
    assert schemas.WalletCreate(public_key=KEY).network == "testnet"
    _raises(schemas.WalletCreate, public_key=KEY, network="mainnet")
    assert schemas.AgreementFundIn(transaction_hash="b" * 64, funded_amount="1").funded_amount == "1"
    _raises(schemas.AgreementFundIn, transaction_hash="b", funded_amount="1")


def test_decimal_string_before_validator_runs_on_model_fields():
    parsed = schemas.InvoiceCreate.model_validate({
        "supplier_id": "s", "description": "Work", "amount": 12.5, "due_date": NOW,
    })
    assert parsed.amount == "12.5"
