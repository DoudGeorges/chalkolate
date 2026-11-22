"""Opt-in owner-only request debug logging (see docs/admin.md).

DELIBERATE EXCEPTION to the privacy invariants: when enabled this module stores request
metadata, uploaded frames, spoken text and model output so the owner can debug the app. It is
inert unless ``ADMIN_DEBUG_LOGGING=1`` and ``ADMIN_TOKEN`` are both set. Provider API keys and
the admin token are never stored (headers are allowlisted; secret-looking keys and configured
secret values are scrubbed from every stored payload).
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import hmac
import io
import json
import logging
import re
import time
from collections.abc import Callable, Iterable, Mapping
from dataclasses import dataclass
from pathlib import Path
from threading import Lock
from typing import Any, Protocol
from uuid import uuid4

import httpx
from fastapi import APIRouter, Request
from fastapi.responses import JSONResponse, Response
from PIL import Image
from starlette.datastructures import FormData, UploadFile
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from config import Settings

logger = logging.getLogger("chalkolate.admin")

TRACKED_PATHS = frozenset(
    {"/api/analyze", "/api/detect-board", "/api/notes", "/api/speech", "/api/health", "/api/voices"}
)
SESSION_COOKIE = "chalkolate_admin"
SESSION_TTL_SECONDS = 12 * 3600
SESSION_HEADER = "x-chalkolate-session"
MAX_RESPONSE_CAPTURE_BYTES = 256 * 1024
MAX_TEXT_FIELD_CHARS = 20_000
THUMB_LONG_EDGE = 256
ALLOWED_HEADERS = frozenset(
    {"content-type", "content-length", "user-agent", "referer", "retry-after", "accept"}
)
_SECRET_KEY_RE = re.compile(
    r"(api[-_]?key|token|secret|authorization|cookie|password|x-goog|xi-api)", re.IGNORECASE
)
REDACTED = "[redacted]"


# --------------------------------------------------------------------------- redaction


def redact(value: Any, secrets: Iterable[str] = (), _depth: int = 0) -> Any:
    """Recursively scrub secret-looking keys and any occurrence of configured secret values."""
    needles = [s for s in secrets if s and len(s) >= 6]
    if _depth > 12:
        return REDACTED
    if isinstance(value, Mapping):
        return {
            str(k): REDACTED if _SECRET_KEY_RE.search(str(k)) else redact(v, needles, _depth + 1)
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact(v, needles, _depth + 1) for v in value]
    if isinstance(value, str):
        text = value
        for needle in needles:
            text = text.replace(needle, REDACTED)
        return text if len(text) <= MAX_TEXT_FIELD_CHARS else text[:MAX_TEXT_FIELD_CHARS] + "…"
    return value


def safe_headers(headers: Mapping[str, str]) -> dict[str, str]:
    """Allowlist headers (+ x-chalkolate-*); cookies/authorization are never copied."""
    out: dict[str, str] = {}
    for key, val in headers.items():
        lk = key.lower()
        if lk in ALLOWED_HEADERS or lk.startswith("x-chalkolate-"):
            out[lk] = val[:300]
    return out


# --------------------------------------------------------------------------- auth


def _sign(token: str, expires: int) -> str:
    return hmac.new(token.encode(), f"admin-session|{expires}".encode(), hashlib.sha256).hexdigest()


def token_matches(candidate: str, token: str) -> bool:
    """Constant-time token comparison (digests make lengths equal and hide length)."""
    try:
        a = hashlib.sha256(candidate.encode()).digest()
    except UnicodeEncodeError:
        return False
    b = hashlib.sha256(token.encode()).digest()
    return hmac.compare_digest(a, b)


def make_session_cookie(token: str, now: float | None = None) -> str:
    expires = int((time.time() if now is None else now) + SESSION_TTL_SECONDS)
    return f"v1.{expires}.{_sign(token, expires)}"


def verify_session_cookie(cookie: str | None, token: str, now: float | None = None) -> bool:
    if not cookie:
        return False
    match = re.fullmatch(r"v1\.([0-9]{1,12})\.([a-f0-9]{64})", cookie)
    if match is None:
        return False
    expires = int(match[1])
    if expires <= (time.time() if now is None else now):
        return False
    return hmac.compare_digest(match[2], _sign(token, expires))


def is_authorized(request: Request, token: str) -> bool:
    if verify_session_cookie(request.cookies.get(SESSION_COOKIE), token):
        return True
    auth = request.headers.get("authorization", "")
    return auth.lower().startswith("bearer ") and token_matches(auth[7:].strip(), token)


# --------------------------------------------------------------------------- storage


@dataclass(frozen=True)
class StoredImages:
    full: bytes | None = None
    thumb: bytes | None = None
    model: bytes | None = None


class LogStore(Protocol):
    async def put(
        self,
        entry_id: str,
        ts_ms: int,
        summary: dict[str, Any],
        detail: dict[str, Any],
        images: StoredImages,
    ) -> None: ...
    async def list(self, limit: int) -> list[dict[str, Any]]: ...
    async def get(self, entry_id: str) -> dict[str, Any] | None: ...
    async def image(self, entry_id: str, kind: str) -> bytes | None: ...
    async def clear(self) -> None: ...
    async def aclose(self) -> None: ...


_ID_RE = re.compile(r"^[0-9a-f]{32}$")
_KINDS = {"full": "i", "thumb": "t", "model": "m"}


def valid_entry_id(entry_id: str) -> bool:
    return _ID_RE.fullmatch(entry_id) is not None


class RedisLogStore:
    """Upstash / Vercel KV REST store: bounded by TTL, max entries and per-image size caps."""

    def __init__(self, url: str, token: str, *, ttl: int, max_entries: int) -> None:
        self._url = url.rstrip("/")
        self._token = token
        self._ttl = ttl
        self._max = max_entries
        self._client = httpx.AsyncClient(timeout=5.0)
        self._idx = "chalkolate:admin:idx"

    async def _pipe(self, commands: list[list[Any]]) -> list[Any]:
        resp = await self._client.post(
            f"{self._url}/pipeline",
            headers={"Authorization": f"Bearer {self._token}"},
            json=commands,
        )
        resp.raise_for_status()
        results = resp.json()
        if len(results) != len(commands) or any("error" in item for item in results):
            raise RuntimeError("Admin storage command failed.")
        return [item.get("result") for item in results]

    def _k(self, prefix: str, entry_id: str) -> str:
        return f"chalkolate:admin:{prefix}:{entry_id}"

    async def put(
        self,
        entry_id: str,
        ts_ms: int,
        summary: dict[str, Any],
        detail: dict[str, Any],
        images: StoredImages,
    ) -> None:
        cmds: list[list[Any]] = [
            ["SET", self._k("s", entry_id), json.dumps(summary), "EX", self._ttl],
            ["SET", self._k("e", entry_id), json.dumps(detail), "EX", self._ttl],
        ]
        for kind, data in (("full", images.full), ("thumb", images.thumb), ("model", images.model)):
            if data:
                cmds.append(
                    [
                        "SET",
                        self._k(_KINDS[kind], entry_id),
                        base64.b64encode(data).decode(),
                        "EX",
                        self._ttl,
                    ]
                )
        cmds += [
            ["ZADD", self._idx, ts_ms, entry_id],
            ["ZREMRANGEBYSCORE", self._idx, "-inf", ts_ms - self._ttl * 1000],
            ["EXPIRE", self._idx, self._ttl],
            ["ZRANGE", self._idx, 0, -self._max - 1],
        ]
        stale = (await self._pipe(cmds))[-1]
        if stale:
            await self._delete(stale)

    async def _delete(self, ids: list[str]) -> None:
        keys = [self._k(p, i) for i in ids for p in ("s", "e", "i", "t", "m")]
        await self._pipe([["DEL", *keys], ["ZREM", self._idx, *ids]])

    async def list(self, limit: int) -> list[dict[str, Any]]:
        ids = (await self._pipe([["ZREVRANGE", self._idx, 0, limit - 1]]))[0] or []
        if not ids:
            return []
        rows = (await self._pipe([["MGET", *[self._k("s", i) for i in ids]]]))[0] or []
        return [json.loads(r) for r in rows if isinstance(r, str)]

    async def get(self, entry_id: str) -> dict[str, Any] | None:
        res = await self._pipe([["GET", self._k("s", entry_id)], ["GET", self._k("e", entry_id)]])
        if not isinstance(res[0], str) or not isinstance(res[1], str):
            return None
        return {"summary": json.loads(res[0]), "detail": json.loads(res[1])}

    async def image(self, entry_id: str, kind: str) -> bytes | None:
        res = (await self._pipe([["GET", self._k(_KINDS[kind], entry_id)]]))[0]
        return base64.b64decode(res) if isinstance(res, str) else None

    async def clear(self) -> None:
        ids = (await self._pipe([["ZRANGE", self._idx, 0, -1]]))[0] or []
        if ids:
            await self._delete(ids)

    async def aclose(self) -> None:
        await self._client.aclose()


class FileLogStore:
    """Local-dev store under a gitignored directory (never used on Vercel)."""

    def __init__(self, root: Path, *, ttl: int, max_entries: int) -> None:
        self._root = root
        self._ttl = ttl
        self._max = max_entries
        self._lock = Lock()
        root.mkdir(parents=True, exist_ok=True)

    def _entries(self) -> list[Path]:
        return sorted(self._root.glob("*.json"), reverse=True)

    def _active_entries(self) -> list[Path]:
        cutoff = (time.time() - self._ttl) * 1000
        active: list[Path] = []
        for path in self._entries():
            timestamp, _, entry_id = path.stem.partition("-")
            if len(timestamp) != 13 or not timestamp.isascii() or not timestamp.isdigit():
                continue
            if not valid_entry_id(entry_id):
                continue
            if len(active) >= self._max or int(timestamp) <= cutoff:
                self._remove(path)
            else:
                active.append(path)
        return active

    def _find(self, entry_id: str) -> Path | None:
        return next((path for path in self._active_entries() if path.stem.endswith(entry_id)), None)

    def _put_sync(
        self,
        entry_id: str,
        ts_ms: int,
        summary: dict[str, Any],
        detail: dict[str, Any],
        images: StoredImages,
    ) -> None:
        base = self._root / f"{ts_ms:013d}-{entry_id}"
        with self._lock:
            try:
                for kind in _KINDS:
                    data = getattr(images, kind)
                    if data:
                        base.with_suffix(f".{kind}.jpg").write_bytes(data)
                base.with_suffix(".json").write_text(
                    json.dumps({"summary": summary, "detail": detail}), encoding="utf-8"
                )
            except OSError:
                self._remove(base.with_suffix(".json"))
                raise
            self._active_entries()

    def _remove(self, path: Path) -> None:
        stem = path.name.removesuffix(".json")
        for p in self._root.glob(f"{stem}.*"):
            with contextlib.suppress(OSError):
                p.unlink()

    async def put(
        self,
        entry_id: str,
        ts_ms: int,
        summary: dict[str, Any],
        detail: dict[str, Any],
        images: StoredImages,
    ) -> None:
        await asyncio.to_thread(self._put_sync, entry_id, ts_ms, summary, detail, images)

    def _list_sync(self, limit: int) -> list[dict[str, Any]]:
        with self._lock:
            return [
                json.loads(path.read_text(encoding="utf-8"))["summary"]
                for path in self._active_entries()[:limit]
            ]

    async def list(self, limit: int) -> list[dict[str, Any]]:
        return await asyncio.to_thread(self._list_sync, limit)

    def _get_sync(self, entry_id: str) -> dict[str, Any] | None:
        with self._lock:
            path = self._find(entry_id)
            return json.loads(path.read_text(encoding="utf-8")) if path else None

    async def get(self, entry_id: str) -> dict[str, Any] | None:
        return await asyncio.to_thread(self._get_sync, entry_id)

    def _image_sync(self, entry_id: str, kind: str) -> bytes | None:
        with self._lock:
            path = self._find(entry_id)
            if not path:
                return None
            img = path.with_suffix(f".{kind}.jpg")
            return img.read_bytes() if img.exists() else None

    async def image(self, entry_id: str, kind: str) -> bytes | None:
        return await asyncio.to_thread(self._image_sync, entry_id, kind)

    def _clear_sync(self) -> None:
        with self._lock:
            for path in self._active_entries():
                self._remove(path)

    async def clear(self) -> None:
        await asyncio.to_thread(self._clear_sync)

    async def aclose(self) -> None:
        return None


def build_store(settings: Settings, *, on_vercel: bool, root: Path) -> LogStore | None:
    """Pick a real store, or None (logging stays inert) when no safe store exists."""
    if not settings.admin_enabled:
        return None
    if settings.admin_redis_url and settings.admin_redis_token:
        return RedisLogStore(
            settings.admin_redis_url,
            settings.admin_redis_token,
            ttl=settings.admin_log_ttl_seconds,
            max_entries=settings.admin_log_max_entries,
        )
    if on_vercel:
        logger.warning(
            "ADMIN_DEBUG_LOGGING is on but no UPSTASH_REDIS_REST_URL/TOKEN (or KV_REST_API_*) "
            "is configured; serverless instances cannot share memory, so logging is disabled."
        )
        return None
    return FileLogStore(
        root, ttl=settings.admin_log_ttl_seconds, max_entries=settings.admin_log_max_entries
    )


# --------------------------------------------------------------------------- images


def _jpeg(img: Image.Image, long_edge: int, quality: int) -> bytes:
    work = img.convert("RGB")
    work.thumbnail((long_edge, long_edge))
    buf = io.BytesIO()
    work.save(buf, format="JPEG", quality=quality)
    return buf.getvalue()


def fit_image(
    raw: bytes, max_bytes: int, max_pixels: int
) -> tuple[bytes | None, bytes | None, tuple[int, int] | None]:
    """Return (full-size-capped bytes, thumbnail, original size); full is re-encoded if too big."""
    try:
        with Image.open(io.BytesIO(raw)) as img:
            size = img.size
            if size[0] * size[1] > max_pixels:
                return None, None, size
            img.load()
            thumb = _jpeg(img, THUMB_LONG_EDGE, 70)
            if img.format == "JPEG" and len(raw) <= max_bytes:
                return raw, thumb, size
            edge = 1400
            while edge >= 400:
                data = _jpeg(img, edge, 70)
                if len(data) <= max_bytes:
                    return data, thumb, size
                edge = int(edge * 0.7)
            return None, thumb, size
    except Exception:
        return None, None, None


# --------------------------------------------------------------------------- middleware


def _parse_json(raw: bytes) -> Any:
    try:
        return json.loads(raw)
    except (ValueError, RecursionError):
        return None


class AdminLogMiddleware:
    """Teeing ASGI middleware: records tracked API calls into the store after they finish."""

    def __init__(
        self, app: ASGIApp, *, store: LogStore, settings: Settings, max_request_bytes: int
    ) -> None:
        self.app = app
        self.store = store
        self.settings = settings
        self.max_request_bytes = max_request_bytes
        self._secrets = [
            settings.gemini_api_key,
            settings.elevenlabs_api_key,
            settings.admin_token,
            settings.admin_redis_token,
        ]

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        path = scope.get("path", "")
        if scope["type"] != "http" or path not in TRACKED_PATHS or scope.get("method") == "OPTIONS":
            await self.app(scope, receive, send)
            return

        started = time.perf_counter()
        received = bytearray()
        truncated = False
        status = 0
        resp_headers: dict[str, str] = {}
        resp_chunks = bytearray()
        resp_bytes = 0

        async def tee_receive() -> Message:
            nonlocal truncated
            message = await receive()
            if message.get("type") == "http.request":
                chunk = message.get("body", b"")
                if len(received) + len(chunk) <= self.max_request_bytes:
                    received.extend(chunk)
                else:
                    truncated = True
            return message

        async def tee_send(message: Message) -> None:
            nonlocal status, resp_bytes
            if message["type"] == "http.response.start":
                status = int(message["status"])
                resp_headers.update(
                    {k.decode().lower(): v.decode("latin-1") for k, v in message.get("headers", [])}
                )
            elif message["type"] == "http.response.body":
                body = message.get("body", b"")
                resp_bytes += len(body)
                if (
                    resp_headers.get("content-type", "").startswith("application/json")
                    and len(resp_chunks) + len(body) <= MAX_RESPONSE_CAPTURE_BYTES
                ):
                    resp_chunks.extend(body)
            await send(message)

        crashed: str | None = None
        try:
            await self.app(scope, tee_receive, tee_send)
        except BaseException as exc:
            crashed = type(exc).__name__
            raise
        finally:
            latency_ms = int((time.perf_counter() - started) * 1000)
            try:
                await self._record(
                    scope,
                    bytes(received),
                    truncated,
                    status,
                    resp_headers,
                    bytes(resp_chunks),
                    resp_bytes,
                    latency_ms,
                    crashed,
                )
            except Exception as exc:  # logging must never break the request
                logger.warning("admin log write failed (%s)", type(exc).__name__)

    async def _record(
        self,
        scope: Scope,
        body: bytes,
        truncated: bool,
        status: int,
        resp_headers: dict[str, str],
        resp_body: bytes,
        resp_bytes: int,
        latency_ms: int,
        crashed: str | None,
    ) -> None:
        req_headers = {k.decode().lower(): v.decode("latin-1") for k, v in scope.get("headers", [])}
        path = scope["path"]
        ctype = req_headers.get("content-type", "")
        metadata: Any = None
        speech_body: Any = None
        images = StoredImages()
        image_info: dict[str, Any] | None = None

        if "multipart/form-data" in ctype and body and not truncated:
            form = await self._replay_form(scope, body)
            if form is not None:
                try:
                    raw_meta = form.get("metadata")
                    if isinstance(raw_meta, str):
                        metadata = _parse_json(raw_meta.encode()) or raw_meta[:MAX_TEXT_FIELD_CHARS]
                    upload = form.get("image")
                    if isinstance(upload, UploadFile):
                        raw = await upload.read()
                        full, thumb, size = await asyncio.to_thread(
                            fit_image,
                            raw,
                            self.settings.admin_log_max_image_bytes,
                            self.settings.max_image_pixels,
                        )
                        images = StoredImages(full=full, thumb=thumb)
                        image_info = {
                            "bytes": len(raw),
                            "width": size[0] if size else None,
                            "height": size[1] if size else None,
                            "stored": full is not None,
                            "content_type": upload.content_type,
                        }
                finally:
                    await form.close()
        elif "json" in ctype and body:
            speech_body = _parse_json(body)

        parsed_resp = _parse_json(resp_body) if resp_body else None
        request_id = None
        for src in (metadata, parsed_resp):
            if isinstance(src, dict) and isinstance(src.get("request_id"), str):
                request_id = src["request_id"]
                break
        err_code = parsed_resp.get("code") if isinstance(parsed_resp, dict) else None
        err_msg = parsed_resp.get("message") if isinstance(parsed_resp, dict) else None
        model_image = scope.get("state", {}).get("admin_model_image")
        if isinstance(model_image, bytes):
            if len(model_image) > self.settings.admin_log_max_image_bytes:
                model_image, _, _ = await asyncio.to_thread(
                    fit_image,
                    model_image,
                    self.settings.admin_log_max_image_bytes,
                    self.settings.max_image_pixels,
                )
            images = StoredImages(images.full, images.thumb, model_image)

        entry_id = uuid4().hex
        now_ms = int(time.time() * 1000)
        client = (
            req_headers.get("x-forwarded-for", "").split(",")[0].strip()
            or (scope.get("client") or ("unknown",))[0]
        )
        findings = parsed_resp.get("errors") if isinstance(parsed_resp, dict) else None
        search_bits: list[Any] = [
            path,
            request_id,
            err_code,
            err_msg,
            status,
            req_headers.get(SESSION_HEADER),
        ]
        if isinstance(findings, list):
            search_bits += [
                f.get(field)
                for f in findings
                if isinstance(f, dict)
                for field in ("detected_text", "correction_text", "explanation")
            ]
        if isinstance(speech_body, dict):
            search_bits.append(speech_body.get("text"))
        if isinstance(parsed_resp, dict):
            search_bits += [parsed_resp.get("board_summary"), parsed_resp.get("lecture_title")]
        search = " ".join(str(b) for b in search_bits if b not in (None, "")).lower()[:2000]

        summary = {
            "id": entry_id,
            "ts": now_ms,
            "route": path,
            "method": scope.get("method"),
            "status": status or (500 if crashed else 0),
            "latency_ms": latency_ms,
            "request_id": request_id,
            "session_id": (req_headers.get(SESSION_HEADER) or "")[:64],
            "client": client[:64],
            "error_code": err_code,
            "findings": len(findings) if isinstance(findings, list) else None,
            "has_image": images.thumb is not None,
            "image_bytes": (image_info or {}).get("bytes"),
            "response_bytes": resp_bytes,
            "search": search,
        }
        settings = self.settings
        detail = {
            "request": {
                "headers": safe_headers(req_headers),
                "query": scope.get("query_string", b"").decode(),
                "body_bytes": len(body),
                "body_truncated": truncated,
                "metadata": metadata,
                "json": speech_body,
                "image": image_info,
            },
            "response": {
                "status": status,
                "headers": safe_headers(resp_headers),
                "bytes": resp_bytes,
                "body": parsed_resp,
                "error_code": err_code,
                "error_message": err_msg,
                "crashed": crashed,
            },
            "settings": {
                "gemini_model": settings.gemini_model,
                "thinking_level": settings.gemini_thinking_level,
                "confidence_threshold": settings.confidence_threshold,
                "analysis_timeout_s": settings.analysis_timeout_seconds,
                "notes_timeout_s": settings.notes_timeout_seconds,
                "max_model_long_edge": settings.max_model_long_edge,
                "speech_model": settings.elevenlabs_model_id,
            },
            "timing": {
                "total_ms": latency_ms,
                "reported_latency_ms": parsed_resp.get("latency_ms")
                if isinstance(parsed_resp, dict)
                else None,
            },
            "trigger": "auto" if path in ("/api/analyze", "/api/notes") else None,
            "has_model_image": images.model is not None,
        }
        await self.store.put(
            entry_id, now_ms, redact(summary, self._secrets), redact(detail, self._secrets), images
        )

    async def _replay_form(self, scope: Scope, body: bytes) -> FormData | None:
        sent = False

        async def replay() -> Message:
            nonlocal sent
            if sent:
                return {"type": "http.disconnect"}
            sent = True
            return {"type": "http.request", "body": body, "more_body": False}

        try:
            return await Request({**scope, "type": "http"}, replay).form()
        except Exception:
            return None


# --------------------------------------------------------------------------- router

_NO_STORE = {"Cache-Control": "no-store, private", "X-Robots-Tag": "noindex, nofollow"}


def _json(status: int, payload: Any) -> JSONResponse:
    return JSONResponse(status_code=status, content=payload, headers=_NO_STORE)


def build_admin_router(
    settings: Settings,
    store: LogStore | None,
    *,
    rate_limiter: Any,
    client_key: Callable[[Request], str],
) -> APIRouter:
    router = APIRouter(prefix="/api/admin")
    token = settings.admin_token

    def deny() -> JSONResponse:
        return _json(401, {"code": "UNAUTHORIZED", "message": "Admin authentication required."})

    @router.post("/login")
    async def login(request: Request) -> Response:
        allowed, retry_after = rate_limiter.try_acquire(client_key(request))
        if not allowed:
            resp = _json(429, {"code": "RATE_LIMITED", "message": "Too many attempts."})
            resp.headers["Retry-After"] = str(retry_after)
            return resp
        try:
            payload = await request.json()
        except (ValueError, RecursionError):
            payload = None
        candidate = payload.get("token") if isinstance(payload, dict) else None
        if not isinstance(candidate, str) or not token_matches(candidate, token):
            return _json(401, {"code": "UNAUTHORIZED", "message": "Invalid token."})
        resp = _json(200, {"ok": True})
        secure = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
        resp.set_cookie(
            SESSION_COOKIE,
            make_session_cookie(token),
            max_age=SESSION_TTL_SECONDS,
            httponly=True,
            secure=secure,
            samesite="strict",
            path="/",
        )
        return resp

    @router.post("/logout")
    async def logout() -> Response:
        resp = _json(200, {"ok": True})
        resp.delete_cookie(SESSION_COOKIE, path="/")
        return resp

    @router.get("/session")
    async def session(request: Request) -> Response:
        if not is_authorized(request, token):
            return deny()
        return _json(
            200,
            {
                "authenticated": True,
                "storage": type(store).__name__ if store else None,
                "retention": {
                    "ttl_seconds": settings.admin_log_ttl_seconds,
                    "max_entries": settings.admin_log_max_entries,
                    "max_image_bytes": settings.admin_log_max_image_bytes,
                },
            },
        )

    @router.get("/logs")
    async def list_logs(request: Request, limit: int = 200) -> Response:
        if not is_authorized(request, token):
            return deny()
        if store is None:
            return _json(200, {"entries": [], "storage": None})
        entries = await store.list(max(1, min(limit, settings.admin_log_max_entries)))
        return _json(200, {"entries": entries, "storage": type(store).__name__})

    @router.get("/logs/{entry_id}")
    async def get_log(request: Request, entry_id: str) -> Response:
        if not is_authorized(request, token):
            return deny()
        if store is None or not valid_entry_id(entry_id):
            return _json(404, {"code": "NOT_FOUND", "message": "Not found."})
        found = await store.get(entry_id)
        if found is None:
            return _json(404, {"code": "NOT_FOUND", "message": "Not found."})
        return _json(200, found)

    @router.get("/logs/{entry_id}/image")
    async def get_image(request: Request, entry_id: str, size: str = "thumb") -> Response:
        if not is_authorized(request, token):
            return deny()
        if store is None or not valid_entry_id(entry_id) or size not in _KINDS:
            return _json(404, {"code": "NOT_FOUND", "message": "Not found."})
        data = await store.image(entry_id, size)
        if data is None:
            return _json(404, {"code": "NOT_FOUND", "message": "Not found."})
        return Response(data, media_type="image/jpeg", headers=_NO_STORE)

    @router.delete("/logs")
    async def clear_logs(request: Request) -> Response:
        if not is_authorized(request, token):
            return deny()
        if store is not None:
            await store.clear()
        return _json(200, {"ok": True})

    return router
