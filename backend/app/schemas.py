"""Pydantic v2 request/response schemas. Amounts are decimal strings."""

from __future__ import annotations

from datetime import datetime
from decimal import Decimal, InvalidOperation
from typing import Annotated, Any, Generic, TypeVar

from pydantic import (
    AfterValidator,
    BaseModel,
    BeforeValidator,
    ConfigDict,
    EmailStr,
    Field,
    field_validator,
    model_validator,
)
from stellar_sdk import Keypair, StrKey

T = TypeVar("T")
MONEY_QUANTUM = Decimal("0.0000001")


def _quantized(value: Any, field: str) -> Decimal:
    """Amount as the database stores it; rejects values outside Numeric(20, 7)."""
    amount = Decimal(value)
    try:
        return amount.quantize(MONEY_QUANTUM)
    except InvalidOperation as exc:
        raise ValueError(f"{field} is outside the supported money range") from exc


def _positive_money(value: Any, field: str = "amount") -> str:
    """Quantize before the positivity check: 0.00000001 is not a payable amount."""
    if _quantized(value, field) <= 0:
        raise ValueError(f"{field} must be greater than zero")
    return value


def issuer_required(asset_code: str | None, asset_issuer: str | None) -> bool:
    """Shared create/update rule: every non-XLM asset needs an issuer."""
    return bool(asset_code) and asset_code.upper() != "XLM" and not asset_issuer


def _decimal_string(value: Any) -> str:
    if isinstance(value, bool) or value is None:
        raise ValueError("amount must be a decimal string")
    try:
        amount = Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise ValueError("amount must be a decimal string") from exc
    if not amount.is_finite():
        raise ValueError("amount must be finite")
    rendered = format(amount, "f")
    if "." in rendered:
        rendered = rendered.rstrip("0").rstrip(".")
    return rendered if rendered not in ("", "-0") else "0"


def _stellar_key(value: str) -> str:
    if not isinstance(value, str) or not value.startswith("G"):
        raise ValueError("must be a valid Stellar public key (G...)")
    try:
        Keypair.from_public_key(value)
    except Exception as exc:
        raise ValueError("must be a valid Stellar public key (G...)") from exc
    return value


def _contract_id(value: str) -> str:
    """Soroban contract IDs are C-strkeys, not ed25519 public keys."""
    if not isinstance(value, str) or not StrKey.is_valid_contract(value):
        raise ValueError("must be a valid Soroban contract ID (C...)")
    return value


DecimalStr = Annotated[str, BeforeValidator(_decimal_string)]
StellarKey = Annotated[str, AfterValidator(_stellar_key)]
ContractId = Annotated[str, AfterValidator(_contract_id)]
Roles = Field(pattern="^(owner|admin|finance_manager|supplier)$")


class APIModel(BaseModel):
    model_config = ConfigDict(from_attributes=True, populate_by_name=True)


class Page(APIModel, Generic[T]):
    items: list[T]
    total: int
    page: int
    per_page: int


# --- Auth & businesses -----------------------------------------------------
class RegisterRequest(APIModel):
    email: EmailStr
    password: str = Field(min_length=8, max_length=72)
    full_name: str = Field(min_length=1, max_length=255)
    business_name: str | None = Field(default=None, max_length=255)


class LoginRequest(APIModel):
    email: EmailStr
    password: str = Field(min_length=1, max_length=72)


class UserOut(APIModel):
    id: str
    email: EmailStr
    full_name: str
    is_active: bool
    created_at: datetime


class BusinessOut(APIModel):
    id: str
    name: str
    legal_name: str | None
    country: str | None
    currency: str
    created_at: datetime


class TokenResponse(APIModel):
    user: UserOut
    token: str
    token_type: str = "bearer"


class RegisterResponse(TokenResponse):
    business: BusinessOut | None = None


class MembershipOut(APIModel):
    id: str
    business: BusinessOut
    role: str
    status: str


class MeResponse(APIModel):
    user: UserOut
    memberships: list[MembershipOut]


class BusinessCreate(APIModel):
    name: str = Field(min_length=1, max_length=255)
    legal_name: str | None = Field(default=None, max_length=255)
    country: str | None = Field(default=None, max_length=100)
    currency: str = Field(default="USD", max_length=10)


