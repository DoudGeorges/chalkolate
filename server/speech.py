"""ElevenLabs v4 Turbo streaming text-to-speech client, text normalizer, and rate limiter."""

from __future__ import annotations

import asyncio
import json
import logging
import math
import re
import time
from collections import deque
from collections.abc import AsyncIterator, Callable, Mapping
from dataclasses import dataclass

import httpx

from config import Settings

logger = logging.getLogger("chalkolate.speech")

ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1"
ELEVENLABS_OUTPUT_FORMAT = "mp3_44100_128"
MAX_PREPARED_SPEECH_CHARS = 300
VOICE_ID_PATTERN = re.compile(r"^[A-Za-z0-9_-]{1,128}$")

DEFAULT_VOICE_KEY = "default"
VOICE_CATALOG_TTL_SECONDS = 600.0
MAX_CATALOG_VOICES = 200
MAX_VOICE_LABEL_CHARS = 80

_CONTROL_CHARS_RE = re.compile(r"[\x00-\x1f\x7f]")
_BRACKETS_RE = re.compile(r"[\[\]]")
_MS2_RE = re.compile(r"(?<![A-Za-z])m\s*/\s*s(?:\^2|²)(?![A-Za-z0-9])")
_MS_RE = re.compile(r"(?<![A-Za-z])m\s*/\s*s(?![A-Za-z0-9])")
_NM_RE = re.compile(r"(?<![A-Za-z])N\s*/\s*m(?![A-Za-z0-9])")
_SQ_RE = re.compile(r"(?:\^2|²)")
_CU_RE = re.compile(r"(?:\^3|³)")
_WS_RE = re.compile(r"\s+")
_RETRY_AFTER_RE = re.compile(r"^\d+$")


class SpeechError(Exception):
    """Base error raised during speech synthesis setup or upstream streaming."""


class SpeechConfigError(SpeechError):
    """Raised when ElevenLabs speech synthesis is unconfigured or invalid."""


class SpeechTextError(SpeechError):
    """Raised when the provided text has no speakable characters."""


class SpeechAuthError(SpeechError):
    """Raised when ElevenLabs rejects the backend API key or voice permissions."""


class SpeechQuotaError(SpeechError):
    """Raised when ElevenLabs rejects synthesis due to exhausted credits/quota."""

    def __init__(self, message: str, *, retry_after_s: int | None = None) -> None:
        super().__init__(message)
        self.retry_after_s = retry_after_s


class SpeechPlanError(SpeechError):
    """Raised when the configured voice requires a higher ElevenLabs plan tier."""


class SpeechRateLimitError(SpeechError):
    """Raised when ElevenLabs rate-limits or concurrency-limits the request."""

    def __init__(self, message: str, *, retry_after_s: int | None = None) -> None:
        super().__init__(message)
        self.retry_after_s = retry_after_s


class SpeechTimeoutError(SpeechError):
    """Raised when the upstream ElevenLabs request times out."""


class SpeechUnavailableError(SpeechError):
    """Raised when ElevenLabs is temporarily unreachable or overloaded."""

    def __init__(self, message: str, *, retry_after_s: int | None = None) -> None:
        super().__init__(message)
        self.retry_after_s = retry_after_s


class SpeechProviderError(SpeechError):
    """Raised for unexpected non-success responses from ElevenLabs."""


def resolve_voice_id(settings: Settings, voice: str = DEFAULT_VOICE_KEY) -> str:
    """Map 'default' to ELEVENLABS_VOICE_ID, otherwise validate the requested voice ID."""
    if voice == DEFAULT_VOICE_KEY:
        return validate_voice_id(settings.elevenlabs_voice_id)
    return validate_voice_id(voice)


def validate_voice_id(voice_id: str) -> str:
    """Validate and return an ElevenLabs voice ID safe for URL path interpolation."""
    cleaned = voice_id.strip()
    if not VOICE_ID_PATTERN.fullmatch(cleaned):
        raise SpeechConfigError("Configured ELEVENLABS_VOICE_ID is invalid.")
    return cleaned


