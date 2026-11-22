"""FastAPI application lifespan, HTTP routes, request limits, and safe error mapping."""

from __future__ import annotations

import asyncio
import json
import logging
import time
from collections.abc import AsyncIterator, Callable, Mapping
from contextlib import AsyncExitStack, asynccontextmanager
from typing import Annotated, cast
from uuid import UUID

import httpx
from anyio import CancelScope
from fastapi import FastAPI, File, Form, Request, UploadFile
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, Response, StreamingResponse
from google import genai
from pydantic import ValidationError
from starlette.exceptions import HTTPException as StarletteHTTPException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from analyzer import (
    AnalysisTimeoutError,
    AnalyzerError,
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
from notes import build_notes_update
from schemas import (
    MAX_NOTES_METADATA_BYTES,
    AnalysisMetadata,
    AnalysisResponse,
    BoardDetectionResponse,
    ErrorEnvelope,
    HealthResponse,
    NotesMetadata,
    NotesResponse,
    SourceSpaceDetectedError,
    SpeechRequest,
    SpeechVoiceOption,
    VoicesResponse,
)
from speech import (
    DEFAULT_VOICE_KEY,
    OpenedSpeechStream,
    SlidingWindowRateLimiter,
    SpeechAuthError,
    SpeechConfigError,
    SpeechError,
    SpeechPlanError,
    SpeechQuotaError,
    SpeechRateLimitError,
    SpeechTimeoutError,
    SpeechUnavailableError,
    VoiceCatalog,
    open_elevenlabs_speech_stream,
)
from vision import (
    CorruptImageError,
    ImageEncodingError,
    ImagePixelLimitError,
    InvalidCalibrationError,
    PreparedImage,
    ProjectionError,
    UnsupportedImageFormatError,
    detect_board_corners,
    prepare_image,
    project_box_to_source,
    project_finding_to_source,
)

logger = logging.getLogger("chalkolate.api")

MAX_SPEECH_BODY_BYTES = 4096
PARTIAL_ANALYSIS_HEADER = "X-Chalkolate-Partial-Analysis"
# Every API response is per-request user data (board findings, notes, audio). Forbid browsers,
# Vercel's CDN, and any intermediary from storing or replaying one to another caller.
NO_STORE_CACHE_CONTROL = "no-store, private"


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


class PerClientGate:
    """Caps in-flight requests per client key so one user cannot hold every global slot."""

    def __init__(self, limit: int) -> None:
        self._limit = limit
        self._active: dict[str, int] = {}

    def try_acquire(self, key: str) -> bool:
        current = self._active.get(key, 0)
        if current >= self._limit:
            return False
        self._active[key] = current + 1
        return True

    def release(self, key: str) -> None:
        current = self._active.get(key, 0)
        if current <= 1:
            self._active.pop(key, None)
        else:
            self._active[key] = current - 1


def _client_key(request: Request) -> str:
    """Best-effort client identity; behind Vercel the first X-Forwarded-For hop is the caller."""
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    if forwarded:
        return forwarded[:64]
    real_ip = request.headers.get("x-real-ip", "").strip()
    if real_ip:
        return real_ip[:64]
    return request.client.host if request.client else "unknown"


class SpeechStreamingResponse(StreamingResponse):
    def __init__(self, opened: OpenedSpeechStream, gate: ConcurrencyGate) -> None:
        super().__init__(
            opened.iter_chunks(),
            media_type=opened.media_type,
            headers={"Cache-Control": NO_STORE_CACHE_CONTROL},
        )
        self.opened = opened
        self.gate = gate

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        try:
            await super().__call__(scope, receive, send)
        finally:
            try:
                # A disconnect can interrupt the response before iteration starts or at a yield.
                with CancelScope(shield=True):
                    await self.opened.aclose()
            finally:
                self.gate.release()


class NoStoreCacheMiddleware:
    """Mark every HTTP response ``Cache-Control: no-store, private`` unless already set."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_with_no_store(message: Message) -> None:
            if message.get("type") == "http.response.start":
                headers = list(message.get("headers", ()))
                if not any(name.lower() == b"cache-control" for name, _ in headers):
                    headers.append((b"cache-control", NO_STORE_CACHE_CONTROL.encode("ascii")))
                    message = {**message, "headers": headers}
            await send(message)

        await self.app(scope, receive, send_with_no_store)


class _StreamedBodyLimitExceeded(BaseException):
    """Internal BaseException so Starlette's ExceptionMiddleware cannot swallow a 413."""


class RequestBodyLimitMiddleware:
    """Enforce per-route request body limits before FastAPI/multipart parsing."""

    def __init__(self, app: ASGIApp, *, path_limits: Mapping[str, int]) -> None:
        self.app = app
        self.path_limits = dict(path_limits)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        max_body_bytes = (
            self.path_limits.get(scope.get("path", ""))
            if scope["type"] == "http" and scope.get("method") == "POST"
            else None
        )
        if max_body_bytes is None:
            await self.app(scope, receive, send)
            return

        headers = dict(scope.get("headers", ()))
        raw_content_length = headers.get(b"content-length")
        if raw_content_length is not None:
            try:
                if not raw_content_length.isdigit():
                    raise ValueError
                content_length = int(raw_content_length)
            except ValueError:
                await _send_error_json(
                    send,
                    status_code=400,
                    code="INVALID_CONTENT_LENGTH",
                    message="Malformed Content-Length header.",
                )
                return
            if content_length > max_body_bytes:
                await _send_error_json(
                    send,
                    status_code=413,
                    code="PAYLOAD_TOO_LARGE",
                    message="Request payload exceeds maximum allowed size.",
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
                    if total_received > max_body_bytes:
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
                    message="Request payload exceeds maximum allowed size.",
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
                (b"cache-control", NO_STORE_CACHE_CONTROL.encode("ascii")),
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
    # Set here as well as in NoStoreCacheMiddleware: the catch-all 500 handler runs in
    # Starlette's ServerErrorMiddleware, outside every user middleware.
    return JSONResponse(
        status_code=status_code,
        content=envelope.model_dump(),
        headers={"Cache-Control": NO_STORE_CACHE_CONTROL, **(headers or {})},
    )


def _extract_request_id_best_effort(raw_metadata: str) -> str | None:
    try:
        data = json.loads(raw_metadata)
    except (ValueError, RecursionError):
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


def _speech_error_response(exc: SpeechError) -> JSONResponse:
    """Map typed ElevenLabs failures to the shared error envelope without provider details."""
    message = str(exc)
    if isinstance(exc, SpeechConfigError):
        return _error_response(status_code=503, code="SPEECH_NOT_CONFIGURED", message=message)
    if isinstance(exc, SpeechAuthError):
        return _error_response(status_code=502, code="SPEECH_AUTH_ERROR", message=message)
    if isinstance(exc, SpeechQuotaError):
        return _error_response(
            status_code=503,
            code="SPEECH_QUOTA_EXCEEDED",
            message=message,
            headers={"Retry-After": str(exc.retry_after_s or 60)},
        )
    if isinstance(exc, SpeechPlanError):
        return _error_response(status_code=503, code="SPEECH_VOICE_PLAN_REQUIRED", message=message)
    if isinstance(exc, SpeechRateLimitError):
        return _error_response(
            status_code=429,
            code="SPEECH_RATE_LIMITED",
            message=message,
            headers={"Retry-After": str(exc.retry_after_s or 10)},
        )
    if isinstance(exc, SpeechTimeoutError):
        return _error_response(status_code=504, code="SPEECH_TIMEOUT", message=message)
    if isinstance(exc, SpeechUnavailableError):
        return _error_response(
            status_code=503,
            code="SPEECH_UNAVAILABLE",
            message=message,
            headers={"Retry-After": str(exc.retry_after_s or 5)},
        )
    return _error_response(status_code=502, code="SPEECH_PROVIDER_ERROR", message=message)


def _model_error_response(exc: AnalyzerError, request_id: str) -> JSONResponse:
    if isinstance(exc, AnalysisTimeoutError):
        return _error_response(
            status_code=504,
            code="UPSTREAM_TIMEOUT",
            message=str(exc),
            request_id=request_id,
        )
    if isinstance(exc, UpstreamRateLimitError):
        headers = {"Retry-After": str(exc.retry_after_s)} if exc.retry_after_s is not None else None
        return _error_response(
            status_code=429,
            code="UPSTREAM_RATE_LIMITED",
            message=str(exc),
            request_id=request_id,
            headers=headers,
        )
    if isinstance(exc, UpstreamAuthError):
        return _error_response(
            status_code=502,
            code="UPSTREAM_AUTH_ERROR",
            message=str(exc),
            request_id=request_id,
        )
    if isinstance(exc, UpstreamUnavailableError):
        return _error_response(
            status_code=503,
            code="UPSTREAM_UNAVAILABLE",
            message=str(exc),
            request_id=request_id,
            headers={"Retry-After": str(exc.retry_after_s or 5)},
        )
    if isinstance(exc, (ModelBlockedError, ModelTruncatedError, UnusableModelOutputError)):
        return _error_response(
            status_code=502,
            code="UNUSABLE_MODEL_OUTPUT",
            message=str(exc),
            request_id=request_id,
        )
    if isinstance(exc, UpstreamProviderError):
        return _error_response(
            status_code=502,
            code="UPSTREAM_PROVIDER_ERROR",
            message=str(exc),
            request_id=request_id,
        )
    raise exc


async def _prepare_snapshot(
    raw_bytes: bytes,
    metadata: AnalysisMetadata | NotesMetadata,
    settings: Settings,
    request_id: str,
) -> PreparedImage | JSONResponse:
    try:
        return await asyncio.to_thread(
            prepare_image,
            raw_bytes,
            corners=metadata.corners,
            max_image_pixels=settings.max_image_pixels,
            max_long_edge=settings.max_model_long_edge,
        )
    except UnsupportedImageFormatError as exc:
        return _error_response(
            status_code=415,
            code="UNSUPPORTED_IMAGE_FORMAT",
            message=str(exc),
            request_id=request_id,
        )
    except ImagePixelLimitError as exc:
        return _error_response(
            status_code=413,
            code="IMAGE_PIXELS_EXCEEDED",
            message=str(exc),
            request_id=request_id,
        )
    except CorruptImageError as exc:
        return _error_response(
            status_code=422,
            code="CORRUPT_IMAGE",
            message=str(exc),
            request_id=request_id,
        )
    except InvalidCalibrationError as exc:
        return _error_response(
            status_code=422,
            code="INVALID_CALIBRATION",
            message=str(exc),
            request_id=request_id,
        )
    except ImageEncodingError as exc:
        return _error_response(
            status_code=500,
            code="IMAGE_ENCODING_FAILED",
            message=str(exc),
            request_id=request_id,
        )


async def _read_image_upload(
    image: UploadFile, max_bytes: int, request_id: str | None = None
) -> bytes | JSONResponse:
    raw_bytes = await image.read(max_bytes + 1)
    if len(raw_bytes) > max_bytes:
        return _error_response(
            status_code=413,
            code="PAYLOAD_TOO_LARGE",
            message="Uploaded image exceeds maximum allowed byte size.",
        )
    if not raw_bytes:
        return _error_response(
            status_code=422,
            code="EMPTY_IMAGE",
            message="Uploaded image is empty.",
        )
    return raw_bytes


def _default_client_factory(settings: Settings) -> AsyncGenAIClient:
    return cast(AsyncGenAIClient, genai.Client(api_key=settings.gemini_api_key))


def _default_speech_client_factory(_settings: Settings) -> httpx.AsyncClient:
    return httpx.AsyncClient()


def create_app(
    settings: Settings | None = None,
    client_factory: Callable[[Settings], AsyncGenAIClient] | None = None,
    speech_client_factory: Callable[[Settings], httpx.AsyncClient] | None = None,
) -> FastAPI:
    """Create the Chalkolate FastAPI application with explicit lifespan and dependencies."""
    resolved_settings = settings or load_settings()
    resolved_factory = client_factory or _default_client_factory
    resolved_speech_factory = speech_client_factory or _default_speech_client_factory
    logging.basicConfig(level=getattr(logging, resolved_settings.log_level, logging.INFO))

    gate = ConcurrencyGate(resolved_settings.analysis_max_concurrency)
    detection_gate = ConcurrencyGate(resolved_settings.analysis_max_concurrency)
    speech_gate = ConcurrencyGate(resolved_settings.speech_max_concurrency)
    notes_gate = ConcurrencyGate(resolved_settings.notes_max_concurrency)
    analysis_client_gate = PerClientGate(resolved_settings.per_client_max_concurrency)
    notes_client_gate = PerClientGate(resolved_settings.per_client_max_concurrency)
    speech_rate_limiter = SlidingWindowRateLimiter(
        resolved_settings.speech_rate_limit_per_minute,
        60.0,
    )
    voice_catalog = VoiceCatalog()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        async with AsyncExitStack() as stack:
            app.state.genai_client = None
            app.state.speech_client = None
            if resolved_settings.analysis_configured:
                client = resolved_factory(resolved_settings)
                stack.callback(client.close)
                stack.push_async_callback(client.aio.aclose)
                app.state.genai_client = client
            if resolved_settings.speech_configured:
                speech_client = resolved_speech_factory(resolved_settings)
                stack.push_async_callback(speech_client.aclose)
                app.state.speech_client = speech_client
            yield

    app = FastAPI(
        title="Chalkolate API",
        version="0.1.0",
        lifespan=lifespan,
    )
    app.state.settings = resolved_settings
    app.state.concurrency_gate = gate
    app.state.speech_concurrency_gate = speech_gate
    app.state.notes_concurrency_gate = notes_gate
    app.state.voice_catalog = voice_catalog

    multipart_overhead = resolved_settings.max_metadata_bytes + 64 * 1024
    upload_limit = resolved_settings.max_upload_bytes + multipart_overhead
    app.add_middleware(
        RequestBodyLimitMiddleware,
        path_limits={
            "/api/analyze": upload_limit,
            "/api/detect-board": upload_limit,
            "/api/notes": upload_limit + MAX_NOTES_METADATA_BYTES,
            "/api/speech": MAX_SPEECH_BODY_BYTES,
        },
    )
    if resolved_settings.cors_allowed_origins:
        app.add_middleware(
            CORSMiddleware,
            allow_origins=list(resolved_settings.cors_allowed_origins),
            allow_methods=["GET", "POST", "OPTIONS"],
            allow_headers=["Content-Type"],
            expose_headers=["Retry-After", PARTIAL_ANALYSIS_HEADER],
        )
    # Added last so it is the outermost user middleware and also covers early 413/400 replies.
    app.add_middleware(NoStoreCacheMiddleware)

    @app.exception_handler(RequestValidationError)
    async def handle_request_validation(
        _request: Request,
        _exc: RequestValidationError,
    ) -> JSONResponse:
        return _error_response(
            status_code=422,
            code="INVALID_REQUEST",
            message="Request payload is invalid or missing required fields.",
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
            speech_configured=resolved_settings.speech_configured,
            credentials_verified=False,
        )

    @app.post("/api/detect-board", response_model=BoardDetectionResponse)
    async def post_detect_board(
        image: Annotated[UploadFile, File(...)],
    ) -> BoardDetectionResponse | JSONResponse:
        try:
            raw_bytes = await _read_image_upload(image, resolved_settings.max_upload_bytes)
            if isinstance(raw_bytes, JSONResponse):
                return raw_bytes
        finally:
            await image.close()

        if not detection_gate.try_acquire():
            return _error_response(
                status_code=503,
                code="CAPACITY_EXCEEDED",
                message="Board detection is busy; try again shortly.",
                headers={"Retry-After": "2"},
            )
        try:
            detected = await asyncio.to_thread(
                detect_board_corners,
                raw_bytes,
                max_image_pixels=resolved_settings.max_image_pixels,
            )
        except UnsupportedImageFormatError as exc:
            return _error_response(
                status_code=415,
                code="UNSUPPORTED_IMAGE_FORMAT",
                message=str(exc),
            )
        except ImagePixelLimitError as exc:
            return _error_response(
                status_code=413,
                code="IMAGE_PIXELS_EXCEEDED",
                message=str(exc),
            )
        except CorruptImageError as exc:
            return _error_response(
                status_code=422,
                code="CORRUPT_IMAGE",
                message=str(exc),
            )
        finally:
            detection_gate.release()

        return BoardDetectionResponse(
            detected=detected.detected,
            corners=detected.corners,
            confidence=detected.confidence,
        )

    @app.get("/api/voices", response_model=None)
    async def get_voices(request: Request) -> VoicesResponse | JSONResponse:
        speech_client = cast(
            httpx.AsyncClient | None,
            getattr(request.app.state, "speech_client", None),
        )
        if not resolved_settings.speech_configured or speech_client is None:
            return _error_response(
                status_code=503,
                code="SPEECH_NOT_CONFIGURED",
                message="ElevenLabs text-to-speech is not configured on the backend.",
            )
        try:
            voices = await voice_catalog.get(speech_client, resolved_settings)
        except SpeechError as exc:
            return _speech_error_response(exc)

        configured_id = resolved_settings.elevenlabs_voice_id.strip()
        configured = next((v for v in voices if v.voice_id == configured_id), None)
        default_label = f"Default: {configured.label}" if configured else "Default"
        options = [SpeechVoiceOption(id=DEFAULT_VOICE_KEY, label=default_label[:80])]
        options.extend(
            SpeechVoiceOption(id=v.voice_id, label=v.label)
            for v in voices
            if v.voice_id != configured_id
        )
        return VoicesResponse(voices=options)

    @app.post("/api/speech", response_model=None)
    async def post_speech(
        request: Request,
        payload: SpeechRequest,
    ) -> StreamingResponse | JSONResponse:
        allowed, retry_after = speech_rate_limiter.try_acquire(_client_key(request))
        if not allowed:
            return _error_response(
                status_code=429,
                code="SPEECH_RATE_LIMITED",
                message="Too many speech synthesis requests; slow down briefly.",
                headers={"Retry-After": str(retry_after)},
            )

        speech_client = cast(
            httpx.AsyncClient | None,
            getattr(request.app.state, "speech_client", None),
        )
        if not resolved_settings.speech_configured or speech_client is None:
            return _error_response(
                status_code=503,
                code="SPEECH_NOT_CONFIGURED",
                message="ElevenLabs text-to-speech is not configured on the backend.",
            )

        if not speech_gate.try_acquire():
            return _error_response(
                status_code=503,
                code="CAPACITY_EXCEEDED",
                message="Speech synthesis service is busy; try again shortly.",
                headers={"Retry-After": "2"},
            )

        try:
            if payload.voice != DEFAULT_VOICE_KEY and not await voice_catalog.contains(
                speech_client, resolved_settings, payload.voice
            ):
                speech_gate.release()
                return _error_response(
                    status_code=422,
                    code="SPEECH_VOICE_UNAVAILABLE",
                    message="Selected voice is not available on this ElevenLabs account.",
                )
            opened = await open_elevenlabs_speech_stream(
                speech_client,
                payload.text,
                resolved_settings,
                voice=payload.voice,
            )
        except SpeechError as exc:
            speech_gate.release()
            return _speech_error_response(exc)
        except BaseException:
            speech_gate.release()
            raise

        return SpeechStreamingResponse(opened, speech_gate)

    @app.post("/api/analyze", response_model=AnalysisResponse)
    async def post_analyze(
        request: Request,
        response: Response,
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

            raw_bytes = await _read_image_upload(
                image, resolved_settings.max_upload_bytes, request_id_str
            )
            if isinstance(raw_bytes, JSONResponse):
                return raw_bytes
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

        caller = _client_key(request)
        if not analysis_client_gate.try_acquire(caller):
            return _error_response(
                status_code=429,
                code="CLIENT_CAPACITY_EXCEEDED",
                message="Too many analysis requests in flight from your connection.",
                request_id=request_id_str,
                headers={"Retry-After": "2"},
            )
        if not gate.try_acquire():
            analysis_client_gate.release(caller)
            return _error_response(
                status_code=503,
                code="CAPACITY_EXCEEDED",
                message="Analysis server is busy; try again shortly.",
                request_id=request_id_str,
                headers={"Retry-After": "2"},
            )

        try:
            prepared = await _prepare_snapshot(
                raw_bytes, parsed_metadata, resolved_settings, request_id_str
            )
            if isinstance(prepared, JSONResponse):
                return prepared

            try:
                model_result = await analyze_board_image(
                    client,
                    prepared,
                    parsed_metadata,
                    resolved_settings,
                )
            except AnalyzerError as exc:
                return _model_error_response(exc, request_id_str)

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
            if model_result.incomplete:
                response.headers[PARTIAL_ANALYSIS_HEADER] = "1"
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
            analysis_client_gate.release(caller)

    @app.post("/api/notes", response_model=NotesResponse)
    async def post_notes(
        request: Request,
        image: Annotated[UploadFile, File(...)],
        metadata: Annotated[str, Form(...)],
    ) -> NotesResponse | JSONResponse:
        """Incremental Permanotes update; fully independent of /api/analyze state and gate."""
        started_ns = time.perf_counter_ns()
        request_id_str: str | None = None

        try:
            if len(metadata.encode("utf-8")) > MAX_NOTES_METADATA_BYTES:
                return _error_response(
                    status_code=413,
                    code="METADATA_TOO_LARGE",
                    message="Notes metadata exceeds maximum allowed size.",
                )
            request_id_str = _extract_request_id_best_effort(metadata)
            try:
                parsed_metadata = NotesMetadata.model_validate_json(metadata)
            except ValidationError:
                return _error_response(
                    status_code=422,
                    code="INVALID_METADATA",
                    message="Invalid notes metadata payload.",
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

            raw_bytes = await _read_image_upload(
                image, resolved_settings.max_upload_bytes, request_id_str
            )
            if isinstance(raw_bytes, JSONResponse):
                return raw_bytes
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

        caller = _client_key(request)
        if not notes_client_gate.try_acquire(caller):
            return _error_response(
                status_code=429,
                code="CLIENT_CAPACITY_EXCEEDED",
                message="Too many notes requests in flight from your connection.",
                request_id=request_id_str,
                headers={"Retry-After": "2"},
            )
        if not notes_gate.try_acquire():
            notes_client_gate.release(caller)
            return _error_response(
                status_code=503,
                code="CAPACITY_EXCEEDED",
                message="Notes service is busy; try again shortly.",
                request_id=request_id_str,
                headers={"Retry-After": "2"},
            )

        try:
            prepared = await _prepare_snapshot(
                raw_bytes, parsed_metadata, resolved_settings, request_id_str
            )
            if isinstance(prepared, JSONResponse):
                return prepared

            try:
                result = await build_notes_update(
                    client, prepared, parsed_metadata, resolved_settings
                )
            except AnalyzerError as exc:
                return _model_error_response(exc, request_id_str)

            updates = []
            for update in result.updates:
                source_box: list[int] | None = None
                if update.has_figure and update.figure_box_2d is not None:
                    try:
                        source_box = project_box_to_source(update.figure_box_2d, prepared)
                    except ProjectionError:
                        source_box = None  # fall back to the whole frame client-side
                updates.append(update.model_copy(update={"figure_box_2d": source_box}))

            elapsed_ms = max(0, (time.perf_counter_ns() - started_ns) // 1_000_000)
            return NotesResponse(
                request_id=request_id_str,
                lecture_title=result.lecture_title,
                updates=updates,
                latency_ms=elapsed_ms,
            )
        finally:
            notes_gate.release()
            notes_client_gate.release(caller)

    return app


app = create_app()
