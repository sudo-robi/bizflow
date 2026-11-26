"""Agreement funding and Soroban escrow release endpoints."""

from __future__ import annotations

import logging
from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session
from stellar_sdk import soroban_rpc

from app.config import get_settings
from app.database import get_db
from app.errors import BizError, bad_request, conflict, not_found
from app.models import (
    AgreementMilestone,
    AuditLog,
    BlockchainTransaction,
    PaymentAgreement,
    PaymentRecord,
)
from app.routers.agreements import (
    _agreement,
    _milestone,
    _visible,
    agreement_out,
    approved_evidence_exists,
)
from app.schemas import (
    AgreementFundIn,
    AgreementOut,
    EscrowBindContractIn,
    EscrowFundPrepareIn,
    EscrowPrepareIn,
    EscrowSubmitIn,
    MilestoneOut,
    ReleaseIn,
    ReleasePrepareIn,
)
from app.security import get_business_membership, get_current_user, require_roles
from app.services import reconciliation, stellar, verification
from app.services.notifications import audit, notify_business
from app.utils import add_seconds, money_str, naive, to_decimal, utcnow

logger = logging.getLogger(__name__)
settings = get_settings()
router = APIRouter(prefix="/agreements", tags=["agreements"])


@router.post("/{agreement_id}/fund", response_model=AgreementOut)
def fund_agreement(
    agreement_id: str,
    payload: AgreementFundIn,
    membership=Depends(require_roles("owner", "admin")),
    db: Session = Depends(get_db),
):
    agreement = _agreement(db, agreement_id, membership.business_id)
    if agreement.status != "active":
        raise conflict("Only active agreements can be funded", "AGREEMENT_STATE")
    if agreement.fund_transaction_hash:
        raise conflict("Agreement is already funded", "ALREADY_FUNDED")
    _onchain_agreement_id(agreement)
    amount = to_decimal(payload.funded_amount, "funded_amount", positive=True)
    if amount > to_decimal(agreement.total_amount):
        raise bad_request("Funded amount exceeds agreement total", "INVALID_AMOUNT")
    contract_id = agreement.escrow_contract_id or settings.stellar_escrow_contract_id
    if not contract_id:
        raise bad_request("Escrow contract ID is not configured", "CONTRACT_NOT_CONFIGURED")
    # Bind the payment to this agreement: amount, asset, issuer, destination and
    # memo all come from trusted server state. An unrelated payment of the same
    # amount can no longer mark an agreement as funded.
    expected: dict = {
        "amount": amount,
        "asset_code": agreement.asset_code,
        "asset_issuer": agreement.asset_issuer,
        "destination_account": contract_id,
        "memo": agreement.reference,
    }
    if payload.source_account:
        expected["source_account"] = payload.source_account
    if payload.asset_code and payload.asset_code.upper() != agreement.asset_code.upper():
        raise bad_request("Funding asset does not match the agreement", "ASSET_MISMATCH")
    if payload.memo and payload.memo != agreement.reference:
        raise bad_request("Funding memo does not match the agreement", "MEMO_MISMATCH")
    if verification.hash_already_used(db, payload.transaction_hash):
        raise conflict("This transaction hash is already linked to a payment", "DUPLICATE_HASH")
    result = verification.verify_stellar_payment(payload.transaction_hash, expected=expected)
    if not result.settled:
        raise conflict(
            result.reason or "Funding transaction is not confirmed and verified", "UNVERIFIED_TX"
        )
    verification.record_transaction(db, membership.business_id, result)
    agreement.funded_amount = amount
    agreement.fund_transaction_hash = result.hash
    if not agreement.escrow_contract_id:
        agreement.escrow_contract_id = contract_id
    audit(
        db, membership.business_id, membership.user_id, "agreement.funded", "agreement", agreement.id,
        {"hash": result.hash, "amount": money_str(amount)},
    )
    db.commit()
    db.refresh(agreement)
    return agreement_out(db, agreement)


def _onchain_agreement_id(agreement) -> str:
    """The numeric id the escrow contract was initialized with.

    Event verification matches this id in the on-chain event topics. Falling back
    to the database UUID can never match, so settlement must not be attempted
    without it.
    """
    if agreement.onchain_agreement_id is None:
        raise conflict("Agreement is not linked to an on-chain id", "NO_ONCHAIN_ID")
    return str(agreement.onchain_agreement_id)


def _approval_ready(db, milestone) -> None:
    """A pending milestone, or a submitted one with approved off-chain evidence."""
    if milestone.status == "pending":
        return
    if milestone.status == "submitted" and approved_evidence_exists(db, milestone.id):
        return
    raise conflict("Milestone is not pending approval", "MILESTONE_STATE")


def _escrow_context(db, agreement, contract_id: str | None, source_account: str | None):
    """Resolve the real deployed contract and signing account for an agreement.

    A client-supplied contract id is accepted only when it matches the contract
    already bound to the agreement/configuration. It can never replace it.
    """
    resolved = agreement.escrow_contract_id or settings.stellar_escrow_contract_id
    if not resolved:
        raise bad_request("Escrow contract ID is not configured", "CONTRACT_NOT_CONFIGURED")
    if contract_id and contract_id != resolved:
        raise bad_request("Escrow contract does not match the agreement", "CONTRACT_MISMATCH")
    source = source_account
    if not source:
        funding = db.scalar(
            select(BlockchainTransaction).where(
                BlockchainTransaction.hash == agreement.fund_transaction_hash
            )
        )
        source = funding.source_account if funding else None
    if not source:
        raise bad_request("source_account is required for escrow operations", "MISSING_SOURCE")
    return resolved, source