class BusinessUpdate(APIModel):
    name: str | None = Field(default=None, min_length=1, max_length=255)
    legal_name: str | None = None
    country: str | None = None
    currency: str | None = Field(default=None, max_length=10)


class MemberCreate(APIModel):
    email: EmailStr
    role: str = Roles


class MemberUpdate(APIModel):
    role: str = Roles


class MemberOut(APIModel):
    id: str
    user: UserOut | None
    email: str
    role: str
    status: str
    created_at: datetime


# --- Suppliers -------------------------------------------------------------
class SupplierCreate(APIModel):
    business_name: str = Field(min_length=1, max_length=255)
    contact_name: str | None = Field(default=None, max_length=255)
    email: EmailStr | None = None
    phone: str | None = Field(default=None, max_length=50)
    wallet_address: StellarKey
    country: str | None = Field(default=None, max_length=100)
    notes: str | None = None


class SupplierUpdate(APIModel):
    business_name: str | None = Field(default=None, min_length=1, max_length=255)
    contact_name: str | None = None
    email: EmailStr | None = None
    phone: str | None = None
    wallet_address: StellarKey | None = None
    country: str | None = None
    notes: str | None = None


class SupplierOut(APIModel):
    id: str
    business_id: str
    business_name: str
    contact_name: str | None
    email: str | None
    phone: str | None
    wallet_address: str
    country: str | None
    notes: str | None
    status: str
    created_at: datetime


class SupplierInviteIn(APIModel):
    email: EmailStr


class SupplierInviteDecisionIn(APIModel):
    reason: str | None = Field(default=None, max_length=500)


class SupplierInvitationOut(APIModel):
    id: str
    business_id: str
    supplier_id: str
    email: str
    role: str
    status: str
    expires_at: datetime
    created_at: datetime
    # The one-time acceptance capability is returned only when the invite is created.
    token: str | None = None


class SupplierInvitationAcceptOut(APIModel):
    id: str
    business_id: str
    supplier_id: str
    email: str
    status: str
    role: str
    accepted_at: datetime | None


# --- Invoices --------------------------------------------------------------
class InvoiceItemIn(APIModel):
    description: str = Field(min_length=1)
    quantity: DecimalStr
    unit_price: DecimalStr

    @field_validator("quantity")
    @classmethod
    def positive_quantity(cls, value: str) -> str:
        return _positive_money(value, "quantity")


class InvoiceItemOut(APIModel):
    id: str
    description: str
    quantity: DecimalStr
    unit_price: DecimalStr


class InvoiceCreate(APIModel):
    supplier_id: str
    description: str = Field(min_length=1)
    amount: DecimalStr
    asset_code: str = Field(default="XLM", min_length=1, max_length=12)
    asset_issuer: StellarKey | None = None
    due_date: datetime
    reference: str | None = Field(default=None, max_length=255)
    items: list[InvoiceItemIn] = Field(default_factory=list)

    @field_validator("amount")
    @classmethod
    def positive_amount(cls, value: str) -> str:
        return _positive_money(value, "amount")

    @model_validator(mode="after")
    def check_asset(self) -> "InvoiceCreate":
        if self.asset_code.upper() != "XLM" and not self.asset_issuer:
            raise ValueError("asset_issuer is required for non-XLM assets")
        return self


class InvoiceUpdate(APIModel):
    description: str | None = None
    amount: DecimalStr | None = None
    asset_code: str | None = Field(default=None, max_length=12)
    asset_issuer: StellarKey | None = None
    due_date: datetime | None = None
    reference: str | None = None

    @field_validator("amount")
    @classmethod
    def positive_amount(cls, value: str | None) -> str | None:
        return _positive_money(value, "amount") if value is not None else None

    @model_validator(mode="after")
    def check_asset(self) -> "InvoiceUpdate":
        if issuer_required(self.asset_code, self.asset_issuer):
            raise ValueError("asset_issuer is required for non-XLM assets")
        return self


class InvoiceOut(APIModel):
    id: str
    business_id: str
    supplier_id: str
    invoice_number: str
    description: str
    amount: DecimalStr
    asset_code: str
    asset_issuer: str | None
    due_date: datetime
    reference: str | None
    status: str
    amount_paid: DecimalStr = "0"
    remaining_amount: DecimalStr = "0"
    created_at: datetime
    items: list[InvoiceItemOut] = Field(default_factory=list)


