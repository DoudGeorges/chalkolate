"""Application settings loaded independently of the launch working directory."""

from __future__ import annotations

import os
from collections.abc import Mapping
from dataclasses import dataclass, field
from pathlib import Path

from dotenv import load_dotenv

BACKEND_DIR = Path(__file__).resolve().parent
REPO_ROOT = BACKEND_DIR.parent

VALID_LOG_LEVELS = frozenset({"DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"})


class ConfigurationError(ValueError):
    """Raised when environment configuration contains invalid values."""


@dataclass(frozen=True)
class Settings:
    """Immutable backend configuration."""

    gemini_api_key: str = field(default="", repr=False)
    gemini_model: str = "gemini-4-hydrogen"
    gemini_deep_model: str = "gemini-4-carbon"
    confidence_threshold: float = 0.85
    analysis_max_concurrency: int = 2
    analysis_timeout_seconds: float = 30.0
    analysis_deep_timeout_seconds: float = 60.0
    analysis_max_output_tokens: int = 4096
    analysis_deep_max_output_tokens: int = 8192
    max_upload_bytes: int = 10 * 1024 * 1024
    max_metadata_bytes: int = 16 * 1024
    max_image_pixels: int = 25_000_000
    max_model_long_edge: int = 1280
    cors_allowed_origins: tuple[str, ...] = ()
    log_level: str = "INFO"

    def __post_init__(self) -> None:
        if not 0.0 <= self.confidence_threshold <= 1.0:
            raise ConfigurationError("ANALYSIS_CONFIDENCE_THRESHOLD must be between 0.0 and 1.0.")
        if self.analysis_max_concurrency < 1:
            raise ConfigurationError("ANALYSIS_MAX_CONCURRENCY must be >= 1.")
        if self.analysis_timeout_seconds <= 0:
            raise ConfigurationError("ANALYSIS_TIMEOUT_SECONDS must be > 0.")
        if self.analysis_deep_timeout_seconds <= 0:
            raise ConfigurationError("ANALYSIS_DEEP_TIMEOUT_SECONDS must be > 0.")
        if self.analysis_max_output_tokens < 64:
            raise ConfigurationError("ANALYSIS_MAX_OUTPUT_TOKENS must be >= 64.")
        if self.analysis_deep_max_output_tokens < 64:
            raise ConfigurationError("ANALYSIS_DEEP_MAX_OUTPUT_TOKENS must be >= 64.")
        if self.max_upload_bytes < 1024:
            raise ConfigurationError("MAX_UPLOAD_BYTES must be >= 1024.")
        if self.max_metadata_bytes < 256:
            raise ConfigurationError("MAX_METADATA_BYTES must be >= 256.")
        if self.max_image_pixels < 1024:
            raise ConfigurationError("MAX_IMAGE_PIXELS must be >= 1024.")
        if self.max_model_long_edge < 64:
            raise ConfigurationError("MAX_MODEL_LONG_EDGE must be >= 64.")
        if any(origin == "*" for origin in self.cors_allowed_origins):
            raise ConfigurationError(
                "CORS_ALLOWED_ORIGINS cannot contain '*'; list explicit development origins only."
            )
        if self.log_level not in VALID_LOG_LEVELS:
            raise ConfigurationError(f"LOG_LEVEL must be one of {sorted(VALID_LOG_LEVELS)}.")

    @property
    def analysis_configured(self) -> bool:
        """Whether normal analysis has credentials and a configured model."""
        return bool(self.gemini_api_key.strip() and self.gemini_model.strip())

    @property
    def deep_mode_configured(self) -> bool:
        """Whether Deep Mode is available and backed by a non-empty model ID."""
        return self.analysis_configured and bool(self.gemini_deep_model.strip())


def _get_str(env: Mapping[str, str], key: str, default: str) -> str:
    raw = env.get(key)
    return default if raw is None else raw.strip()


def _get_int(env: Mapping[str, str], key: str, default: int) -> int:
    raw = env.get(key)
    if raw is None or not raw.strip():
        return default
    try:
        return int(raw.strip())
    except ValueError as exc:
        raise ConfigurationError(f"{key} must be an integer.") from exc


def _get_float(env: Mapping[str, str], key: str, default: float) -> float:
    raw = env.get(key)
    if raw is None or not raw.strip():
        return default
    try:
        value = float(raw.strip())
    except ValueError as exc:
        raise ConfigurationError(f"{key} must be a number.") from exc
    if value != value or value in (float("inf"), float("-inf")):
        raise ConfigurationError(f"{key} must be finite.")
    return value


def _parse_origins(raw: str) -> tuple[str, ...]:
    if not raw.strip():
        return ()
    origins = tuple(part.strip() for part in raw.split(",") if part.strip())
    for origin in origins:
        if origin == "*":
            raise ConfigurationError(
                "CORS_ALLOWED_ORIGINS cannot contain '*'; list explicit origins only."
            )
        if not (origin.startswith("http://") or origin.startswith("https://")):
            raise ConfigurationError(
                f"Invalid origin in CORS_ALLOWED_ORIGINS: {origin!r}. Must start with http:// or https://."
            )
    return origins


def load_settings(
    *,
    load_env_files: bool = True,
    environ: Mapping[str, str] | None = None,
) -> Settings:
    """Load settings from process environment and deterministic .env paths.

    Process environment variables take precedence over .env files. When loading
    files, repo-root .env is loaded before backend/.env with override=False.
    """
    if load_env_files and environ is None:
        load_dotenv(REPO_ROOT / ".env", override=False)
        load_dotenv(BACKEND_DIR / ".env", override=False)

    env: Mapping[str, str] = os.environ if environ is None else environ

    return Settings(
        gemini_api_key=_get_str(env, "GEMINI_API_KEY", ""),
        gemini_model=_get_str(env, "GEMINI_MODEL", "gemini-4-hydrogen"),
        gemini_deep_model=_get_str(env, "GEMINI_DEEP_MODEL", "gemini-4-carbon"),
        confidence_threshold=_get_float(env, "ANALYSIS_CONFIDENCE_THRESHOLD", 0.85),
        analysis_max_concurrency=_get_int(env, "ANALYSIS_MAX_CONCURRENCY", 2),
        analysis_timeout_seconds=_get_float(env, "ANALYSIS_TIMEOUT_SECONDS", 30.0),
        analysis_deep_timeout_seconds=_get_float(env, "ANALYSIS_DEEP_TIMEOUT_SECONDS", 60.0),
        analysis_max_output_tokens=_get_int(env, "ANALYSIS_MAX_OUTPUT_TOKENS", 4096),
        analysis_deep_max_output_tokens=_get_int(env, "ANALYSIS_DEEP_MAX_OUTPUT_TOKENS", 8192),
        max_upload_bytes=_get_int(env, "MAX_UPLOAD_BYTES", 10 * 1024 * 1024),
        max_metadata_bytes=_get_int(env, "MAX_METADATA_BYTES", 16 * 1024),
        max_image_pixels=_get_int(env, "MAX_IMAGE_PIXELS", 25_000_000),
        max_model_long_edge=_get_int(env, "MAX_MODEL_LONG_EDGE", 1280),
        cors_allowed_origins=_parse_origins(_get_str(env, "CORS_ALLOWED_ORIGINS", "")),
        log_level=_get_str(env, "LOG_LEVEL", "INFO").upper(),
    )
