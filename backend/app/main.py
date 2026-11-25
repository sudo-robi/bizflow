"""BizFlow FastAPI application: CORS, rate limiting, structured errors, v1 routers."""

from __future__ import annotations

import hmac
import logging
import uuid
from contextlib import asynccontextmanager
from typing import Any
from urllib.parse import urlparse

from fastapi import Depends, FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address
from sqlalchemy import text
from sqlalchemy.orm import Session
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import get_settings
from app.database import create_tables, get_db
from app.errors import BizError
from app.routers import (
    agreements,
    agreements_chain,
    audit,
    auth,
    businesses,
    invoices,
    notifications,
    payments,
    reconciliation,
    reports,
    suppliers,
    transactions,
    wallets,
)

logging.basicConfig(
    level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s: %(message)s"
)
logger = logging.getLogger(__name__)
settings = get_settings()

@asynccontextmanager
async def lifespan(application: FastAPI):
    if settings.use_sqlite:
        create_tables()
        logger.info("SQLite schema ready at %s", settings.sqlite_path)
    yield


app = FastAPI(
    title="BizFlow API",
    version="1.0.0",
    description="Stellar testnet business payments backend",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origins_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["Authorization", "X-Business-ID", "Content-Type", "X-Request-ID", "X-CSRF-Token"],
)


CSRF_COOKIE = "bizflow_csrf"
CSRF_HEADER = "X-CSRF-Token"
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS", "TRACE"})
# Public endpoints that must work before a session/CSRF cookie exists.
CSRF_EXEMPT_PREFIXES = (
    "/api/v1/auth/login",
    "/api/v1/auth/register",
    "/api/v1/verify/",
    "/health",
)


def _origin_allowed(origin: str) -> bool:
    """Compare a request Origin/Referer against the configured allowlist."""
    parsed = urlparse(origin)
    candidate = f"{parsed.scheme}://{parsed.netloc}".lower()
    return any(candidate == allowed.lower() for allowed in settings.cors_origins_list)


def _csrf_rejected(request: Request) -> str | None:
    """Return a stable reason code when a cookie-authenticated mutation is unsafe."""
    if request.method in SAFE_METHODS or not settings.enforce_csrf_origin_check:
        return None
    if not request.cookies.get(settings.session_cookie_name):
        return None  # Bearer/API clients do not carry the browser session cookie.
    if request.headers.get("authorization"):
        return None  # Explicit token client, not a cookie-authenticated browser.
    if request.url.path.startswith(CSRF_EXEMPT_PREFIXES):
        return None
    cookie_token = request.cookies.get(CSRF_COOKIE)
    supplied = request.headers.get(CSRF_HEADER)
    if cookie_token and supplied and hmac.compare_digest(cookie_token, supplied):
        return None
    fetch_site = request.headers.get("sec-fetch-site")
    if fetch_site in ("same-origin", "none"):
        return None
    origin = request.headers.get("origin") or request.headers.get("referer")
    if origin and _origin_allowed(origin):
        return None
    return "CSRF_TOKEN_MISSING" if not origin else "CSRF_ORIGIN_DENIED"


@app.middleware("http")
async def request_security(request: Request, call_next):
    """Correlation id, CSRF enforcement, security headers and size limits."""
    request_id = request.headers.get("X-Request-ID", "")[:128] or uuid.uuid4().hex
    request.state.request_id = request_id

    declared_size = request.headers.get("content-length")
    if declared_size and declared_size.isdigit() and int(declared_size) > settings.max_request_body_bytes:
        response = JSONResponse(
            status_code=413,
            content={"detail": "Request body is too large", "code": "REQUEST_TOO_LARGE"},
        )
        response.headers["X-Request-ID"] = request_id
        return response

    reason = _csrf_rejected(request)
    if reason:
        logger.warning("Blocked cross-site request %s %s: %s", request.method, request.url.path, reason)
        response = JSONResponse(
            status_code=403,
            content={"detail": "Cross-site request rejected", "code": reason},
        )
        response.headers["X-Request-ID"] = request_id
        return response

    response = await call_next(request)
    response.headers["X-Request-ID"] = request_id
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["X-Frame-Options"] = "DENY"
    response.headers["Referrer-Policy"] = "strict-origin-when-cross-origin"
    response.headers["Permissions-Policy"] = "geolocation=(), microphone=(), camera=()"
    response.headers["Content-Security-Policy"] = (
        "default-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'"
    )
    if settings.session_cookie_secure:
        response.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    logger.info(
        "request_id=%s method=%s path=%s status=%s",
        request_id, request.method, request.url.path, response.status_code,
    )
    return response


