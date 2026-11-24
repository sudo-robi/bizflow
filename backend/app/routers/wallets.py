"""Connected wallet addresses. Public keys only; secrets are never accepted."""

from __future__ import annotations

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.database import get_db
from app.errors import conflict, not_found
from app.models import WalletConnection
from app.schemas import WalletCreate, WalletOut
from app.security import get_business_membership
from app.services.notifications import audit

router = APIRouter(prefix="/wallets", tags=["wallets"])


@router.get("", response_model=list[WalletOut])
def list_wallets(
    membership=Depends(get_business_membership), db: Session = Depends(get_db)
):
    return db.scalars(
        select(WalletConnection)
        .where(WalletConnection.business_id == membership.business_id)
        .order_by(WalletConnection.created_at.desc())
    ).all()


@router.post("", response_model=WalletOut, status_code=201)
def connect_wallet(
    payload: WalletCreate,
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    existing = db.scalar(
        select(WalletConnection).where(
            WalletConnection.business_id == membership.business_id,
            WalletConnection.public_key == payload.public_key,
        )
    )
    if existing is not None:
        raise conflict("This wallet is already connected", "DUPLICATE_WALLET")
    wallet = WalletConnection(
        business_id=membership.business_id,
        public_key=payload.public_key,
        network="testnet",
        label=payload.label,
        created_by=membership.user_id,
    )
    db.add(wallet)
    audit(
        db, membership.business_id, membership.user_id, "wallet.connected", "wallet_connection",
        wallet.id, {"network": "testnet"},
    )
    db.commit()
    db.refresh(wallet)
    return wallet


@router.delete("/{wallet_id}")
def disconnect_wallet(
    wallet_id: str,
    membership=Depends(get_business_membership),
    db: Session = Depends(get_db),
):
    wallet = db.get(WalletConnection, wallet_id)
    if wallet is None or wallet.business_id != membership.business_id:
        raise not_found("Wallet not found")
    db.delete(wallet)
    audit(
        db, membership.business_id, membership.user_id, "wallet.disconnected",
        "wallet_connection", wallet.id,
    )
    db.commit()
    return {"ok": True}