class InvoiceDecisionIn(APIModel):
    reason: str | None = Field(default=None, max_length=1000)


class InvoiceAttachmentOut(APIModel):
    id: str
    business_id: str
    invoice_id: str
    filename: str
    content_type: str
    size: int
    created_at: datetime


# --- Agreements ------------------------------------------------------------
class MilestoneIn(APIModel):
    description: str = Field(min_length=1)
    amount: DecimalStr
    due_date: datetime | None = None

    @field_validator("amount")
    @classmethod
    def positive_amount(cls, value: str) -> str:
        return _positive_money(value, "milestone amount")


class MilestoneOut(APIModel):
    id: str
    agreement_id: str
    description: str
    amount: DecimalStr
    due_date: datetime | None
    status: str
    sort_order: int
    release_transaction_hash: str | None
    released_at: datetime | None


class MilestoneEvidenceOut(APIModel):
    id: str
    business_id: str
    agreement_id: str
    milestone_id: str
    supplier_id: str
    note: str | None
    url: str | None
    filename: str | None
    content_type: str | None
    size: int
    status: str
    submitted_by: str | None
    approved_by: str | None
    approved_at: datetime | None
    created_at: datetime


class EvidenceApproveIn(APIModel):
    note: str | None = Field(default=None, max_length=1000)


class AgreementCreate(APIModel):
    supplier_id: str
    title: str = Field(min_length=1, max_length=255)
    description: str | None = None
    total_amount: DecimalStr
    asset_code: str = Field(default="XLM", max_length=12)
    asset_issuer: StellarKey | None = None
    expiry_date: datetime
    conditions: dict[str, Any] | None = None
    approval_requirements: dict[str, Any] | None = None
    milestones: list[MilestoneIn] = Field(min_length=1)

    @model_validator(mode="after")
    def check_totals(self) -> "AgreementCreate":
        if _quantized(self.total_amount, "total_amount") <= 0:
            raise ValueError("total_amount must be greater than zero")
        total = sum((_quantized(item.amount, "milestone amount") for item in self.milestones), Decimal("0"))
        if total != _quantized(self.total_amount, "total_amount"):
            raise ValueError("milestone amounts must sum exactly to total_amount")
        if self.asset_code.upper() != "XLM" and not self.asset_issuer:
            raise ValueError("asset_issuer is required for non-XLM assets")
        return self


class AgreementUpdate(APIModel):
    title: str | None = Field(default=None, max_length=255)
    description: str | None = None
    total_amount: DecimalStr | None = None
    asset_code: str | None = Field(default=None, max_length=12)
    asset_issuer: StellarKey | None = None
    expiry_date: datetime | None = None
    conditions: dict[str, Any] | None = None
    approval_requirements: dict[str, Any] | None = None
    milestones: list[MilestoneIn] | None = None

    @field_validator("total_amount")
    @classmethod
    def positive_total(cls, value: str | None) -> str | None:
        return _positive_money(value, "total_amount") if value is not None else None

    @model_validator(mode="after")
    def check_asset(self) -> "AgreementUpdate":
        if issuer_required(self.asset_code, self.asset_issuer):
            raise ValueError("asset_issuer is required for non-XLM assets")
        return self


class AgreementOut(APIModel):
    id: str
    business_id: str
    supplier_id: str
    reference: str
    title: str
    description: str | None
    total_amount: DecimalStr
    asset_code: str
    asset_issuer: str | None
    expiry_date: datetime
    conditions: dict[str, Any] | None
    approval_requirements: dict[str, Any] | None
    status: str
    escrow_contract_id: str | None
    onchain_agreement_id: int | None = None
    funded_amount: DecimalStr
    fund_transaction_hash: str | None
    cancellation_reason: str | None
    accepted_at: datetime | None
    created_at: datetime
    milestones: list[MilestoneOut] = Field(default_factory=list)


class AgreementCancel(APIModel):
    reason: str = Field(default="Cancelled by business", max_length=1000)


