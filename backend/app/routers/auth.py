"""Authentication endpoints: register, login, logout and current user."""

from __future__ import annotations

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy import select
from sqlalchemy.orm import Session

from app.config import get_settings
from app.database import get_db
from app.errors import unauthorized, conflict
from app.models import Business, BusinessMember, User
from app.schemas import (
    LoginRequest,
    MeResponse,
    MembershipOut,
    RegisterRequest,
    RegisterResponse,
    TokenResponse,
    UserOut,
)
from app.security import (
    create_access_token,
    get_current_user,
    hash_password,
    revoke_token,
    verify_password,
)

router = APIRouter(prefix="/auth", tags=["auth"])
settings = get_settings()


def _existing_user(db: Session, email: str) -> User | None:
    return db.scalar(select(User).where(User.email == email.lower()))


def _set_session_cookie(response: Response, token: str) -> None:
    """httpOnly session cookie; JS cannot read it. SameSite=Lax + X-Business-ID
    header requirement on business endpoints provide CSRF resistance."""
    response.set_cookie(
        key=settings.session_cookie_name,
        value=token,
        httponly=True,
        samesite="lax",
        secure=settings.session_cookie_secure,
        max_age=settings.jwt_expire_minutes * 60,
        path="/",
    )


@router.post("/register", response_model=RegisterResponse, status_code=201)
def register(response: Response, payload: RegisterRequest, db: Session = Depends(get_db)):
    email = str(payload.email).lower()
    if _existing_user(db, email) is not None:
        raise conflict("An account with this email already exists", "EMAIL_IN_USE")

    user = User(
        email=email,
        password_hash=hash_password(payload.password),
        full_name=payload.full_name,
    )
    db.add(user)
    db.flush()

    business = None
    if payload.business_name:
        business = Business(name=payload.business_name, created_by=user.id, currency="USD")
        db.add(business)
        db.flush()
        db.add(
            BusinessMember(
                business_id=business.id,
                user_id=user.id,
                email=email,
                role="owner",
                status="active",
            )
        )
    else:
        invites = db.scalars(
            select(BusinessMember).where(
                BusinessMember.email == email, BusinessMember.status == "pending"
            )
        ).all()
        for invite in invites:
            invite.user_id = user.id
            invite.status = "active"

    db.commit()
    db.refresh(user)
    if business is not None:
        db.refresh(business)
    token = create_access_token(user.id)
    _set_session_cookie(response, token)
    return RegisterResponse(
        user=UserOut.model_validate(user),
        business=None if business is None else business,
        token=token,
        token_type="bearer",
    )


@router.post("/login", response_model=TokenResponse)
def login(response: Response, payload: LoginRequest, db: Session = Depends(get_db)):
    user = _existing_user(db, str(payload.email).lower())
    if user is None or not verify_password(payload.password, user.password_hash):
        raise unauthorized("Invalid email or password")
    if not user.is_active:
        raise unauthorized("Account is inactive")
    token = create_access_token(user.id)
    _set_session_cookie(response, token)
    return TokenResponse(user=UserOut.model_validate(user), token=token)


@router.post("/logout")
def logout(
    request: Request,
    response: Response,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    """Revoke the presented JWT server-side and clear the session cookie."""
    authorization = request.headers.get("authorization", "")
    token = (
        authorization.split(" ", 1)[1]
        if authorization.lower().startswith("bearer ")
        else request.cookies.get(settings.session_cookie_name)
    )
    if token:
        revoke_token(db, token, user.id)
    response.delete_cookie(settings.session_cookie_name, path="/")
    return {"ok": True, "user_id": user.id}


@router.get("/me", response_model=MeResponse)
def me(user: User = Depends(get_current_user), db: Session = Depends(get_db)):
    memberships = db.scalars(
        select(BusinessMember).where(
            BusinessMember.user_id == user.id, BusinessMember.status == "active"
        )
    ).all()
    return MeResponse(
        user=UserOut.model_validate(user),
        memberships=[
            MembershipOut(
                id=member.id,
                business=member.business,
                role=member.role,
                status=member.status,
            )
            for member in memberships
        ],
    )