def _escrow_payment(db, tx_hash: str, agreement_id: str, business_id: str, kind: str):
    payment = db.scalar(
        select(PaymentRecord).where(
            PaymentRecord.hash == tx_hash,
            PaymentRecord.agreement_id == agreement_id,
            PaymentRecord.business_id == business_id,
            PaymentRecord.kind == kind,
        )
    )
    if payment is None:
        raise not_found("Prepared escrow transaction not found")
    return payment


def _assert_no_duplicate_hash(db, tx_hash: str) -> None:
    """A verified hash may never settle a second agreement/payment."""
    if verification.hash_already_used(db, tx_hash):
        raise conflict("This transaction hash is already linked to a payment", "DUPLICATE_HASH")


def _contract_in_use(db, contract_id: str | None, agreement_id: str) -> bool:
    """Database-level guard for the one-contract/one-funded-agreement invariant."""
    if not contract_id:
        return False
    return db.scalar(
        select(PaymentAgreement.id).where(
            PaymentAgreement.escrow_contract_id == contract_id,
            PaymentAgreement.fund_transaction_hash.isnot(None),
            PaymentAgreement.id != agreement_id,
        )
    ) is not None


def _assert_identity(db, agreement, contract_id: str, source_account: str) -> dict:
    """Compare the bound DB id with the contract's stored agreement before settling."""
    return reconciliation.assert_contract_identity(
        agreement, contract_id, source_account, db
    )


def _verify_state(db, agreement, payment, **expected):
    """Read authoritative Soroban state before any financial record changes."""
    if not settings.enforce_escrow_state_verification:
        return {"enforced": False}
    return reconciliation.verify_escrow_state(
        db,
        agreement,
        contract_id=payment.destination_account or agreement.escrow_contract_id,
        source_account=payment.source_account,
        **expected,
    )


def _post_submit_failure(
    db,
    agreement,
    payment,
    membership,
    *,
    stage: str,
    expected: dict,
    observed: dict | None,
    discrepancy: str,
    error: BizError,
) -> None:
    """A chain success with a failed DB-side check leaves an OPEN audit trail.

    Never settle silently on `PaymentRecord.failure_reason` alone: a human must
    be able to reconcile the observed chain state with what the database expected.
    """
    payment.status = "failed"
    payment.failure_reason = f"{error.code}: {error.detail}"
    report = reconciliation.discrepancy_report(
        agreement=agreement,
        contract_id=payment.destination_account or agreement.escrow_contract_id,
        expected={**expected, "payment_id": payment.id, "hash": payment.hash},
        observed=observed,
        discrepancies=(discrepancy,),
        evidence={"stage": stage, "payment_status": payment.status},
    )
    record = reconciliation.persist_report(db, report, membership.business_id)
    audit(
        db, membership.business_id, membership.user_id,
        "agreement.reconciliation_opened", "agreement", agreement.id,
        {
            "stage": stage,
            "discrepancy": list(report.discrepancies),
            "reconciliation_record_id": record.id,
            "payment_id": payment.id,
        },
    )
    db.commit()
    raise error


def _fail_unverified_state(db, payment, membership, agreement, exc: BizError) -> None:
    """Record a failed post-submit state check as an open reconciliation."""
    _post_submit_failure(
        db, agreement, payment, membership,
        stage="contract_state",
        expected=exc.extra.get("expected", {"agreement_id": agreement.onchain_agreement_id}),
        observed=exc.extra.get("observed"),
        discrepancy=f"{exc.code}: {exc.detail}",
        error=exc,
    )


def _binding_mismatch(agreement, state: dict, source_account: str, db) -> str | None:
    """Compatibility check performed *before* any binding field is written."""
    from stellar_sdk import Asset

    milestones = db.scalars(
        select(AgreementMilestone)
        .where(AgreementMilestone.agreement_id == agreement.id)
        .order_by(AgreementMilestone.sort_order)
    ).all()
    expected_asset = Asset(
        (agreement.asset_code or "XLM").upper(), agreement.asset_issuer
    ).contract_id(settings.stellar_network_passphrase)
    checks = (
        (state["agreement_id"] < 1, "Contract agreement id is not positive"),
        (state["total_amount"] != int((to_decimal(agreement.total_amount) * Decimal("10000000")).to_integral_value()), "Contract total amount differs"),
        (state["milestone_count"] != len(milestones), "Contract milestone count differs"),
        (state["asset"] != expected_asset, "Contract asset differs"),
        (state["payer"] != source_account, "Contract payer differs from the supplied source account"),
        (state["funded"] or state["released"] or state["remaining"], "Contract already holds funds"),
    )
    for failed, message in checks:
        if failed:
            return message
    return None


