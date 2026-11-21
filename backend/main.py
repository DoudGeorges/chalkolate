"""FastAPI application lifespan, HTTP routes, request limits, and safe error mapping."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import asynccontextmanager
from typing import Annotated, cast
from uuid import UUID

from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from google import genai
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from analyzer import (
    AnalysisTimeoutError,
    AsyncGenAIClient,
    ModelBlockedError,
    ModelTruncatedError,
    UnusableModelOutputError,
    UpstreamAuthError,
    UpstreamProviderError,
    UpstreamRateLimitError,
    UpstreamUnavailableError,
    analyze_board_image,
)
from config import Settings, load_settings
from schemas import (
    AnalysisMetadata,
    AnalysisResponse,
    ErrorEnvelope,
    HealthResponse,
    SourceSpaceDetectedError,
)
from vision import (
    CorruptImageError,
    ImageEncodingError,
    ImagePixelLimitError,
    InvalidCalibrationError,
    ProjectionError,
    UnsupportedImageFormatError,
    prepare_image,
    project_finding_to_source,
)

logger = logging.getLogger("chalkolate.api")


class ConcurrencyGate:
    """Non-blocking bounded concurrency slot tracker without unbounded queueing."""

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._active = 0

    def try_acquire(self) -> bool:
        if self._active >= self._limit:
            return False
        self._active += 1
        return True

    def release(self) -> None:
        if self._active > 0:
            self._active -= 1

    @property
    def active(self) -> int:
        return self._active


class _StreamedBodyLimitExceeded(BaseException):
    """Internal BaseException so Starlette's ExceptionMiddleware cannot swallow a 413."""


class RequestBodyLimitMiddleware:
    """Enforce upload byte limits on /api/analyze before multipart parsing."""

    def __init__(self, app: ASGIApp, *, max_body_bytes: int) -> None:
        self.app = app
        # Allow small multipart boundary + metadata overhead on top of image byte budget.
        self.max_body_bytes = max_body_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        is_analyze = (
            scope["type"] == "http"
            and scope.get("method") == "POST"
            and scope.get("path") == "/api/analyze"
        )
        if not is_analyze:
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", ()))
        raw_content_length = headers.get(b"content-length")
        if raw_content_length is not None:
            try:
                content_length = int(raw_content_length.decode("ascii"))
            except (UnicodeDecodeError, ValueError):
                await _send_error_json(
                    send,
                    status_code=400,
                    code="INVALID_CONTENT_LENGTH",
                    message="Malformed Content-Length header.",
                )
                return
            if content_length > self.max_body_bytes:
                await _send_error_json(
                    send,
                    status_code=413,
                    code="PAYLOAD_TOO_LARGE",
                    message="Uploaded snapshot exceeds maximum allowed size.",
                )
                return

        total_received = 0
        response_started = False

        async def tracked_receive() -> Message:
            nonlocal total_received
            message = await receive()
            if message.get("type") == "http.request":
                chunk = message.get("body", b"")
                if isinstance(chunk, (bytes, bytearray)):
                    total_received += len(chunk)
                    if total_received > self.max_body_bytes:
                        raise _StreamedBodyLimitExceeded()
            return message

        async def tracked_send(message: Message) -> None:
            nonlocal response_started
            if message.get("type") == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, tracked_receive, tracked_send)
        except _StreamedBodyLimitExceeded:
            if not response_started:
                await _send_error_json(
                    send,
                    status_code=413,
                    code="PAYLOAD_TOO_LARGE",
                    message="Uploaded snapshot exceeds maximum allowed size.",
                )


async def _send_error_json(
    send: Send,
    *,
    status_code: int,
    code: str,
    message: str,
    request_id: str | None = None,
) -> None:
    payload = ErrorEnvelope(code=code, message=message, request_id=request_id).model_dump_json()
    body = payload.encode("utf-8")
    await send(
        {
            "type": "http.response.start",
            "status": status_code,
            "headers": [
                (b"content-type", b"application/json"),
                (b"content-length", str(len(body)).encode("ascii")),
            ],
        }
    )
    await send({"type": "http.response.body", "body": body})


def _error_response(
    *,
    status_code: int,
    code: str,
    message: str,
    request_id: str | None = None,
    headers: Mapping[str, str] | None = None,
) -> JSONResponse:
    envelope = ErrorEnvelope(code=code, message=message, request_id=request_id)
    return JSONResponse(
        status_code=status_code,
        content=envelope.model_dump(),
        headers=dict(headers) if headers else None,
    )


def _extract_request_id_best_effort(raw_metadata: str) -> str | None:
    try:
        data = json.loads(raw_metadata)
    except (json.JSONDecodeError, TypeError):
        return None
    if not isinstance(data, dict):
        return None
    candidate = data.get("request_id")
    if not isinstance(candidate, str):
        return None
    try:
        return str(UUID(candidate))
    except ValueError:
        return None


