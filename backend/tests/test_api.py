"""FastAPI tests covering health, validation, upload limits, concurrency, and projection."""

from __future__ import annotations

import asyncio
import io
import json
from collections.abc import Awaitable, Callable
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


async def test_health_endpoint_without_credentials_and_with_deep_mode_disabled() -> None:
    app_no_key = create_app(Settings(gemini_api_key=""))
    async with app_no_key.router.lifespan_context(app_no_key):
        transport = httpx.ASGITransport(app=app_no_key)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json() == {
        "status": "ok",
        "analysis_configured": False,
        "deep_mode_configured": False,
        "credentials_verified": False,
    }

    app_no_deep = create_app(
        Settings(gemini_api_key="key", gemini_deep_model=""),
        client_factory=lambda _s: _ScriptedClient(_unused_handler),
    )
    async with app_no_deep.router.lifespan_context(app_no_deep):
        transport = httpx.ASGITransport(app=app_no_deep)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/health")
    assert resp.status_code == 200
    assert resp.json()["analysis_configured"] is True
    assert resp.json()["deep_mode_configured"] is False


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

    # Deep mode disabled returns 400
    fake = _ScriptedClient(_unused_handler)
    app_no_deep = create_app(
        Settings(gemini_api_key="key", gemini_deep_model=""),
        client_factory=lambda _s: fake,
    )
    async with app_no_deep.router.lifespan_context(app_no_deep):
        transport = httpx.ASGITransport(app=app_no_deep)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.post(
                "/api/analyze",
                files={"image": ("board.png", img_bytes, "image/png")},
                data={"metadata": json.dumps({"request_id": req_id, "deep_mode": True})},
            )
            assert resp.status_code == 400
            assert resp.json()["code"] == "DEEP_MODE_DISABLED"

            # Unknown metadata field rejected 422 with echoed request_id
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
