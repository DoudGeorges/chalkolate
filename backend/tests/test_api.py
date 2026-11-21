"""FastAPI tests covering health, validation, upload limits, concurrency, and projection."""

from __future__ import annotations

import asyncio
import contextlib
import io
import json
from collections.abc import AsyncIterator, Awaitable, Callable
from typing import Any
from uuid import uuid4

import httpx
from google.genai import errors as genai_errors
from google.genai import types
from PIL import Image

from config import Settings
from main import create_app


def _png_bytes(width: int = 800, height: int = 600) -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (width, height), color=(20, 40, 30)).save(buf, format="PNG")
    return buf.getvalue()


class _ScriptedModels:
    def __init__(self, handler: Callable[..., Awaitable[types.GenerateContentResponse]]) -> None:
        self._handler = handler
        self.call_count = 0

    async def generate_content(
        self,
        *,
        model: str,
        contents: list[object],
        config: types.GenerateContentConfig,
    ) -> types.GenerateContentResponse:
        self.call_count += 1
        return await self._handler(model=model, contents=contents, config=config)


class _ScriptedAio:
    def __init__(self, handler: Callable[..., Awaitable[types.GenerateContentResponse]]) -> None:
        self.models = _ScriptedModels(handler)
        self.aclosed = False

    async def aclose(self) -> None:
        self.aclosed = True


class _ScriptedClient:
    def __init__(self, handler: Callable[..., Awaitable[types.GenerateContentResponse]]) -> None:
        self.aio = _ScriptedAio(handler)
        self.closed = False

    def close(self) -> None:
        self.closed = True


async def _unused_handler(**_kwargs: Any) -> types.GenerateContentResponse:
    raise AssertionError("Gemini client should not be called in this test.")


def _ok_json_response(payload: dict[str, object]) -> types.GenerateContentResponse:
    return types.GenerateContentResponse(
        candidates=[
            types.Candidate(
                finish_reason=types.FinishReason.STOP,
                content=types.Content(
                    role="model",
                    parts=[types.Part.from_text(text=json.dumps(payload))],
                ),
            )
        ]
    )


async def test_health_endpoint_with_and_without_credentials() -> None:
    app_no_key = create_app(Settings(gemini_api_key=""))
    async with app_no_key.router.lifespan_context(app_no_key):
        transport = httpx.ASGITransport(app=app_no_key)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {
        "status": "ok",
        "analysis_configured": False,
        "speech_configured": False,
        "credentials_verified": False,
    }

    app_configured = create_app(
        Settings(
            gemini_api_key="key",
            elevenlabs_api_key="el-key",
            elevenlabs_voice_id="voice1",
        ),
        client_factory=lambda _s: _ScriptedClient(_unused_handler),
        speech_client_factory=lambda _s: httpx.AsyncClient(),
    )
    async with app_configured.router.lifespan_context(app_configured):
        transport = httpx.ASGITransport(app=app_configured)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {
        "status": "ok",
        "analysis_configured": True,
        "speech_configured": True,
        "credentials_verified": False,
    }


async def test_analyze_configuration_errors_and_metadata_validation() -> None:
    req_id = str(uuid4())
    img_bytes = _png_bytes()

    # Missing API key returns 503 with echoed request_id
    app_no_key = create_app(Settings(gemini_api_key=""))
    async with app_no_key.router.lifespan_context(app_no_key):
        transport = httpx.ASGITransport(app=app_no_key)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/api/analyze",
                files={"image": ("board.png", img_bytes, "image/png")},
                data={"metadata": json.dumps({"request_id": req_id})},
            )
    assert resp.status_code == 503
    assert resp.json()["code"] == "ANALYSIS_NOT_CONFIGURED"
    assert resp.json()["request_id"] == req_id

    # Removed fields (deep_mode / enhance_chalkboard) and unknown fields are rejected 422
    fake = _ScriptedClient(_unused_handler)
    app = create_app(
        Settings(gemini_api_key="key"),
        client_factory=lambda _s: fake,
    )
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            removed_field = await client.post(
                "/api/analyze",
                files={"image": ("board.png", img_bytes, "image/png")},
                data={"metadata": json.dumps({"request_id": req_id, "deep_mode": True})},
            )
            assert removed_field.status_code == 422
            assert removed_field.json()["code"] == "INVALID_METADATA"
            assert removed_field.json()["request_id"] == req_id

            bad_meta = await client.post(
                "/api/analyze",
                files={"image": ("board.png", img_bytes, "image/png")},
                data={"metadata": json.dumps({"request_id": req_id, "unknown": 1})},
            )
            assert bad_meta.status_code == 422
            assert bad_meta.json()["code"] == "INVALID_METADATA"
            assert bad_meta.json()["request_id"] == req_id
    assert fake.aio.aclosed and fake.closed


