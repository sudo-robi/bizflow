"""BizFlow FastAPI application: CORS, rate limiting, structured errors, v1 routers."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from slowapi import Limiter
from slowapi.errors import RateLimitExceeded
from slowapi.middleware import SlowAPIMiddleware
from slowapi.util import get_remote_address
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.config import get_settings
from app.database import create_tables
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
    allow_headers=["Authorization", "X-Business-ID", "Content-Type"],
)

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
    return {
        key: ({k: str(v) for k, v in value.items()} if key == "ctx" and isinstance(value, dict)
              else str(value) if key == "input" and not isinstance(value, (str, int, float, bool, list, dict, type(None)))
              else value)
        for key, value in error.items()
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
        "network": "testnet",
        "escrow_configured": settings.escrow_configured,
    }


PREFIX = "/api/v1"
for module in (
    auth,
    businesses,
    suppliers,
    invoices,
    agreements,
    agreements_chain,
    payments,
    transactions,
    notifications,
    reports,
    wallets,
    audit,
):
    app.include_router(module.router, prefix=PREFIX)
app.include_router(transactions.public_router, prefix=PREFIX)
