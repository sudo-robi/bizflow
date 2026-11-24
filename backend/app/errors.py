"""Structured domain errors and HTTP exception translation."""

from __future__ import annotations

from typing import Any


class BizError(Exception):
    """A domain error that maps to the contract error envelope."""

    def __init__(self, status_code: int, code: str, detail: str, extra: dict[str, Any] | None = None):
        super().__init__(detail)
        self.status_code = status_code
        self.code = code
        self.detail = detail
        self.extra = extra or {}


def bad_request(detail: str, code: str = "BAD_REQUEST") -> BizError:
    return BizError(400, code, detail)


def unauthorized(detail: str = "Authentication required") -> BizError:
    return BizError(401, "UNAUTHENTICATED", detail)


def forbidden(detail: str = "You do not have access to this resource") -> BizError:
    return BizError(403, "FORBIDDEN", detail)


def not_found(detail: str = "Resource not found") -> BizError:
    return BizError(404, "NOT_FOUND", detail)


def conflict(detail: str, code: str = "CONFLICT") -> BizError:
    return BizError(409, code, detail)


def chain_error(detail: str) -> BizError:
    return BizError(502, "CHAIN_ERROR", detail)