async def test_analyze_success_projects_coordinates_and_rejects_bad_images_before_gemini() -> None:
    req_id = str(uuid4())

    async def handler(**_k: Any) -> types.GenerateContentResponse:
        return _ok_json_response(
            {
                "board_summary": "Physics equation",
                "errors": [
                    {
                        "category": "physics",
                        "detected_text": "F = 10 N/m",
                        "correction_text": "F = 10 N",
                        "correction_latex": "F = 10\\,\\mathrm{N}",
                        "spoken_alert": "Force should be in Newtons, not Newtons per meter.",
                        "explanation": ("Mass in kg times acceleration in m/s^2 produces Newtons."),
                        "box_2d": [0, 0, 500, 500],
                        "confidence": 0.95,
                    }
                ],
            }
        )

    fake = _ScriptedClient(handler)
    app = create_app(
        Settings(gemini_api_key="key", max_image_pixels=500_000),
        client_factory=lambda _s: fake,
    )
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            # 1. Calibrated crop [200..800, 200..800] -> model top-left quadrant [0,0,500,500]
            # should map cleanly to source [200, 200, 500, 500].
            resp = await client.post(
                "/api/analyze",
                files={"image": ("board.png", _png_bytes(800, 600), "image/png")},
                data={
                    "metadata": json.dumps(
                        {
                            "request_id": req_id,
                            "corners": [[200, 200], [800, 200], [800, 800], [200, 800]],
                        }
                    )
                },
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["request_id"] == req_id
            assert data["image_width"] == 800
            assert data["image_height"] == 600
            assert data["latency_ms"] >= 0
            assert data["errors"][0]["box_2d"] == [200, 200, 500, 500]

            calls_before = fake.aio.models.call_count

            # 2. Unsupported format even with image/png filename/MIME rejected before Gemini
            bad_fmt = await client.post(
                "/api/analyze",
                files={"image": ("fake.png", b"<svg></svg>", "image/png")},
                data={"metadata": json.dumps({"request_id": req_id})},
            )
            assert bad_fmt.status_code == 415
            assert bad_fmt.json()["code"] == "UNSUPPORTED_IMAGE_FORMAT"

            # 3. Pixel-oversized image rejected before Gemini
            huge_png = _png_bytes(1000, 1000)  # 1M pixels > 500k cap
            too_many_px = await client.post(
                "/api/analyze",
                files={"image": ("huge.png", huge_png, "image/png")},
                data={"metadata": json.dumps({"request_id": req_id})},
            )
            assert too_many_px.status_code == 413
            assert too_many_px.json()["code"] == "IMAGE_PIXELS_EXCEEDED"

            assert fake.aio.models.call_count == calls_before


async def test_streamed_oversized_upload_and_upstream_failure_mapping() -> None:
    req_id = str(uuid4())

    async def rate_limited(**_k: Any) -> types.GenerateContentResponse:
        raise genai_errors.APIError(429, {"error": {"message": "Quota exceeded; retry in 9s"}})

    app = create_app(
        Settings(gemini_api_key="key", max_upload_bytes=2048),
        client_factory=lambda _s: _ScriptedClient(rate_limited),
    )

    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            # Streamed/chunked upload WITHOUT Content-Length exceeding byte budget
            async def chunked_body() -> Any:
                yield (
                    b"--boundary\r\n"
                    b'Content-Disposition: form-data; name="image"; filename="big.png"\r\n'
                    b"Content-Type: image/png\r\n\r\n"
                )
                for _ in range(80):
                    yield b"x" * 2048
                yield b"\r\n--boundary--\r\n"

            oversized = await client.post(
                "/api/analyze",
                content=chunked_body(),
                headers={"Content-Type": "multipart/form-data; boundary=boundary"},
            )
            assert oversized.status_code == 413
            assert oversized.json()["code"] == "PAYLOAD_TOO_LARGE"

            # Small valid image hits upstream 429 and maps cleanly to 429 + Retry-After
            tiny_png = _png_bytes(64, 64)
            assert len(tiny_png) < 2048
            rl_resp = await client.post(
                "/api/analyze",
                files={"image": ("tiny.png", tiny_png, "image/png")},
                data={"metadata": json.dumps({"request_id": req_id})},
            )
            assert rl_resp.status_code == 429
            assert rl_resp.json()["code"] == "UPSTREAM_RATE_LIMITED"
            assert rl_resp.headers.get("Retry-After") == "9"

    # Upstream 503 unavailability includes a Retry-After header for client cooldown
    async def unavailable(**_k: Any) -> types.GenerateContentResponse:
        raise genai_errors.APIError(503, {"error": {"message": "High demand"}})

    app_unavail = create_app(
        Settings(gemini_api_key="key"),
        client_factory=lambda _s: _ScriptedClient(unavailable),
    )
    async with app_unavail.router.lifespan_context(app_unavail):
        transport = httpx.ASGITransport(app=app_unavail)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp_503 = await client.post(
                "/api/analyze",
                files={"image": ("tiny.png", _png_bytes(64, 64), "image/png")},
                data={"metadata": json.dumps({"request_id": req_id})},
            )
            assert resp_503.status_code == 503
            assert resp_503.json()["code"] == "UPSTREAM_UNAVAILABLE"
            assert resp_503.headers.get("Retry-After") == "5"


async def test_concurrency_gate_rejects_excess_and_releases_on_error() -> None:
    entered = asyncio.Event()
    release = asyncio.Event()
    should_fail = True

    async def slow_handler(**_k: Any) -> types.GenerateContentResponse:
        entered.set()
        await release.wait()
        if should_fail:
            raise genai_errors.APIError(500, {"error": {"message": "boom"}})
        return _ok_json_response({"board_summary": "Recovered", "errors": []})

    app = create_app(
        Settings(gemini_api_key="key", analysis_max_concurrency=1),
        client_factory=lambda _s: _ScriptedClient(slow_handler),
    )
    img = _png_bytes(120, 90)

    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            first_task = asyncio.create_task(
                client.post(
                    "/api/analyze",
                    files={"image": ("a.png", img, "image/png")},
                    data={"metadata": json.dumps({"request_id": str(uuid4())})},
                )
            )
            await entered.wait()

            # Second concurrent request must be promptly rejected with 503 CAPACITY_EXCEEDED
            busy = await client.post(
                "/api/analyze",
                files={"image": ("b.png", img, "image/png")},
                data={"metadata": json.dumps({"request_id": str(uuid4())})},
            )
            assert busy.status_code == 503
            assert busy.json()["code"] == "CAPACITY_EXCEEDED"
            assert busy.headers.get("Retry-After") == "2"

            # Let first fail and verify slot is released cleanly for a subsequent request
            release.set()
            first_resp = await first_task
            assert first_resp.status_code == 502

            should_fail = False
            recovered = await client.post(
                "/api/analyze",
                files={"image": ("c.png", img, "image/png")},
                data={"metadata": json.dumps({"request_id": str(uuid4())})},
            )
            assert recovered.status_code == 200
            assert recovered.json()["board_summary"] == "Recovered"


async def test_detect_board_endpoint_works_without_api_key_and_validates_uploads() -> None:
    # Build a clear whiteboard on a dark wall so corner detection succeeds deterministically.
    import cv2
    import numpy as np

    canvas = np.full((600, 800, 3), 55, dtype=np.uint8)
    cv2.rectangle(canvas, (100, 80), (700, 520), (242, 244, 246), thickness=-1)
    cv2.putText(canvas, "E = mc^2", (240, 300), cv2.FONT_HERSHEY_SIMPLEX, 1.8, (30, 35, 45), 3)
    buf = io.BytesIO()
    Image.fromarray(cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB)).save(buf, format="PNG")
    board_png = buf.getvalue()

    # Does not require GEMINI_API_KEY
    app = create_app(Settings(gemini_api_key=""))
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/api/detect-board",
                files={"image": ("board.png", board_png, "image/png")},
            )
            assert resp.status_code == 200
            data = resp.json()
            assert data["detected"] is True
            assert data["confidence"] >= 0.45
            assert len(data["corners"]) == 4

            # Blank uniform frame returns detected=False honestly
            blank_resp = await client.post(
                "/api/detect-board",
                files={"image": ("blank.png", _png_bytes(400, 300), "image/png")},
            )
            assert blank_resp.status_code == 200
            assert blank_resp.json() == {"detected": False, "corners": None, "confidence": 0.0}

            # Unsupported format maps cleanly to 415
            bad_resp = await client.post(
                "/api/detect-board",
                files={"image": ("fake.png", b"not an image", "image/png")},
            )
            assert bad_resp.status_code == 415
            assert bad_resp.json()["code"] == "UNSUPPORTED_IMAGE_FORMAT"