# --- Payments, verification, transactions ----------------------------------
class PaymentPrepareIn(APIModel):
    invoice_id: str
    source_account: StellarKey
    # Optional partial payment. When omitted the full outstanding amount is used.
    amount: DecimalStr | None = None

    @field_validator("amount")
    @classmethod
    def positive_partial_amount(cls, value: str | None) -> str | None:
        return _positive_money(value, "payment amount") if value is not None else None


class PaymentSubmitIn(APIModel):
    signed_xdr: str = Field(min_length=1, max_length=20000)


class PaymentOut(APIModel):
    id: str
    business_id: str
    invoice_id: str | None
    agreement_id: str | None
    milestone_id: str | None
    kind: str
    amount: DecimalStr
    asset_code: str
    asset_issuer: str | None
    source_account: str | None
    destination_account: str | None
    memo: str | None
    hash: str | None
    status: str
    expires_at: datetime | None
    confirmed_at: datetime | None
    failure_reason: str | None
    created_at: datetime


class PaymentPreparedOut(APIModel):
    payment_id: str
    xdr: str
    hash: str
    expires_at: datetime


class PreparedXdrOut(APIModel):
    payment_id: str
    xdr: str
    hash: str
    status: str
    expires_at: datetime | None


class VerifyIn(APIModel):
    hash: str = Field(min_length=64, max_length=64, pattern="^[0-9a-fA-F]{64}$")
    invoice_id: str | None = None


class VerificationOut(APIModel):
    hash: str
    confirmed: bool
    successful: bool
    settled: bool
    status: str
    ledger: int | None
    source_account: str | None
    destination_account: str | None
    asset_code: str | None
    asset_issuer: str | None
    amount: DecimalStr | None
    memo: str | None
    network: str
    contract_id: str | None = None
    event_matched: bool = False
    checked_at: datetime
    reason: str | None = None


class TransactionOut(APIModel):
    id: str
    hash: str
    network: str
    status: str
    successful: bool
    source_account: str | None
    destination_account: str | None
    asset_code: str | None
    asset_issuer: str | None
    amount: DecimalStr | None
    memo: str | None
    ledger: int | None
    confirmed_at: datetime | None
    created_at: datetime


class PublicReceiptOut(APIModel):
    hash: str
    network: str
    status: str
    successful: bool
    amount: DecimalStr | None
    asset_code: str | None
    source_account: str | None
    destination_account: str | None
    memo: str | None
    ledger: int | None
    business_name: str | None = None
    invoice_number: str | None = None
    confirmed_at: datetime | None = None


# --- Notifications, wallets, reports --------------------------------------
class NotificationOut(APIModel):
    id: str
    title: str
    message: str
    type: str
    is_read: bool
    related_id: str | None
    created_at: datetime


class WalletCreate(APIModel):
    public_key: StellarKey
    network: str = Field(default="testnet", pattern="^testnet$")
    label: str | None = Field(default=None, max_length=255)


class WalletOut(APIModel):
    id: str
    public_key: str
    network: str
    label: str | None
    created_at: datetime


class AuditOut(APIModel):
    id: str
    action: str
    entity_type: str | None
    entity_id: str | None
    details: dict[str, Any] | None
    actor_id: str | None
    created_at: datetime


class AgreementFundIn(APIModel):
    transaction_hash: str = Field(min_length=64, max_length=64, pattern="^[0-9a-fA-F]{64}$")
    funded_amount: DecimalStr
    # Legacy Horizon funding: optional memo/asset/source checks are applied by the API.
    source_account: StellarKey | None = None
    asset_code: str | None = None
    memo: str | None = None


class EscrowPrepareIn(APIModel):
    source_account: StellarKey | None = None
    escrow_contract_id: ContractId | None = None


class EscrowFundPrepareIn(EscrowPrepareIn):
    amount: DecimalStr | None = None
    # Numeric id the deployed contract was initialized with. Must be a positive
    # integer; uniqueness per agreement is enforced in the database as well.
    onchain_agreement_id: int | None = Field(default=None, ge=1)

    @field_validator("amount")
    @classmethod
    def positive_amount(cls, value: str | None) -> str | None:
        return _positive_money(value, "funding amount") if value is not None else None


class EscrowSubmitIn(APIModel):
    signed_xdr: str = Field(min_length=1, max_length=20000)


class ReleasePrepareIn(EscrowPrepareIn):
    pass


class ReleaseIn(EscrowSubmitIn):
    pass