limiter = Limiter(key_func=get_remote_address, default_limits=[settings.rate_limit_per_minute])
app.state.limiter = limiter
app.add_middleware(SlowAPIMiddleware)
@app.exception_handler(RateLimitExceeded)
async def rate_limit_handler(request: Request, exc: RateLimitExceeded):
    """Version-independent structured 429 (slowapi's default handler varies)."""
    return JSONResponse(
        status_code=429,
        content={"detail": "Too many requests. Please retry shortly.", "code": "RATE_LIMITED"},
        headers={"Retry-After": "60"},
    )


@app.exception_handler(BizError)
async def biz_error_handler(request: Request, exc: BizError):
    body = {"detail": exc.detail, "code": exc.code}
    body.update(exc.extra)
    return JSONResponse(status_code=exc.status_code, content=body)


def _jsonable_validation_error(error: dict[str, Any]) -> dict[str, Any]:
    """Pydantic error contexts may hold exception objects; stringify those."""
    # Never echo submitted values (passwords, secrets, keys) in validation errors.
    return {
        key: ({k: str(v) for k, v in value.items()} if key == "ctx" and isinstance(value, dict) else value)
        for key, value in error.items()
        if key not in ("input", "url")
    }


@app.exception_handler(RequestValidationError)
async def validation_error_handler(request: Request, exc: RequestValidationError):
    return JSONResponse(
        status_code=422,
        content={
            "detail": [_jsonable_validation_error(error) for error in exc.errors()],
            "code": "VALIDATION_ERROR",
        },
    )


@app.exception_handler(StarletteHTTPException)
async def http_exception_handler(request: Request, exc: StarletteHTTPException):
    codes = {400: "BAD_REQUEST", 401: "UNAUTHENTICATED", 403: "FORBIDDEN", 404: "NOT_FOUND", 409: "CONFLICT", 429: "RATE_LIMITED"}
    return JSONResponse(
        status_code=exc.status_code,
        content={"detail": str(exc.detail), "code": codes.get(exc.status_code, "HTTP_ERROR")},
    )


@app.exception_handler(Exception)
async def unexpected_error_handler(request: Request, exc: Exception):
    logger.exception("Unhandled error on %s %s", request.method, request.url.path)
    return JSONResponse(
        status_code=500,
        content={"detail": "An unexpected server error occurred", "code": "INTERNAL_ERROR"},
    )


@app.get("/health")
def health():
    return {
        "status": "ok",
        "network": "testnet",  # enforced by Settings.enforce_testnet
        "escrow_configured": settings.escrow_configured,
    }


@app.get("/health/ready")
def readiness(db: Session = Depends(get_db)):
    """Liveness plus a real database probe; never claims chain reachability."""
    try:
        db.execute(text("SELECT 1"))
        database_ok = True
    except Exception as exc:
        logger.warning("Readiness database probe failed: %s", type(exc).__name__)
        database_ok = False
    ready = database_ok
    return JSONResponse(
        status_code=200 if ready else 503,
        content={
            "status": "ready" if ready else "unavailable",
            "database": "ok" if database_ok else "unavailable",
            "network": "testnet",
            "escrow_configured": settings.escrow_configured,
        },
    )


PREFIX = "/api/v1"
for module in (
    auth,
    businesses,
    suppliers,
    invoices,
    agreements,
    agreements_chain,
    reconciliation,
    payments,
    transactions,
    notifications,
    reports,
    wallets,
    audit,
):
    app.include_router(module.router, prefix=PREFIX)
app.include_router(transactions.public_router, prefix=PREFIX)
