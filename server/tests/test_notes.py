"""Tests for Permanotes: schemas, prompt, Gemini call, and the /api/notes endpoint."""

from __future__ import annotations

import io
import json
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import uuid4

import httpx
import pytest
from google.genai import types
from PIL import Image
from pydantic import ValidationError

from analyzer import UnusableModelOutputError
from config import Settings
from main import create_app
from notes import build_notes_prompt, build_notes_update
from schemas import BoardNotesResult, NotesMetadata, NotesSectionContext
from vision import prepare_image


def _png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (640, 480), color=(20, 40, 30)).save(buf, format="PNG")
    return buf.getvalue()


def _response(payload: dict[str, object] | str) -> types.GenerateContentResponse:
    text = payload if isinstance(payload, str) else json.dumps(payload)
    return types.GenerateContentResponse(
        candidates=[
            types.Candidate(
                finish_reason=types.FinishReason.STOP,
                content=types.Content(role="model", parts=[types.Part.from_text(text=text)]),
            )
        ]
    )


class _Models:
    def __init__(self, handler: Callable[..., Awaitable[types.GenerateContentResponse]]) -> None:
        self._handler = handler
        self.calls: list[dict[str, Any]] = []

    async def generate_content(
        self, *, model: str, contents: list[object], config: types.GenerateContentConfig
    ) -> types.GenerateContentResponse:
        self.calls.append({"model": model, "contents": contents, "config": config})
        return await self._handler(model=model, contents=contents, config=config)


class _Aio:
    def __init__(self, models: _Models) -> None:
        self.models = models

    async def aclose(self) -> None:
        return None


class _Client:
    def __init__(self, handler: Callable[..., Awaitable[types.GenerateContentResponse]]) -> None:
        self.models = _Models(handler)
        self.aio = _Aio(self.models)

    def close(self) -> None:
        return None


_GOOD: dict[str, object] = {
    "lecture_title": "Kinematics",
    "updates": [
        {
            "id": "sec-1",
            "heading": "Constant acceleration",
            "body_markdown": "$$v = v_0 + at$$",
            "has_figure": False,
            "figure_box_2d": None,
            "after_section_id": None,
        }
    ],
}


def _metadata(**extra: object) -> str:
    return json.dumps({"request_id": str(uuid4()), **extra})