def prepare_spoken_text(raw: str) -> str:
    """Sanitize and normalize math/physics shorthand into natural TTS prose."""
    cleaned = _CONTROL_CHARS_RE.sub(" ", raw)
    # Strip square brackets so eleven_v4_turbo never interprets math intervals as audio tags.
    cleaned = _BRACKETS_RE.sub(" ", cleaned)

    cleaned = _MS2_RE.sub(" meters per second squared ", cleaned)
    cleaned = _MS_RE.sub(" meters per second ", cleaned)
    cleaned = _NM_RE.sub(" Newtons per meter ", cleaned)
    cleaned = _SQ_RE.sub(" squared ", cleaned)
    cleaned = _CU_RE.sub(" cubed ", cleaned)

    replacements = (
        ("\u00d7", " times "),
        ("\u22c5", " times "),
        ("≠", " is not equal to "),
        ("≈", " is approximately "),
        ("±", " plus or minus "),
        ("\u2212", " minus "),
        ("√", " square root of "),
        ("∫", " integral of "),
        ("π", " pi "),
        ("θ", " theta "),
        ("Δ", " delta "),
    )
    for symbol, spoken in replacements:
        cleaned = cleaned.replace(symbol, spoken)

    normalized = _WS_RE.sub(" ", cleaned).strip()
    if not normalized:
        raise ValueError("Spoken text must not be empty.")
    if len(normalized) > MAX_PREPARED_SPEECH_CHARS:
        normalized = normalized[:MAX_PREPARED_SPEECH_CHARS].rstrip()
    return normalized


class SlidingWindowRateLimiter:
    """Lightweight per-client sliding-window request limiter without background timers."""

    def __init__(self, max_requests: int, window_seconds: float = 60.0) -> None:
        self._max_requests = max_requests
        self._window_seconds = window_seconds
        self._buckets: dict[str, deque[float]] = {}

    def try_acquire(self, key: str) -> tuple[bool, int]:
        now = time.monotonic()
        cutoff = now - self._window_seconds

        if len(self._buckets) > 1000:
            stale_keys = [
                bucket_key
                for bucket_key, stamps in self._buckets.items()
                if not stamps or stamps[-1] <= cutoff
            ]
            for stale_key in stale_keys:
                del self._buckets[stale_key]

        stamps = self._buckets.setdefault(key, deque())
        while stamps and stamps[0] <= cutoff:
            stamps.popleft()

        if len(stamps) >= self._max_requests:
            retry_after = max(1, math.ceil(stamps[0] + self._window_seconds - now))
            return False, retry_after

        stamps.append(now)
        return True, 0


@dataclass
class OpenedSpeechStream:
    """Open upstream ElevenLabs HTTP audio stream with guaranteed cleanup."""

    response: httpx.Response
    media_type: str = "audio/mpeg"

    async def iter_chunks(self) -> AsyncIterator[bytes]:
        async for chunk in self.response.aiter_bytes():
            if chunk:
                yield chunk

    async def aclose(self) -> None:
        await self.response.aclose()


def _parse_retry_after(headers: Mapping[str, str]) -> int | None:
    raw = headers.get("retry-after") or headers.get("Retry-After")
    if isinstance(raw, str):
        trimmed = raw.strip()
        if _RETRY_AFTER_RE.fullmatch(trimmed):
            return max(1, int(trimmed))
    return None


def _extract_error_tags(body_bytes: bytes) -> tuple[str | None, str | None]:
    if not body_bytes:
        return None, None
    try:
        parsed = json.loads(body_bytes.decode("utf-8", errors="ignore"))
    except (ValueError, RecursionError):
        return None, None
    if not isinstance(parsed, dict):
        return None, None
    detail = parsed.get("detail")
    if isinstance(detail, dict):
        raw_code = detail.get("code")
        raw_status = detail.get("status")
        code = raw_code.strip().lower() if isinstance(raw_code, str) and raw_code.strip() else None
        status = (
            raw_status.strip().lower()
            if isinstance(raw_status, str) and raw_status.strip()
            else None
        )
        return code, status
    return None, None


