"""Tests for ElevenLabs v4 Turbo speech streaming, text preparation, and error mapping."""

from __future__ import annotations

import json

import httpx
import pytest

from config import Settings
from speech import (
    MAX_PREPARED_SPEECH_CHARS,
    SlidingWindowRateLimiter,
    SpeechAuthError,
    SpeechConfigError,
    SpeechPlanError,
    SpeechProviderError,
    SpeechQuotaError,
    SpeechRateLimitError,
    SpeechTimeoutError,
    SpeechUnavailableError,
    open_elevenlabs_speech_stream,
    prepare_spoken_text,
    validate_voice_id,
)


def _speech_settings(**overrides: object) -> Settings:
    return Settings(
        elevenlabs_api_key="el-secret-key",
        elevenlabs_model_id="eleven_v4_turbo",
        elevenlabs_voice_id="JBFqnCBsd6RMkjVDRZzb",
        **overrides,  # type: ignore[arg-type]
    )


def test_prepare_spoken_text_and_voice_id_validation() -> None:
    cleaned = prepare_spoken_text("[urgent]\x07 Acceleration is 5 m/s^2 and x^2 + y^3, not 10 N/m.")
    assert "[" not in cleaned and "]" not in cleaned
    assert "\x07" not in cleaned
    assert "meters per second squared" in cleaned
    assert "x squared" in cleaned
    assert "y cubed" in cleaned
    assert "Newtons per meter" in cleaned

    # Length cap enforced cleanly
    long_text = "word " * 80
    capped = prepare_spoken_text(long_text)
    assert len(capped) <= MAX_PREPARED_SPEECH_CHARS

    # Empty after stripping raises ValueError
    with pytest.raises(ValueError):
        prepare_spoken_text("  [] \n\t ")

    # Voice ID rejects path traversal and spaces
    assert validate_voice_id("  voice_ABC-123  ") == "voice_ABC-123"
    for bad_id in ("", "../etc/passwd", "voice id", "voice?a=1"):
        with pytest.raises(SpeechConfigError):
            validate_voice_id(bad_id)


def test_sliding_window_rate_limiter() -> None:
    limiter = SlidingWindowRateLimiter(max_requests=2, window_seconds=10.0)
    assert limiter.try_acquire("127.0.0.1") == (True, 0)
    assert limiter.try_acquire("127.0.0.1") == (True, 0)
    allowed, retry_after = limiter.try_acquire("127.0.0.1")
    assert allowed is False
    assert retry_after >= 1
    assert limiter.try_acquire("10.0.0.2") == (True, 0)


async def test_open_elevenlabs_speech_stream_payload_and_chunks() -> None:
    captured: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        captured["method"] = request.method
        captured["url"] = str(request.url)
        captured["xi_api_key"] = request.headers.get("xi-api-key")
        captured["body"] = json.loads(request.content.decode("utf-8"))
        return httpx.Response(
            200,
            headers={"content-type": "audio/mpeg"},
            content=b"ID3-chunk-1-chunk-2",
        )

    transport = httpx.MockTransport(handler)
    async with httpx.AsyncClient(transport=transport) as client:
        stream = await open_elevenlabs_speech_stream(
            client,
            "Check x^2 term and force in N/m.",
            _speech_settings(),
        )
        chunks: list[bytes] = []
        try:
            async for chunk in stream.iter_chunks(chunk_size=8):
                chunks.append(chunk)
        finally:
            await stream.aclose()

    assert b"".join(chunks) == b"ID3-chunk-1-chunk-2"
    assert captured["method"] == "POST"
    assert captured["url"] == (
        "https://api.elevenlabs.io/v1/text-to-speech/"
        "JBFqnCBsd6RMkjVDRZzb/stream?output_format=mp3_44100_128"
    )
    assert captured["xi_api_key"] == "el-secret-key"
    body = captured["body"]
    assert isinstance(body, dict)
    assert body["model_id"] == "eleven_v4_turbo"
    assert body["apply_text_normalization"] == "auto"
    assert "x squared" in str(body["text"])
    assert "Newtons per meter" in str(body["text"])


async def test_open_elevenlabs_speech_stream_maps_errors_safely() -> None:
    error_cases: list[
        tuple[int, dict[str, object], dict[str, str], type[Exception], int | None]
    ] = [
        (401, {"detail": {"status": "invalid_api_key"}}, {}, SpeechAuthError, None),
        (
            402,
            {"detail": {"code": "paid_plan_required", "status": "payment_required"}},
            {},
            SpeechPlanError,
            None,
        ),
        (402, {"detail": {"status": "quota_exceeded"}}, {}, SpeechQuotaError, 60),
        (400, {"detail": {"code": "quota_exceeded"}}, {}, SpeechQuotaError, 60),
        (
            429,
            {"detail": {"status": "rate_limit_error"}},
            {"Retry-After": "12"},
            SpeechRateLimitError,
            12,
        ),
        (503, {"detail": {"status": "busy"}}, {}, SpeechUnavailableError, 5),
        (500, {"detail": {"status": "internal"}}, {}, SpeechProviderError, None),
    ]

    for status_code, body, headers, exc_cls, expected_retry in error_cases:

        def handler(
            _req: httpx.Request,
            _sc: int = status_code,
            _b: dict[str, object] = body,
            _h: dict[str, str] = headers,
        ) -> httpx.Response:
            return httpx.Response(_sc, json=_b, headers=_h)

        async with httpx.AsyncClient(transport=httpx.MockTransport(handler)) as client:
            with pytest.raises(exc_cls) as exc_info:
                await open_elevenlabs_speech_stream(client, "Hello world", _speech_settings())
            if expected_retry is not None:
                assert getattr(exc_info.value, "retry_after_s", None) == expected_retry

    def timeout_handler(_req: httpx.Request) -> httpx.Response:
        raise httpx.ReadTimeout("timed out")

    async with httpx.AsyncClient(transport=httpx.MockTransport(timeout_handler)) as client:
        with pytest.raises(SpeechTimeoutError):
            await open_elevenlabs_speech_stream(client, "Hello world", _speech_settings())