@router.post("/{agreement_id}/bind-contract", response_model=AgreementOut)
def bind_escrow_contract(
    agreement_id: str,
    payload: EscrowBindContractIn,
    membership=Depends(require_roles("owner", "admin")),
    db: Session = Depends(get_db),
):
    """Derive and store the escrow binding from the contract's real getter state.

    One contract instance holds one agreement. The numeric on-chain id is read
    from `get_agreement` and is never accepted from the client. A failed getter
    or an incompatible contract writes no binding at all.
    """
    agreement = _agreement(db, agreement_id, membership.business_id)
    if agreement.fund_transaction_hash:
        raise conflict("A funded agreement cannot be re-bound", "ALREADY_FUNDED")
    if agreement.status in ("completed", "cancelled", "refunded"):
        raise conflict("Agreement is not in a bindable state", "AGREEMENT_STATE")
    contract_id = stellar.validate_contract_id(payload.escrow_contract_id)
    if agreement.escrow_contract_id and agreement.escrow_contract_id != contract_id:
        raise conflict("Agreement is bound to a different escrow contract", "BINDING_CONFLICT")
    if _contract_in_use(db, contract_id, agreement.id):
        raise conflict("This escrow contract is already bound to another funded agreement", "CONTRACT_IN_USE")

    try:
        state = reconciliation.read_contract_agreement(contract_id, payload.source_account)
    except Exception as exc:
        raise conflict("Escrow contract state could not be read", "CONTRACT_STATE_READ_FAILED") from exc
    mismatch = _binding_mismatch(agreement, state, payload.source_account, db)
    if mismatch:
        raise conflict(f"Escrow contract is incompatible with the agreement: {mismatch}", "CONTRACT_STATE_MISMATCH")

    # Idempotent re-bind of the same contract must not create a second binding.
    if agreement.escrow_contract_id == contract_id and agreement.onchain_agreement_id == state["agreement_id"]:
        return agreement_out(db, agreement)

    agreement.escrow_contract_id = contract_id
    agreement.onchain_agreement_id = state["agreement_id"]
    agreement.escrow_payer = state["payer"]
    audit(
        db, membership.business_id, membership.user_id, "agreement.contract_bound",
        "agreement", agreement.id,
        {
            "escrow_contract_id": contract_id,
            "onchain_agreement_id": state["agreement_id"],
            "payer": state["payer"],
        },
    )
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        raise conflict("This escrow contract is already bound to another funded agreement", "CONTRACT_IN_USE") from exc
    db.refresh(agreement)
    return agreement_out(db, agreement)


@router.post("/{agreement_id}/prepare-fund")
def prepare_escrow_fund(
    agreement_id: str,
    payload: EscrowFundPrepareIn,
    membership=Depends(require_roles("owner", "admin")),
    db: Session = Depends(get_db),
):
    """Simulate + assemble a real Soroban `fund` call. Nothing is submitted here."""
    agreement = _agreement(db, agreement_id, membership.business_id)
    if agreement.status != "active":
        raise conflict("Only active agreements can be funded", "AGREEMENT_STATE")
    if agreement.fund_transaction_hash:
        raise conflict("Agreement is already funded", "ALREADY_FUNDED")
    amount = to_decimal(payload.amount, "amount", positive=True) if payload.amount else to_decimal(agreement.total_amount)
    if amount > to_decimal(agreement.total_amount):
        raise bad_request("Funded amount exceeds agreement total", "INVALID_AMOUNT")
    contract_id, source = _escrow_context(db, agreement, payload.escrow_contract_id, payload.source_account)
    # One contract instance holds exactly one agreement. Never bind the same
    # instance to a second funded agreement.
    if _contract_in_use(db, contract_id, agreement.id):
        raise conflict("This escrow contract is already bound to another funded agreement", "CONTRACT_IN_USE")
    # The binding (contract id + numeric id) is server-derived by bind-contract.
    # A client may never supply or overwrite the numeric id here.
    if agreement.onchain_agreement_id is None:
        raise conflict("Agreement has no derived on-chain id", "NO_ONCHAIN_ID")
    if not agreement.escrow_contract_id:
        raise conflict("Agreement is not bound to an escrow contract", "CONTRACT_NOT_BOUND")
    bound_id = int(agreement.onchain_agreement_id)
    if payload.onchain_agreement_id is not None and payload.onchain_agreement_id != bound_id:
        raise bad_request(
            "onchain_agreement_id is derived from the contract and is read-only",
            "ONCHAIN_ID_READ_ONLY",
        )
    other = db.scalar(
        select(PaymentAgreement.id).where(
            PaymentAgreement.onchain_agreement_id == bound_id,
            PaymentAgreement.id != agreement.id,
        )
    )
    if other is not None:
        raise conflict("This on-chain agreement id is bound to another agreement", "ONCHAIN_ID_IN_USE")
    prepared = stellar.build_soroban_fund_xdr(contract_id, source, amount)
    payment = PaymentRecord(
        business_id=membership.business_id,
        agreement_id=agreement.id,
        kind="escrow_fund",
        amount=amount,
        asset_code=agreement.asset_code,
        asset_issuer=agreement.asset_issuer,
        source_account=source,
        destination_account=contract_id,
        memo=agreement.reference,
        xdr=prepared.xdr,
        hash=prepared.hash,
        status="prepared",
        expires_at=add_seconds(settings.prepare_expires_minutes * 60),
        prepared_by=membership.user_id,
    )
    db.add(payment)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise conflict("This transaction hash is already used", "DUPLICATE_HASH") from exc
    db.commit()
    return {"xdr": prepared.xdr, "hash": prepared.hash, "payment_id": payment.id, "expires_at": payment.expires_at}