async def _raise_upstream_error(response: httpx.Response, operation: str) -> None:
    """Close a failed ElevenLabs response and raise a typed error without leaking its body."""
    status_code = response.status_code
    retry_after_s = _parse_retry_after(response.headers)
    body = bytearray()
    try:
        async for chunk in response.aiter_bytes():
            body.extend(chunk[: 4096 - len(body)])
            if len(body) >= 4096:
                break
    except httpx.HTTPError:
        pass  # The HTTP status still provides enough information to classify the failure.
    finally:
        await response.aclose()

    detail_code, detail_status = _extract_error_tags(bytes(body))
    logger.warning("ElevenLabs %s upstream failure status=%s", operation, status_code)

    if status_code in (401, 403):
        raise SpeechAuthError("ElevenLabs credentials or voice permissions were rejected.")
    if detail_code == "quota_exceeded" or detail_status == "quota_exceeded":
        raise SpeechQuotaError(
            "ElevenLabs character quota exceeded.",
            retry_after_s=retry_after_s or 60,
        )
    if status_code == 402 or "paid_plan_required" in (detail_code, detail_status):
        raise SpeechPlanError(
            "Configured ElevenLabs voice requires a paid plan. Choose another voice or upgrade."
        )
    if status_code == 429:
        raise SpeechRateLimitError(
            "ElevenLabs speech rate limit reached.",
            retry_after_s=retry_after_s or 10,
        )
    if status_code in (408, 504):
        raise SpeechTimeoutError("ElevenLabs request timed out upstream.")
    if status_code == 503:
        raise SpeechUnavailableError(
            "ElevenLabs speech service is temporarily unavailable.",
            retry_after_s=retry_after_s or 5,
        )
    raise SpeechProviderError("Speech provider returned an unexpected error.")


@dataclass(frozen=True)
class ElevenLabsVoice:
    """One voice available to the configured ElevenLabs account."""

    voice_id: str
    label: str


def _voice_label(raw: Mapping[str, object]) -> str:
    name = raw.get("name")
    base = name.strip() if isinstance(name, str) and name.strip() else "Unnamed voice"
    details: list[str] = []
    labels = raw.get("labels")
    if isinstance(labels, Mapping):
        for key in ("description", "descriptive", "accent", "gender"):
            value = labels.get(key)
            if isinstance(value, str) and value.strip() and value.strip() not in details:
                details.append(value.strip().replace("_", " "))
            if len(details) >= 2:
                break
    label = f"{base} ({', '.join(details)})" if details else base
    label = _WS_RE.sub(" ", _CONTROL_CHARS_RE.sub(" ", label)).strip()
    return label[:MAX_VOICE_LABEL_CHARS]


def parse_voice_catalog(payload: object) -> list[ElevenLabsVoice]:
    """Extract valid voice IDs and display labels from an ElevenLabs /v1/voices payload."""
    if not isinstance(payload, Mapping):
        raise SpeechProviderError("ElevenLabs returned an unexpected voice list.")
    raw_voices = payload.get("voices")
    if not isinstance(raw_voices, list):
        raise SpeechProviderError("ElevenLabs returned an unexpected voice list.")
    voices: list[ElevenLabsVoice] = []
    seen: set[str] = set()
    for raw in raw_voices:
        if not isinstance(raw, Mapping):
            continue
        voice_id = raw.get("voice_id")
        if not isinstance(voice_id, str) or not VOICE_ID_PATTERN.fullmatch(voice_id):
            continue
        if voice_id == DEFAULT_VOICE_KEY or voice_id in seen:
            continue
        seen.add(voice_id)
        voices.append(ElevenLabsVoice(voice_id=voice_id, label=_voice_label(raw)))
        if len(voices) >= MAX_CATALOG_VOICES:
            break
    voices.sort(key=lambda v: v.label.lower())
    return voices


