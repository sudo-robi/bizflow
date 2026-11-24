"""Environment-driven configuration with a strict testnet-only guard."""

from __future__ import annotations

import logging
from functools import lru_cache

from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

logger = logging.getLogger(__name__)

MAINNET_PASSPHRASE = "Public Global Stellar Network ; September 2015"
TESTNET_PASSPHRASE = "Test SDF Network ; September 2015"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env", env_file_encoding="utf-8", extra="ignore", case_sensitive=False
    )

    environment: str = "development"
    database_url: str = "postgresql+psycopg2://bizflow:bizflow@localhost:5432/bizflow"
    use_sqlite: bool = False
    sqlite_path: str = "bizflow.sqlite3"
    jwt_secret: str = ""
    jwt_algorithm: str = "HS256"
    jwt_expire_minutes: int = 1440
    session_cookie_name: str = "bizflow_session"
    session_cookie_secure: bool = False

    stellar_network_passphrase: str = TESTNET_PASSPHRASE
    stellar_horizon_url: str = "https://horizon-testnet.stellar.org"
    stellar_soroban_rpc_url: str = "https://soroban-testnet.stellar.org"
    # Never invent one: an empty value disables escrow functionality.
    stellar_escrow_contract_id: str = ""

    cors_origins: str = "http://localhost:3000,http://localhost:5173,http://127.0.0.1:3000"
    rate_limit_per_minute: str = "500/minute"
    horizon_timeout_seconds: float = 20.0
    horizon_poll_attempts: int = 12
    horizon_poll_interval_seconds: float = 1.0
    soroban_poll_attempts: int = 20
    prepare_expires_minutes: int = 10
    request_timeout_seconds: float = 30.0

    @field_validator("rate_limit_per_minute")
    @classmethod
    def normalize_rate_limit(cls, value: str) -> str:
        """Accept either '120' or slowapi's '120/minute' form."""
        raw = str(value).strip()
        return f"{raw}/minute" if raw.isdigit() else raw

    @model_validator(mode="after")
    def enforce_testnet(self) -> "Settings":
        passphrase = self.stellar_network_passphrase.strip()
        horizon = self.stellar_horizon_url.lower()
        rpc = self.stellar_soroban_rpc_url.lower()
        if passphrase == MAINNET_PASSPHRASE or "public global" in passphrase.lower():
            raise ValueError("BizFlow backend is testnet-only: mainnet passphrase is refused")
        if "mainnet" in horizon or "mainnet" in rpc:
            raise ValueError("BizFlow backend is testnet-only: mainnet endpoints are refused")
        if passphrase != TESTNET_PASSPHRASE:
            raise ValueError("Unsupported Stellar network passphrase; testnet is required")

        production = self.environment.strip().lower() in {"production", "prod", "staging"}
        weak_secret = len(self.jwt_secret.strip()) < 32
        if production:
            if weak_secret:
                raise ValueError("JWT_SECRET must be at least 32 characters in production")
            self.session_cookie_secure = True
            if "bizflow:bizflow@localhost" in self.database_url and not self.use_sqlite:
                raise ValueError("DATABASE_URL must be configured in production")
        elif weak_secret:
            # Local/demo fallback only. Never accept an unset secret in production.
            if not self.jwt_secret:
                self.jwt_secret = "dev-only-jwt-secret-change-me"
            logger.warning("JWT_SECRET is unset or weak; using a development-only secret")
        return self

    @property
    def cors_origins_list(self) -> list[str]:
        return [origin.strip() for origin in self.cors_origins.split(",") if origin.strip()]

    @property
    def escrow_configured(self) -> bool:
        return bool(self.stellar_escrow_contract_id.strip())


@lru_cache
def get_settings() -> Settings:
    return Settings()