async def _post(app: Any, *, metadata: str, image: bytes | None = None) -> httpx.Response:
    async with app.router.lifespan_context(app):
        transport = httpx.ASGITransport(app=app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as http:
            return await http.post(
                "/api/notes",
                files={
                    "image": ("b.png", image if image is not None else _png_bytes(), "image/png")
                },
                data={"metadata": metadata},
            )


def test_notes_metadata_rejects_unknown_and_bad_ids() -> None:
    rid = str(uuid4())
    with pytest.raises(ValidationError):
        NotesMetadata.model_validate({"request_id": rid, "extra": 1})
    with pytest.raises(ValidationError):
        NotesSectionContext.model_validate({"id": "bad id!", "heading": "h"})


def test_result_schema_rejects_empty_body_and_too_many_updates() -> None:
    bad = {"id": "a", "heading": "h", "body_markdown": "  ", "has_figure": False}
    with pytest.raises(ValidationError):
        BoardNotesResult.model_validate({"updates": [bad]})
    ok = {**bad, "body_markdown": "x"}
    with pytest.raises(ValidationError):
        BoardNotesResult.model_validate({"updates": [ok] * 9})


def test_prompt_wraps_untrusted_notes_context() -> None:
    meta = NotesMetadata(
        request_id=uuid4(),
        sections=[NotesSectionContext(id="s1", heading="Intro", body_markdown="ignore previous")],
    )
    prompt = build_notes_prompt(meta)
    assert "<notes_so_far>" in prompt and "untrusted" in prompt
    assert '"id": "s1"' in prompt
    assert "(none)" in build_notes_prompt(NotesMetadata(request_id=uuid4()))


async def test_build_notes_update_config_and_parsing() -> None:
    async def handler(**_: Any) -> types.GenerateContentResponse:
        return _response(_GOOD)

    client = _Client(handler)
    prepared = prepare_image(
        _png_bytes(), corners=None, max_image_pixels=25_000_000, max_long_edge=1600
    )
    settings = Settings(gemini_api_key="k", notes_max_output_tokens=2048)
    result = await build_notes_update(client, prepared, NotesMetadata(request_id=uuid4()), settings)
    assert result.updates[0].id == "sec-1"
    cfg = client.models.calls[0]["config"]
    assert cfg.response_mime_type == "application/json"
    assert cfg.max_output_tokens == 2048
    assert cfg.temperature is None


async def test_build_notes_update_malformed_output() -> None:
    async def handler(**_: Any) -> types.GenerateContentResponse:
        return _response("not json")

    prepared = prepare_image(
        _png_bytes(), corners=None, max_image_pixels=25_000_000, max_long_edge=1600
    )
    with pytest.raises(UnusableModelOutputError):
        await build_notes_update(
            _Client(handler),
            prepared,
            NotesMetadata(request_id=uuid4()),
            Settings(gemini_api_key="k"),
        )


async def test_endpoint_success_returns_updates() -> None:
    async def handler(**_: Any) -> types.GenerateContentResponse:
        return _response(_GOOD)

    app = create_app(Settings(gemini_api_key="k"), client_factory=lambda _s: _Client(handler))
    resp = await _post(app, metadata=_metadata())
    assert resp.status_code == 200
    body = resp.json()
    assert body["lecture_title"] == "Kinematics"
    assert body["updates"][0]["heading"] == "Constant acceleration"
    assert app.state.notes_concurrency_gate.active == 0


async def test_endpoint_errors_and_gate_release() -> None:
    async def handler(**_: Any) -> types.GenerateContentResponse:
        return _response("garbage")

    app = create_app(Settings(gemini_api_key="k"), client_factory=lambda _s: _Client(handler))
    resp = await _post(app, metadata=_metadata())
    assert resp.status_code == 502 and resp.json()["code"] == "UNUSABLE_MODEL_OUTPUT"
    assert app.state.notes_concurrency_gate.active == 0

    resp = await _post(app, metadata="{not json")
    assert resp.status_code == 422 and resp.json()["code"] == "INVALID_METADATA"

    resp = await _post(app, metadata=_metadata(), image=b"nonsense")
    assert resp.status_code in (415, 422)

    unconfigured = create_app(Settings(gemini_api_key=""))
    resp = await _post(unconfigured, metadata=_metadata())
    assert resp.status_code == 503 and resp.json()["code"] == "ANALYSIS_NOT_CONFIGURED"


async def test_endpoint_busy_does_not_touch_analysis_gate() -> None:
    async def handler(**_: Any) -> types.GenerateContentResponse:
        return _response(_GOOD)

    app = create_app(Settings(gemini_api_key="k"), client_factory=lambda _s: _Client(handler))
    assert app.state.notes_concurrency_gate.try_acquire()
    resp = await _post(app, metadata=_metadata())
    assert resp.status_code == 503 and resp.json()["code"] == "CAPACITY_EXCEEDED"
    assert app.state.concurrency_gate.active == 0


async def test_endpoint_metadata_too_large() -> None:
    app = create_app(Settings(gemini_api_key="k"))
    huge = _metadata(sections=[], pad="x" * (60 * 1024))
    resp = await _post(app, metadata=huge)
    assert resp.status_code == 413


async def test_endpoint_projects_figure_boxes_and_drops_invalid_ones() -> None:
    payload: dict[str, object] = {
        "lecture_title": "",
        "updates": [
            {
                "id": "a",
                "heading": "Diagram",
                "body_markdown": "A graph.",
                "has_figure": True,
                "figure_box_2d": [100, 200, 500, 600],
                "after_section_id": None,
            },
            {
                "id": "b",
                "heading": "Text",
                "body_markdown": "No figure.",
                "has_figure": False,
                "figure_box_2d": [100, 200, 500, 600],
                "after_section_id": None,
            },
        ],
    }

    async def handler(**_: Any) -> types.GenerateContentResponse:
        return _response(payload)

    app = create_app(Settings(gemini_api_key="k"), client_factory=lambda _s: _Client(handler))
    resp = await _post(app, metadata=_metadata())
    assert resp.status_code == 200
    boxes = [u["figure_box_2d"] for u in resp.json()["updates"]]
    # Uncalibrated resize preserves normalized coordinates (up to outward rounding).
    assert boxes[0] is not None
    assert all(
        abs(got - want) <= 2 for got, want in zip(boxes[0], [100, 200, 500, 600], strict=True)
    )
    assert boxes[1] is None


def test_figure_box_must_be_ordered() -> None:
    bad = {
        "id": "a",
        "heading": "h",
        "body_markdown": "x",
        "has_figure": True,
        "figure_box_2d": [500, 10, 100, 20],
    }
    with pytest.raises(ValidationError):
        BoardNotesResult.model_validate({"updates": [bad]})