async def fetch_elevenlabs_voices(
    client: httpx.AsyncClient,
    settings: Settings,
) -> list[ElevenLabsVoice]:
    """List the voices available to the configured ElevenLabs account."""
    if not settings.speech_configured:
        raise SpeechConfigError("ElevenLabs speech synthesis is not configured.")
    request = client.build_request(
        "GET",
        f"{ELEVENLABS_BASE_URL}/voices",
        headers={
            "xi-api-key": settings.elevenlabs_api_key.strip(),
            "Accept": "application/json",
        },
        timeout=httpx.Timeout(
            connect=5.0, read=settings.speech_timeout_seconds, write=5.0, pool=5.0
        ),
    )
    try:
        response = await client.send(request, stream=True)
    except httpx.TimeoutException as exc:
        raise SpeechTimeoutError("ElevenLabs voice list request timed out.") from exc
    except httpx.HTTPError as exc:
        raise SpeechUnavailableError("Speech provider connection failed.") from exc

    if response.status_code != 200:
        await _raise_upstream_error(response, "voices")
    try:
        body = await response.aread()
    except httpx.TimeoutException as exc:
        raise SpeechTimeoutError("ElevenLabs voice list request timed out.") from exc
    except httpx.HTTPError as exc:
        raise SpeechUnavailableError("Speech provider connection failed.") from exc
    finally:
        await response.aclose()
    try:
        payload = json.loads(body.decode("utf-8", errors="ignore"))
    except (ValueError, RecursionError) as exc:
        raise SpeechProviderError("ElevenLabs returned an unexpected voice list.") from exc
    return parse_voice_catalog(payload)


class VoiceCatalog:
    """Short-lived cache of account voices; also the allowlist for client voice choices."""

    def __init__(
        self,
        ttl_seconds: float = VOICE_CATALOG_TTL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._ttl_seconds = ttl_seconds
        self._clock = clock
        self._voices: list[ElevenLabsVoice] | None = None
        self._fetched_at = 0.0
        self._lock = asyncio.Lock()

    async def get(
        self,
        client: httpx.AsyncClient,
        settings: Settings,
    ) -> list[ElevenLabsVoice]:
        async with self._lock:
            now = self._clock()
            if self._voices is not None and now - self._fetched_at < self._ttl_seconds:
                return self._voices
            self._voices = await fetch_elevenlabs_voices(client, settings)
            self._fetched_at = self._clock()
            return self._voices

    async def contains(
        self,
        client: httpx.AsyncClient,
        settings: Settings,
        voice_id: str,
    ) -> bool:
        voices = await self.get(client, settings)
        return any(v.voice_id == voice_id for v in voices)


async def open_elevenlabs_speech_stream(
    client: httpx.AsyncClient,
    text: str,
    settings: Settings,
    *,
    voice: str = DEFAULT_VOICE_KEY,
) -> OpenedSpeechStream:
    """Open a streaming MP3 request to ElevenLabs v4 Turbo without logging secrets or text."""
    if not settings.speech_configured:
        raise SpeechConfigError("ElevenLabs speech synthesis is not configured.")

    voice_id = resolve_voice_id(settings, voice)
    try:
        prepared_text = prepare_spoken_text(text)
    except ValueError as exc:
        raise SpeechTextError("Enter text that can be read aloud.") from exc

    url = (
        f"{ELEVENLABS_BASE_URL}/text-to-speech/{voice_id}/stream"
        f"?output_format={ELEVENLABS_OUTPUT_FORMAT}"
    )
    payload = {
        "text": prepared_text,
        "model_id": settings.elevenlabs_model_id.strip(),
        "apply_text_normalization": "auto",
        "voice_settings": {
            "stability": 0.55,
            "similarity_boost": 0.75,
        },
    }
    timeout = httpx.Timeout(
        connect=5.0,
        read=settings.speech_timeout_seconds,
        write=5.0,
        pool=5.0,
    )
    request = client.build_request(
        "POST",
        url,
        headers={
            "xi-api-key": settings.elevenlabs_api_key.strip(),
            "Content-Type": "application/json",
            "Accept": "audio/mpeg",
        },
        json=payload,
        timeout=timeout,
    )

    try:
        response = await client.send(request, stream=True)
    except httpx.TimeoutException as exc:
        raise SpeechTimeoutError("Speech synthesis timed out.") from exc
    except httpx.HTTPError as exc:
        raise SpeechUnavailableError("Speech provider connection failed.") from exc

    if response.status_code != 200:
        await _raise_upstream_error(response, "TTS")
    if not response.headers.get("content-type", "").lower().startswith("audio/"):
        await response.aclose()
        raise SpeechProviderError("Speech provider did not return audio.")

    return OpenedSpeechStream(response=response, media_type="audio/mpeg")