@router.post("/{agreement_id}/fund-escrow", response_model=AgreementOut)
def fund_escrow(
    agreement_id: str,
    payload: EscrowSubmitIn,
    membership=Depends(require_roles("owner", "admin")),
    db: Session = Depends(get_db),
):
    """Submit signed funding, poll RPC, require a verified `funded` event."""
    agreement = _agreement(db, agreement_id, membership.business_id)
    if agreement.fund_transaction_hash:
        raise conflict("Agreement is already funded", "ALREADY_FUNDED")
    tx_hash = stellar.transaction_hash(payload.signed_xdr)
    _assert_no_duplicate_hash(db, tx_hash)
    payment = _escrow_payment(db, tx_hash, agreement.id, membership.business_id, "escrow_fund")
    if payment.expires_at and naive(payment.expires_at) < utcnow():
        payment.status = "failed"
        payment.failure_reason = "Prepared funding transaction expired"
        db.commit()
        raise conflict("Prepared transaction expired; prepare a new one", "EXPIRED_XDR")
    contract_id = payment.destination_account
    if contract_id != agreement.escrow_contract_id:
        raise bad_request("Prepared funding targets a different contract", "CONTRACT_MISMATCH")
    _assert_identity(db, agreement, contract_id, payment.source_account)
    # TOCTOU: re-check the one-contract invariant immediately before submission.
    if _contract_in_use(db, contract_id, agreement.id):
        raise conflict("This escrow contract is already bound to another funded agreement", "CONTRACT_IN_USE")
    stroops = int((to_decimal(payment.amount) * Decimal("10000000")).to_integral_value())
    submitted = stellar.submit_soroban(
        payload.signed_xdr, contract_id, "fund",
        expected_parameters=[payment.source_account, stroops],
    )
    if not (submitted.confirmed and submitted.successful):
        payment.status = "failed"
        payment.failure_reason = submitted.reason
        db.commit()
        raise conflict(submitted.reason or "Funding was not confirmed on-chain", "UNCONFIRMED_TX")
    verified = verification.verify_soroban_funding(
        tx_hash, contract_id, payment.amount, _onchain_agreement_id(agreement),
        payer=payment.source_account,
    )
    expected = {
        "agreement_id": agreement.onchain_agreement_id,
        "amount_stroops": stroops,
        "payer": payment.source_account,
        "contract_id": contract_id,
    }
    if not verified.settled:
        error = conflict(verified.reason or "Funding event could not be verified", "UNVERIFIED_EVENT")
        _post_submit_failure(
            db, agreement, payment, membership,
            stage="funded_event",
            expected=expected,
            observed={"event_matched": verified.event_matched, "reason": verified.reason},
            discrepancy=f"UNVERIFIED_FUNDED_EVENT: {verified.reason}",
            error=error,
        )
    try:
        state_evidence = _verify_state(db, agreement, payment, funded_extra=stroops)
    except BizError as exc:
        _fail_unverified_state(db, payment, membership, agreement, exc)
    verification.record_transaction(db, membership.business_id, verified, payment.id)
    payment.status = "confirmed"
    payment.confirmed_at = utcnow()
    agreement.funded_amount = payment.amount
    agreement.fund_transaction_hash = tx_hash
    agreement.escrow_contract_id = contract_id
    audit(db, membership.business_id, membership.user_id, "agreement.escrow_funded", "agreement", agreement.id, {"hash": tx_hash, "contract_state": state_evidence})
    notify_business(db, membership.business_id, "Escrow funded", f"{money_str(payment.amount)} {payment.asset_code} is held by the escrow contract.", "agreement", agreement.id)
    try:
        db.commit()
    except IntegrityError as exc:
        db.rollback()
        # The chain transfer succeeded but the database could not claim the
        # contract: leave an auditable open record instead of a silent 500.
        report = reconciliation.discrepancy_report(
            agreement=agreement, contract_id=contract_id,
            expected={"fund_transaction_hash": tx_hash, "contract_id": contract_id},
            observed={"unique_index": "uq_agreement_funded_contract"},
            discrepancies=("CONTRACT_IN_USE_AT_COMMIT",),
            evidence={"stage": "commit", "hash": tx_hash},
        )
        reconciliation.persist_report(db, report, membership.business_id)
        audit(
            db, membership.business_id, membership.user_id,
            "agreement.reconciliation_opened", "agreement", agreement.id,
            {"stage": "commit", "discrepancy": ["CONTRACT_IN_USE_AT_COMMIT"]},
        )
        db.commit()
        raise conflict("This escrow contract is already bound to another funded agreement", "CONTRACT_IN_USE") from exc
    db.refresh(agreement)
    return agreement_out(db, agreement)