def _default_client_factory(settings: Settings) -> AsyncGenAIClient:
    return cast(AsyncGenAIClient, genai.Client(api_key=settings.gemini_api_key))


def create_app(
    settings: Settings | None = None,
    client_factory: Callable[[Settings], AsyncGenAIClient] | None = None,
) -> FastAPI:
    """Create the Chalkolate FastAPI application with explicit lifespan and dependencies."""
    resolved_settings = settings or load_settings()
    resolved_factory = client_factory or _default_client_factory
    logging.basicConfig(level=getattr(logging, resolved_settings.log_level, logging.INFO))

    gate = ConcurrencyGate(resolved_settings.analysis_max_concurrency)

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        client: AsyncGenAIClient | None = None
        if resolved_settings.analysis_configured:
            client = resolved_factory(resolved_settings)
        app.state.genai_client = client
        try:
            yield
        finally:
            if client is not None:
                try:
                    await client.aio.aclose()
                finally:
                    client.close()

    app = FastAPI(
        title="Chalkolate API",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.settings = resolved_settings
    app.state.concurrency_gate = gate

    if resolved_settings.cors_allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(resolved_settings.cors_allowed_origins),
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Content-Type"],
        )

    multipart_overhead = resolved_settings.max_metadata_bytes + 64 * 1024
    app.add_middleware(
        RequestBodyLimitMiddleware,
        max_body_bytes=resolved_settings.max_upload_bytes + multipart_overhead,
    )

    @app.exception_handler(RequestValidationError)
    async def handle_request_validation(
        _request: Request,
        _exc: RequestValidationError,
    ) -> JSONResponse:
        return _error_response(
            status_code=422,
            code="INVALID_REQUEST",
            message="Request must contain multipart 'image' file and 'metadata' JSON form fields.",
        )

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_exception(
        _request: Request,
        exc: StarletteHTTPException,
    ) -> JSONResponse:
        code = "NOT_FOUND" if exc.status_code == 404 else "HTTP_ERROR"
        message = exc.detail if isinstance(exc.detail, str) else "Request failed."
        return _error_response(status_code=exc.status_code, code=code, message=message)

    @app.exception_handler(Exception)
    async def handle_unexpected_exception(
        _request: Request,
        exc: Exception,
    ) -> JSONResponse:
        logger.error("Unhandled backend failure (%s)", type(exc).__name__)
        return _error_response(
            status_code=500,
            code="INTERNAL_ERROR",
            message="An internal server error occurred while processing the request.",
        )

    @app.get("/api/health", response_model=HealthResponse)
    async def get_health() -> HealthResponse:
        return HealthResponse(
            status="ok",
            analysis_configured=resolved_settings.analysis_configured,
            deep_mode_configured=resolved_settings.deep_mode_configured,
            credentials_verified=False,
        )

    @app.post("/api/analyze", response_model=AnalysisResponse)
    async def post_analyze(
        request: Request,
        image: Annotated[UploadFile, File(...)],
        metadata: Annotated[str, Form(...)],
    ) -> AnalysisResponse | JSONResponse:
        started_ns = time.perf_counter_ns()
        request_id_str: str | None = None

        try:
            if len(metadata.encode("utf-8")) > resolved_settings.max_metadata_bytes:
                return _error_response(
                    status_code=413,
                    code="METADATA_TOO_LARGE",
                    message="Analysis metadata exceeds maximum allowed size.",
                )

            request_id_str = _extract_request_id_best_effort(metadata)
            try:
                parsed_metadata = AnalysisMetadata.model_validate_json(metadata)
            except ValidationError:
                return _error_response(
                    status_code=422,
                    code="INVALID_METADATA",
                    message="Invalid analysis metadata payload.",
                    request_id=request_id_str,
                )

            request_id_str = str(parsed_metadata.request_id)

            if not resolved_settings.analysis_configured:
                return _error_response(
                    status_code=503,
                    code="ANALYSIS_NOT_CONFIGURED",
                    message="Backend GEMINI_API_KEY or model is not configured.",
                    request_id=request_id_str,
                )

            if parsed_metadata.deep_mode and not resolved_settings.deep_mode_configured:
                return _error_response(
                    status_code=400,
                    code="DEEP_MODE_DISABLED",
                    message="Deep Mode is disabled because GEMINI_DEEP_MODEL is empty.",
                    request_id=request_id_str,
                )

            raw_bytes = await image.read(resolved_settings.max_upload_bytes + 1)
            if len(raw_bytes) > resolved_settings.max_upload_bytes:
                return _error_response(
                    status_code=413,
                    code="PAYLOAD_TOO_LARGE",
                    message="Uploaded image exceeds maximum allowed byte size.",
                    request_id=request_id_str,
                )
            if not raw_bytes:
                return _error_response(
                    status_code=422,
                    code="EMPTY_IMAGE",
                    message="Uploaded image is empty.",
                    request_id=request_id_str,
                )
        finally:
            await image.close()

        client = cast(AsyncGenAIClient | None, getattr(request.app.state, "genai_client", None))
        if client is None:
            return _error_response(
                status_code=503,
                code="ANALYSIS_NOT_CONFIGURED",
                message="Backend analysis client is unavailable.",
                request_id=request_id_str,
            )

        if not gate.try_acquire():
            return _error_response(
                status_code=503,
                code="CAPACITY_EXCEEDED",
                message="Analysis server is busy; try again shortly.",
                request_id=request_id_str,
                headers={"Retry-After": "2"},
            )

        try:
            try:
                prepared = await asyncio.to_thread(
                    prepare_image,
                    raw_bytes,
                    corners=parsed_metadata.corners,
                    enhance_chalkboard=parsed_metadata.enhance_chalkboard,
                    max_image_pixels=resolved_settings.max_image_pixels,
                    max_long_edge=resolved_settings.max_model_long_edge,
                )
            except UnsupportedImageFormatError as exc:
                return _error_response(
                    status_code=415,
                    code="UNSUPPORTED_IMAGE_FORMAT",
                    message=str(exc),
                    request_id=request_id_str,
                )
            except ImagePixelLimitError as exc:
                return _error_response(
                    status_code=413,
                    code="IMAGE_PIXELS_EXCEEDED",
                    message=str(exc),
                    request_id=request_id_str,
                )
            except CorruptImageError as exc:
                return _error_response(
                    status_code=422,
                    code="CORRUPT_IMAGE",
                    message=str(exc),
                    request_id=request_id_str,
                )
            except InvalidCalibrationError as exc:
                return _error_response(
                    status_code=422,
                    code="INVALID_CALIBRATION",
                    message=str(exc),
                    request_id=request_id_str,
                )
            except ImageEncodingError as exc:
                return _error_response(
                    status_code=500,
                    code="IMAGE_ENCODING_FAILED",
                    message=str(exc),
                    request_id=request_id_str,
                )

            try:
                model_result = await analyze_board_image(
                    client,
                    prepared,
                    parsed_metadata,
                    resolved_settings,
                )
            except AnalysisTimeoutError as exc:
                return _error_response(
                    status_code=504,
                    code="UPSTREAM_TIMEOUT",
                    message=str(exc),
                    request_id=request_id_str,
                )
            except UpstreamRateLimitError as exc:
                headers = (
                    {"Retry-After": str(exc.retry_after_s)}
                    if exc.retry_after_s is not None
                    else None
                )
                return _error_response(
                    status_code=429,
                    code="UPSTREAM_RATE_LIMITED",
                    message=str(exc),
                    request_id=request_id_str,
                    headers=headers,
                )
            except UpstreamAuthError as exc:
                return _error_response(
                    status_code=502,
                    code="UPSTREAM_AUTH_ERROR",
                    message=str(exc),
                    request_id=request_id_str,
                )
            except UpstreamUnavailableError as exc:
                return _error_response(
                    status_code=503,
                    code="UPSTREAM_UNAVAILABLE",
                    message=str(exc),
                    request_id=request_id_str,
                    headers={"Retry-After": str(exc.retry_after_s or 5)},
                )
            except (ModelBlockedError, ModelTruncatedError, UnusableModelOutputError) as exc:
                return _error_response(
                    status_code=502,
                    code="UNUSABLE_MODEL_OUTPUT",
                    message=str(exc),
                    request_id=request_id_str,
                )
            except UpstreamProviderError as exc:
                return _error_response(
                    status_code=502,
                    code="UPSTREAM_PROVIDER_ERROR",
                    message=str(exc),
                    request_id=request_id_str,
                )

            try:
                source_errors: list[SourceSpaceDetectedError] = [
                    project_finding_to_source(finding, prepared) for finding in model_result.errors
                ]
            except ProjectionError:
                return _error_response(
                    status_code=502,
                    code="INVALID_COORDINATE_PROJECTION",
                    message="Model coordinates could not be validly projected onto source image.",
                    request_id=request_id_str,
                )

            elapsed_ms = max(0, (time.perf_counter_ns() - started_ns) // 1_000_000)
            return AnalysisResponse(
                request_id=request_id_str,
                board_summary=model_result.board_summary,
                errors=source_errors,
                image_width=prepared.source_width,
                image_height=prepared.source_height,
                latency_ms=elapsed_ms,
            )
        finally:
            gate.release()

    return app


app = create_app()