async def test_speech_endpoint_streaming_validation_limits_and_concurrency() -> None:
    # 1. Unconfigured ElevenLabs returns 503 SPEECH_NOT_CONFIGURED cleanly
    app_no_speech = create_app(Settings(elevenlabs_api_key=""))
    async with app_no_speech.router.lifespan_context(app_no_speech):
        transport = httpx.ASGITransport(app=app_no_speech)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post("/api/speech", json={"text": "Check the minus sign."})
            assert resp.status_code == 503
            assert resp.json()["code"] == "SPEECH_NOT_CONFIGURED"

    # 2. Streaming success + validation + body size limit + error mapping + rate limiting
    def mock_handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content.decode("utf-8"))
        text = str(body["text"])
        if "quota" in text:
            return httpx.Response(402, json={"detail": {"status": "quota_exceeded"}})
        if "paidvoice" in text:
            return httpx.Response(
                402,
                json={"detail": {"code": "paid_plan_required", "status": "payment_required"}},
            )
        if "badauth" in text:
            return httpx.Response(401, json={"detail": {"status": "invalid_api_key"}})

        class _ChunkedStream(httpx.AsyncByteStream):
            async def __aiter__(self) -> AsyncIterator[bytes]:
                yield b"ID3"
                yield b"\xff\xfb\x90\x00"

        return httpx.Response(
            200,
            headers={"content-type": "audio/mpeg"},
            stream=_ChunkedStream(),
        )

    app_ok = create_app(
        Settings(
            elevenlabs_api_key="el-key",
            elevenlabs_voice_id="voice1",
            speech_rate_limit_per_minute=5,
        ),
        speech_client_factory=lambda _s: httpx.AsyncClient(
            transport=httpx.MockTransport(mock_handler)
        ),
    )
    async with app_ok.router.lifespan_context(app_ok):
        transport = httpx.ASGITransport(app=app_ok)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            # Invalid empty / oversized text rejected before consuming quota
            bad_empty = await client.post("/api/speech", json={"text": "   "})
            assert bad_empty.status_code == 422

            bad_extra = await client.post("/api/speech", json={"text": "hi", "voice_id": "x"})
            assert bad_extra.status_code == 422

            huge_body = await client.post("/api/speech", json={"text": "a" * 5000})
            assert huge_body.status_code == 413
            assert huge_body.json()["code"] == "PAYLOAD_TOO_LARGE"

            # Valid synthesis streams audio/mpeg with no-store
            ok_resp = await client.post("/api/speech", json={"text": "Missing 2ab term."})
            assert ok_resp.status_code == 200
            assert ok_resp.headers["content-type"].startswith("audio/mpeg")
            assert ok_resp.headers["cache-control"] == "no-store"
            assert ok_resp.content == b"ID3\xff\xfb\x90\x00"
            assert app_ok.state.speech_concurrency_gate.active == 0

            # Quota, Plan Tier, and Auth errors map cleanly
            quota_resp = await client.post("/api/speech", json={"text": "trigger quota"})
            assert quota_resp.status_code == 503
            assert quota_resp.json()["code"] == "SPEECH_QUOTA_EXCEEDED"
            assert quota_resp.headers.get("Retry-After") == "60"

            plan_resp = await client.post("/api/speech", json={"text": "trigger paidvoice"})
            assert plan_resp.status_code == 503
            assert plan_resp.json()["code"] == "SPEECH_VOICE_PLAN_REQUIRED"

            auth_resp = await client.post("/api/speech", json={"text": "trigger badauth"})
            assert auth_resp.status_code == 502
            assert auth_resp.json()["code"] == "SPEECH_AUTH_ERROR"

            # 5th call stays within limit=5; 6th exceeds per-minute rate limit
            r5 = await client.post("/api/speech", json={"text": "Fifth check"})
            assert r5.status_code == 200
            r6 = await client.post("/api/speech", json={"text": "Sixth throttled"})
            assert r6.status_code == 429
            assert r6.json()["code"] == "SPEECH_RATE_LIMITED"
            assert int(r6.headers["Retry-After"]) >= 1

    # 3. Concurrency gate rejects simultaneous overflow and releases cleanly on mid-stream error
    stream_entered = asyncio.Event()
    release_stream = asyncio.Event()
    fail_mid_stream = False

    class _GatedStream(httpx.AsyncByteStream):
        async def __aiter__(self) -> AsyncIterator[bytes]:
            stream_entered.set()
            await release_stream.wait()
            yield b"chunk1"
            if fail_mid_stream:
                raise httpx.ReadError("upstream dropped")

    def gated_handler(_req: httpx.Request) -> httpx.Response:
        return httpx.Response(
            200,
            headers={"content-type": "audio/mpeg"},
            stream=_GatedStream(),
        )

    app_gate = create_app(
        Settings(
            elevenlabs_api_key="el-key",
            elevenlabs_voice_id="voice1",
            speech_max_concurrency=1,
            speech_rate_limit_per_minute=20,
        ),
        speech_client_factory=lambda _s: httpx.AsyncClient(
            transport=httpx.MockTransport(gated_handler)
        ),
    )
    async with app_gate.router.lifespan_context(app_gate):
        transport = httpx.ASGITransport(app=app_gate)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            t1 = asyncio.create_task(client.post("/api/speech", json={"text": "First stream"}))
            await stream_entered.wait()
            busy = await client.post("/api/speech", json={"text": "Second concurrent"})
            assert busy.status_code == 503
            assert busy.json()["code"] == "CAPACITY_EXCEEDED"
            assert busy.headers.get("Retry-After") == "2"

            release_stream.set()
            first_done = await t1
            assert first_done.status_code == 200
            assert app_gate.state.speech_concurrency_gate.active == 0

            # Mid-stream upstream drop still releases slot
            fail_mid_stream = True
            stream_entered.clear()
            with contextlib.suppress(httpx.ReadError):
                await client.post("/api/speech", json={"text": "Drop mid-stream"})
            assert app_gate.state.speech_concurrency_gate.active == 0