@router.post("/{agreement_id}/milestones/{milestone_id}/prepare-approve")
def prepare_approve_milestone(
    agreement_id: str,
    milestone_id: str,
    payload: EscrowPrepareIn,
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    """Prepare a real Soroban `approve_milestone` invocation for signing."""
    agreement = _agreement(db, agreement_id, membership.business_id)
    if agreement.status != "active" or not agreement.fund_transaction_hash:
        raise conflict("Agreement must be active and funded", "AGREEMENT_STATE")
    milestone = _milestone(db, agreement.id, milestone_id)
    _approval_ready(db, milestone)
    _onchain_agreement_id(agreement)
    contract_id, source = _escrow_context(db, agreement, payload.escrow_contract_id, payload.source_account)
    prepared = stellar.build_soroban_approve_xdr(contract_id, source, milestone.sort_order)
    payment = PaymentRecord(
        business_id=membership.business_id,
        agreement_id=agreement.id,
        milestone_id=milestone.id,
        kind="escrow_approval",
        amount=to_decimal("0"),
        asset_code=agreement.asset_code,
        asset_issuer=agreement.asset_issuer,
        source_account=source,
        destination_account=contract_id,
        memo=agreement.reference,
        xdr=prepared.xdr,
        hash=prepared.hash,
        status="prepared",
        expires_at=add_seconds(settings.prepare_expires_minutes * 60),
        prepared_by=membership.user_id,
    )
    db.add(payment)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise conflict("This transaction hash is already used", "DUPLICATE_HASH") from exc
    db.commit()
    return {"xdr": prepared.xdr, "hash": prepared.hash, "payment_id": payment.id, "expires_at": payment.expires_at}


@router.post("/{agreement_id}/milestones/{milestone_id}/approve", response_model=AgreementOut)
def approve_milestone(
    agreement_id: str,
    milestone_id: str,
    payload: EscrowSubmitIn,
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    """Submit the signed approval and require an on-chain `approved` event."""
    agreement = _agreement(db, agreement_id, membership.business_id)
    milestone = _milestone(db, agreement.id, milestone_id)
    if agreement.status != "active" or not agreement.fund_transaction_hash:
        raise conflict("Agreement must be active and funded", "AGREEMENT_STATE")
    _approval_ready(db, milestone)
    onchain_id = _onchain_agreement_id(agreement)
    tx_hash = stellar.transaction_hash(payload.signed_xdr)
    _assert_no_duplicate_hash(db, tx_hash)
    payment = _escrow_payment(db, tx_hash, agreement.id, membership.business_id, "escrow_approval")
    if payment.milestone_id != milestone.id:
        raise not_found("Prepared approval not found for this milestone")
    if payment.status == "confirmed":
        raise conflict("Milestone was already approved", "MILESTONE_APPROVED")
    if payment.status != "prepared":
        raise conflict("Prepared approval is no longer valid", "PAYMENT_STATE")
    if payment.expires_at and naive(payment.expires_at) < utcnow():
        payment.status = "failed"
        payment.failure_reason = "Prepared approval expired"
        db.commit()
        raise conflict("Prepared transaction expired; prepare a new one", "EXPIRED_XDR")
    expected_contract = agreement.escrow_contract_id
    if payment.destination_account != expected_contract:
        raise bad_request("Prepared approval targets a different contract", "CONTRACT_MISMATCH")
    _assert_identity(db, agreement, expected_contract, payment.source_account)
    submitted = stellar.submit_soroban(
        payload.signed_xdr, payment.destination_account, "approve_milestone",
        expected_parameters=[payment.source_account, milestone.sort_order],
    )
    if not (submitted.confirmed and submitted.successful):
        payment.status = "failed"
        payment.failure_reason = submitted.reason
        db.commit()
        raise conflict(submitted.reason or "Approval was not confirmed on-chain", "UNCONFIRMED_TX")
    verified = verification.verify_soroban_approval(
        tx_hash, payment.destination_account, onchain_id, milestone.sort_order,
        amount=to_decimal(milestone.amount),
    )
    expected = {
        "agreement_id": agreement.onchain_agreement_id,
        "milestone_index": milestone.sort_order,
        "amount_stroops": int((to_decimal(milestone.amount) * Decimal("10000000")).to_integral_value()),
        "contract_id": expected_contract,
    }
    if not verified.settled:
        error = conflict(verified.reason or "Approval event could not be verified", "UNVERIFIED_EVENT")
        _post_submit_failure(
            db, agreement, payment, membership,
            stage="approved_event",
            expected=expected,
            observed={"event_matched": verified.event_matched, "reason": verified.reason},
            discrepancy=f"UNVERIFIED_APPROVED_EVENT: {verified.reason}",
            error=error,
        )
    try:
        state_evidence = _verify_state(
            db, agreement, payment, milestone_index=milestone.sort_order,
            expect_approved=True, expect_released=False,
        )
    except BizError as exc:
        _fail_unverified_state(db, payment, membership, agreement, exc)
    verification.record_transaction(db, membership.business_id, verified, payment.id)
    payment.status = "confirmed"
    payment.confirmed_at = utcnow()
    milestone.status = "approved"
    audit(db, membership.business_id, membership.user_id, "milestone.approved", "agreement_milestone", milestone.id, {"hash": tx_hash, "contract_state": state_evidence})
    notify_business(db, membership.business_id, "Milestone approved", f"Milestone {milestone.sort_order + 1} is approved for release.", "agreement", agreement.id)
    db.commit()
    db.refresh(agreement)
    return agreement_out(db, agreement)


@router.get("/{agreement_id}/milestones", response_model=list[MilestoneOut])
def list_milestones(
    agreement_id: str,
    user=Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    agreement = _agreement(db, agreement_id, membership.business_id)
    _visible(db, agreement, membership, user)
    return db.scalars(
        select(AgreementMilestone)
        .where(AgreementMilestone.agreement_id == agreement.id)
        .order_by(AgreementMilestone.sort_order)
    ).all()


@router.post("/{agreement_id}/milestones/{milestone_id}/prepare-release")
def prepare_release(
    agreement_id: str,
    milestone_id: str,
    payload: ReleasePrepareIn,
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    agreement = _agreement(db, agreement_id, membership.business_id)
    if agreement.status != "active":
        raise conflict("Only active agreements can release milestones", "AGREEMENT_STATE")
    if not agreement.fund_transaction_hash:
        raise conflict("Agreement must be funded before a release", "NOT_FUNDED")
    milestone = _milestone(db, agreement.id, milestone_id)
    if milestone.status == "released":
        raise conflict("Milestone has already been released", "MILESTONE_RELEASED")
    if milestone.status != "approved":
        raise conflict("Milestone must be approved on-chain before release", "MILESTONE_NOT_APPROVED")
    _onchain_agreement_id(agreement)

    contract_id, source_account = _escrow_context(
        db, agreement, payload.escrow_contract_id, payload.source_account
    )

    prepared = stellar.build_soroban_release_xdr(
        contract_id=contract_id,
        source_account=source_account,
        agreement_id=agreement.id,
        milestone_index=milestone.sort_order,
    )
    payment = PaymentRecord(
        business_id=membership.business_id,
        agreement_id=agreement.id,
        milestone_id=milestone.id,
        kind="escrow_release",
        amount=to_decimal(milestone.amount),
        asset_code=agreement.asset_code,
        asset_issuer=agreement.asset_issuer,
        source_account=source_account,
        destination_account=contract_id,
        memo=agreement.reference,
        xdr=prepared.xdr,
        hash=prepared.hash,
        status="prepared",
        expires_at=add_seconds(settings.prepare_expires_minutes * 60),
        prepared_by=membership.user_id,
    )
    db.add(payment)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise conflict("This release transaction hash is already used", "DUPLICATE_HASH") from exc
    audit(
        db, membership.business_id, membership.user_id, "milestone.release_prepared",
        "agreement_milestone", milestone.id, {"hash": prepared.hash},
    )
    db.commit()
    return {
        "xdr": prepared.xdr,
        "hash": prepared.hash,
        "payment_id": payment.id,
        "expires_at": payment.expires_at,
    }


@router.post("/{agreement_id}/milestones/{milestone_id}/release", response_model=AgreementOut)
def release_milestone(
    agreement_id: str,
    milestone_id: str,
    payload: ReleaseIn,
    membership=Depends(require_roles("finance_manager")),
    db: Session = Depends(get_db),
):
    agreement = _agreement(db, agreement_id, membership.business_id)
    milestone = _milestone(db, agreement.id, milestone_id)
    if agreement.status != "active" or not agreement.fund_transaction_hash:
        raise conflict("Agreement must be active and funded", "AGREEMENT_STATE")
    if milestone.status != "approved":
        raise conflict("Milestone must be approved on-chain before release", "MILESTONE_NOT_APPROVED")
    onchain_id = _onchain_agreement_id(agreement)
    tx_hash = stellar.transaction_hash(payload.signed_xdr)
    _assert_no_duplicate_hash(db, tx_hash)
    payment = db.scalar(
        select(PaymentRecord).where(
            PaymentRecord.hash == tx_hash,
            PaymentRecord.milestone_id == milestone.id,
            PaymentRecord.business_id == membership.business_id,
            PaymentRecord.kind == "escrow_release",
        )
    )
    if payment is None:
        raise not_found("Prepared release transaction not found for this milestone")
    if payment.status == "confirmed":
        raise conflict("Milestone was already released", "MILESTONE_RELEASED")
    if payment.status != "prepared":
        raise conflict("Prepared release is no longer valid", "PAYMENT_STATE")
    if payment.expires_at and naive(payment.expires_at) < utcnow():
        payment.status = "failed"
        payment.failure_reason = "Prepared release expired"
        db.commit()
        raise conflict("Prepared transaction expired; prepare a new one", "EXPIRED_XDR")

    contract_id = agreement.escrow_contract_id
    if payment.destination_account != contract_id:
        raise bad_request("Prepared release targets a different contract", "CONTRACT_MISMATCH")
    _assert_identity(db, agreement, contract_id, payment.source_account)
    submitted = stellar.submit_soroban(
        payload.signed_xdr, contract_id, "release_milestone",
        expected_parameters=[payment.source_account, milestone.sort_order],
    )
    if not (submitted.confirmed and submitted.successful):
        payment.status = "failed"
        payment.failure_reason = submitted.reason
        audit(db, membership.business_id, membership.user_id, "milestone.release_failed", "agreement_milestone", milestone.id, {"hash": tx_hash})
        db.commit()
        raise conflict(submitted.reason or "Soroban transaction was not confirmed", "UNCONFIRMED_TX")

    verified = verification.verify_soroban_release(
        tx_hash, contract_id, onchain_id, milestone.sort_order, amount=to_decimal(milestone.amount)
    )
    expected = {
        "agreement_id": agreement.onchain_agreement_id,
        "milestone_index": milestone.sort_order,
        "amount_stroops": int((to_decimal(milestone.amount) * Decimal("10000000")).to_integral_value()),
        "contract_id": contract_id,
    }
    if not verified.settled:
        error = conflict(verified.reason or "Release event could not be verified", "UNVERIFIED_EVENT")
        _post_submit_failure(
            db, agreement, payment, membership,
            stage="released_event",
            expected=expected,
            observed={"event_matched": verified.event_matched, "reason": verified.reason},
            discrepancy=f"UNVERIFIED_RELEASED_EVENT: {verified.reason}",
            error=error,
        )
    try:
        state_evidence = _verify_state(
            db, agreement, payment,
            released_extra=expected["amount_stroops"],
            milestone_index=milestone.sort_order, expect_approved=True, expect_released=True,
        )
    except BizError as exc:
        _fail_unverified_state(db, payment, membership, agreement, exc)

    payment.status = "confirmed"
    payment.confirmed_at = utcnow()
    milestone.status = "released"
    milestone.release_transaction_hash = tx_hash
    milestone.released_at = utcnow()
    verification.record_transaction(db, membership.business_id, verified, payment.id)
    remaining = db.scalar(
        select(AgreementMilestone).where(
            AgreementMilestone.agreement_id == agreement.id,
            AgreementMilestone.status != "released",
        )
    )
    if remaining is None and agreement.status == "active":
        agreement.status = "completed"
    audit(
        db, membership.business_id, membership.user_id, "milestone.released",
        "agreement_milestone", milestone.id,
        {"hash": tx_hash, "amount": money_str(milestone.amount), "contract_state": state_evidence},
    )
    notify_business(
        db, membership.business_id, "Milestone released",
        f"Milestone {milestone.sort_order + 1} of {agreement.title} was released on-chain.",
        "payment", milestone.id,
    )
    db.commit()
    db.refresh(agreement)
    return agreement_out(db, agreement)


def _refundable(db, agreement) -> None:
    if agreement.status not in ("active", "disputed"):
        raise conflict("Agreement is not in a refundable state", "AGREEMENT_STATE")
    if not agreement.fund_transaction_hash:
        raise conflict("Agreement must be funded before a refund", "NOT_FUNDED")
    released = db.scalar(
        select(AgreementMilestone).where(
            AgreementMilestone.agreement_id == agreement.id,
            AgreementMilestone.status == "released",
        )
    )
    if released is not None:
        raise conflict("An agreement with released milestones cannot be refunded", "MILESTONE_RELEASED")
    if to_decimal(agreement.funded_amount) <= 0:
        raise conflict("There is no escrowed balance to refund", "NO_BALANCE")


@router.post("/{agreement_id}/prepare-refund")
def prepare_refund(
    agreement_id: str,
    payload: EscrowPrepareIn,
    membership=Depends(require_roles("owner", "admin")),
    db: Session = Depends(get_db),
):
    """Prepare the real Soroban `refund(caller)` invocation. Nothing is submitted."""
    agreement = _agreement(db, agreement_id, membership.business_id)
    _refundable(db, agreement)
    _onchain_agreement_id(agreement)
    contract_id, source = _escrow_context(
        db, agreement, payload.escrow_contract_id, payload.source_account
    )
    prepared = stellar.build_soroban_refund_xdr(contract_id, source)
    payment = PaymentRecord(
        business_id=membership.business_id,
        agreement_id=agreement.id,
        kind="escrow_refund",
        amount=to_decimal(agreement.funded_amount),
        asset_code=agreement.asset_code,
        asset_issuer=agreement.asset_issuer,
        source_account=source,
        destination_account=contract_id,
        memo=agreement.reference,
        xdr=prepared.xdr,
        hash=prepared.hash,
        status="prepared",
        expires_at=add_seconds(settings.prepare_expires_minutes * 60),
        prepared_by=membership.user_id,
    )
    db.add(payment)
    try:
        db.flush()
    except IntegrityError as exc:
        db.rollback()
        raise conflict("This refund transaction hash is already used", "DUPLICATE_HASH") from exc
    audit(
        db, membership.business_id, membership.user_id, "agreement.refund_prepared",
        "agreement", agreement.id, {"hash": prepared.hash},
    )
    db.commit()
    return {
        "xdr": prepared.xdr,
        "hash": prepared.hash,
        "payment_id": payment.id,
        "expires_at": payment.expires_at,
    }


@router.post("/{agreement_id}/refund", response_model=AgreementOut)
def refund_escrow(
    agreement_id: str,
    payload: EscrowSubmitIn,
    membership=Depends(require_roles("owner", "admin")),
    db: Session = Depends(get_db),
):
    """Submit a signed refund and require the verified on-chain `refunded` event."""
    agreement = _agreement(db, agreement_id, membership.business_id)
    _refundable(db, agreement)
    onchain_id = _onchain_agreement_id(agreement)
    tx_hash = stellar.transaction_hash(payload.signed_xdr)
    _assert_no_duplicate_hash(db, tx_hash)
    payment = _escrow_payment(db, tx_hash, agreement.id, membership.business_id, "escrow_refund")
    if payment.status == "confirmed":
        raise conflict("Agreement was already refunded", "ALREADY_REFUNDED")
    if payment.status != "prepared":
        raise conflict("Prepared refund is no longer valid", "PAYMENT_STATE")
    if payment.expires_at and naive(payment.expires_at) < utcnow():
        payment.status = "failed"
        payment.failure_reason = "Prepared refund expired"
        db.commit()
        raise conflict("Prepared transaction expired; prepare a new one", "EXPIRED_XDR")
    contract_id = agreement.escrow_contract_id
    if payment.destination_account != contract_id:
        raise bad_request("Prepared refund targets a different contract", "CONTRACT_MISMATCH")
    if to_decimal(payment.amount) != to_decimal(agreement.funded_amount):
        raise bad_request("Prepared refund amount does not match the escrow balance", "AMOUNT_MISMATCH")
    _assert_identity(db, agreement, contract_id, payment.source_account)

    submitted = stellar.submit_soroban(
        payload.signed_xdr, contract_id, "refund",
        expected_parameters=[payment.source_account],
    )
    if not (submitted.confirmed and submitted.successful):
        payment.status = "failed"
        payment.failure_reason = submitted.reason
        audit(db, membership.business_id, membership.user_id, "agreement.refund_failed", "agreement", agreement.id, {"hash": tx_hash})
        db.commit()
        raise conflict(submitted.reason or "Refund was not confirmed on-chain", "UNCONFIRMED_TX")

    verified = verification.verify_soroban_refund(
        tx_hash, contract_id, onchain_id,
        payer=payment.source_account, amount=payment.amount,
    )
    expected = {
        "agreement_id": agreement.onchain_agreement_id,
        "payer": payment.source_account,
        "amount_stroops": int((to_decimal(payment.amount) * Decimal("10000000")).to_integral_value()),
        "contract_id": contract_id,
    }
    if not verified.settled:
        error = conflict(verified.reason or "Refund event could not be verified", "UNVERIFIED_EVENT")
        _post_submit_failure(
            db, agreement, payment, membership,
            stage="refunded_event",
            expected=expected,
            observed={"event_matched": verified.event_matched, "reason": verified.reason},
            discrepancy=f"UNVERIFIED_REFUNDED_EVENT: {verified.reason}",
            error=error,
        )

    try:
        state_evidence = _verify_state(db, agreement, payment, expect_empty=True)
    except BizError as exc:
        _fail_unverified_state(db, payment, membership, agreement, exc)
    verification.record_transaction(db, membership.business_id, verified, payment.id)
    payment.status = "confirmed"
    payment.confirmed_at = utcnow()
    agreement.status = "refunded"
    audit(
        db, membership.business_id, membership.user_id, "agreement.refunded", "agreement",
        agreement.id, {"hash": tx_hash, "amount": money_str(payment.amount), "contract_state": state_evidence},
    )
    notify_business(
        db, membership.business_id, "Escrow refunded",
        f"Escrow refund of {money_str(payment.amount)} {payment.asset_code} was verified on-chain.",
        "agreement", agreement.id,
    )
    db.commit()
    db.refresh(agreement)
    return agreement_out(db, agreement)


@router.get("/{agreement_id}/events")
def agreement_events(
    agreement_id: str,
    user=Depends(get_current_user),
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    agreement = _agreement(db, agreement_id, membership.business_id)
    _visible(db, agreement, membership, user)
    rows = db.scalars(
        select(AuditLog)
        .where(
            AuditLog.business_id == membership.business_id,
            AuditLog.entity_id == agreement.id,
        )
        .order_by(AuditLog.created_at)
    ).all()
    events = [
        {
            "source": "audit",
            "action": row.action,
            "entity_type": row.entity_type,
            "entity_id": row.entity_id,
            "details": row.details,
            "created_at": row.created_at,
        }
        for row in rows
    ]
    contract_id = agreement.escrow_contract_id or settings.stellar_escrow_contract_id
    if contract_id:
        try:
            response = stellar.soroban_server().get_events(
                filters=[soroban_rpc.EventFilter(contractIds=[contract_id])], limit=100
            )
            onchain_id = agreement.onchain_agreement_id
            for event in response.events:
                topics = [verification.decode_event_topic(topic) for topic in event.topic]
                # The contract holds one agreement: topic[1] is its numeric id.
                # A milestone index elsewhere in the topics must never count.
                if onchain_id is not None and (
                    len(topics) < 2 or topics[1] != int(onchain_id)
                ):
                    continue
                events.append(
                    {
                        "source": "soroban",
                        "contract_id": event.contract_id,
                        "topic": event.topic,
                        "value": event.value,
                        "ledger": event.ledger,
                        "transaction_hash": event.transaction_hash,
                    }
                )
        except Exception as exc:
            logger.warning("Could not fetch Soroban events for %s: %s", agreement.id, exc)
    return events
