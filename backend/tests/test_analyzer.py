"""Tests for Gemini calls, schema validation, confidence filtering, and errors."""

from __future__ import annotations

import json
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import uuid4

import numpy as np
import pytest
from google.genai import errors as genai_errors
from google.genai import types

from analyzer import (
    AnalysisTimeoutError,
    ModelBlockedError,
    ModelTruncatedError,
    UnusableModelOutputError,
    UpstreamAuthError,
    UpstreamProviderError,
    UpstreamRateLimitError,
    UpstreamUnavailableError,
    analyze_board_image,
)
from config import Settings
from schemas import AnalysisMetadata
from vision import PreparedImage


def _make_prepared() -> PreparedImage:
    return PreparedImage(
        jpeg_bytes=b"\xff\xd8\xff\xe0dummyjpeg",
        source_width=1280,
        source_height=720,
        model_width=1280,
        model_height=720,
        forward_homography=np.eye(3, dtype=np.float64),
        inverse_homography=np.eye(3, dtype=np.float64),
    )


def _make_settings() -> Settings:
    return Settings(
        gemini_api_key="test-secret-key",
        gemini_model="gemini-3.8-flash",
        gemini_thinking_level="low",
        confidence_threshold=0.85,
        analysis_timeout_seconds=15.0,
        analysis_max_output_tokens=2048,
    )


@dataclass
class _RecordedCall:
    model: str
    contents: list[object]
    config: types.GenerateContentConfig


class _FakeModels:
    def __init__(self, handler: Callable[..., Awaitable[types.GenerateContentResponse]]) -> None:
        self._handler = handler
        self.calls: list[_RecordedCall] = []

    async def generate_content(
        self,
        *,
        model: str,
        contents: list[object],
        config: types.GenerateContentConfig,
    ) -> types.GenerateContentResponse:
        self.calls.append(_RecordedCall(model=model, contents=contents, config=config))
        return await self._handler(model=model, contents=contents, config=config)


class _FakeAio:
    def __init__(self, handler: Callable[..., Awaitable[types.GenerateContentResponse]]) -> None:
        self.models = _FakeModels(handler)
        self.aclosed = False

    async def aclose(self) -> None:
        self.aclosed = True


class _FakeClient:
    def __init__(self, handler: Callable[..., Awaitable[types.GenerateContentResponse]]) -> None:
        self.aio = _FakeAio(handler)
        self.closed = False

    def close(self) -> None:
        self.closed = True


def _ok_response(payload: dict[str, object]) -> types.GenerateContentResponse:
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


async def test_analyze_thinking_level_config_and_confidence_filtering() -> None:
    async def handler(**_kwargs: Any) -> types.GenerateContentResponse:
        return _ok_response(
            {
                "board_summary": "Derivative on chalkboard",
                "errors": [
                    {
                        "category": "math",
                        "detected_text": "d/dx(x^3) = 2x^2",
                        "correction_text": "d/dx(x^3) = 3x^2",
                        "correction_latex": r"\frac{d}{dx}(x^3) = 3x^2",
                        "spoken_alert": "The derivative of x cubed is 3 x squared.",
                        "explanation": (
                            "By the power rule, multiply by 3 and decrement the exponent."
                        ),
                        "box_2d": [100, 100, 200, 500],
                        "confidence": 0.92,
                    },
                    {
                        "category": "spelling",
                        "detected_text": "Derivitive",
                        "correction_text": "Derivative",
                        "correction_latex": None,
                        "spoken_alert": "Derivative is misspelled.",
                        "explanation": "Uncertain handwriting check below threshold.",
                        "box_2d": [300, 100, 380, 300],
                        "confidence": 0.84,
                    },
                ],
            }
        )

    client = _FakeClient(handler)
    settings = _make_settings()
    prepared = _make_prepared()

    meta = AnalysisMetadata(
        request_id=uuid4(),
        previous_board_summary="",
        corners=None,
    )
    res = await analyze_board_image(client, prepared, meta, settings)
    assert res.board_summary == "Derivative on chalkboard"
    # Confidence below 0.85 is filtered out
    assert len(res.errors) == 1
    assert res.errors[0].detected_text == "d/dx(x^3) = 2x^2"

    call0 = client.aio.models.calls[0]
    assert call0.model == "gemini-3.8-flash"
    assert call0.config.response_mime_type == "application/json"
    assert call0.config.response_json_schema is not None
    assert call0.config.thinking_config is not None
    assert call0.config.thinking_config.thinking_level == types.ThinkingLevel.LOW
    assert call0.config.temperature is None
    assert call0.config.top_p is None
    assert call0.config.top_k is None
    assert call0.config.presence_penalty is None
    assert call0.config.frequency_penalty is None
    assert call0.config.max_output_tokens == 2048
    assert isinstance(call0.config.system_instruction, str)
    assert "square-bracket" in call0.config.system_instruction
    assert call0.config.automatic_function_calling is not None
    assert call0.config.automatic_function_calling.disable is True
    assert call0.config.http_options is not None
    assert call0.config.http_options.timeout == 15_000
    assert call0.config.http_options.retry_options is not None
    assert call0.config.http_options.retry_options.attempts == 2
    assert call0.config.http_options.retry_options.http_status_codes == [503]

    # Verify GEMINI_THINKING_LEVEL=minimal maps to ThinkingLevel.MINIMAL
    minimal_settings = Settings(
        gemini_api_key="test-secret-key",
        gemini_model="gemini-3.8-flash",
        gemini_thinking_level="minimal",
        analysis_timeout_seconds=12.0,
        analysis_max_output_tokens=1024,
    )
    await analyze_board_image(client, prepared, meta, minimal_settings)
    call1 = client.aio.models.calls[1]
    assert call1.config.thinking_config is not None
    assert call1.config.thinking_config.thinking_level == types.ThinkingLevel.MINIMAL
    assert call1.config.max_output_tokens == 1024
    assert call1.config.http_options is not None
    assert call1.config.http_options.timeout == 12_000


async def test_analyze_failure_modes_never_become_empty_success() -> None:
    settings = _make_settings()
    prepared = _make_prepared()
    meta = AnalysisMetadata(request_id=uuid4())

    # 1. Blocked by prompt_feedback
    async def blocked_prompt(**_k: Any) -> types.GenerateContentResponse:
        return types.GenerateContentResponse(
            prompt_feedback=types.GenerateContentResponsePromptFeedback(
                block_reason=types.BlockedReason.SAFETY
            )
        )

    with pytest.raises(ModelBlockedError):
        await analyze_board_image(_FakeClient(blocked_prompt), prepared, meta, settings)

    # 2. Candidate finish_reason = SAFETY
    async def blocked_candidate(**_k: Any) -> types.GenerateContentResponse:
        return types.GenerateContentResponse(
            candidates=[types.Candidate(finish_reason=types.FinishReason.SAFETY)]
        )

    with pytest.raises(ModelBlockedError):
        await analyze_board_image(_FakeClient(blocked_candidate), prepared, meta, settings)

    # 3. Truncated output (MAX_TOKENS)
    async def truncated(**_k: Any) -> types.GenerateContentResponse:
        return types.GenerateContentResponse(
            candidates=[
                types.Candidate(
                    finish_reason=types.FinishReason.MAX_TOKENS,
                    content=types.Content(
                        role="model",
                        parts=[types.Part.from_text(text='{"board_summary": "x", "errors": [')],
                    ),
                )
            ]
        )

    with pytest.raises(ModelTruncatedError):
        await analyze_board_image(_FakeClient(truncated), prepared, meta, settings)

    # 4. Empty text or missing candidates
    async def empty_text(**_k: Any) -> types.GenerateContentResponse:
        return types.GenerateContentResponse(
            candidates=[types.Candidate(finish_reason=types.FinishReason.STOP)]
        )

    with pytest.raises(UnusableModelOutputError):
        await analyze_board_image(_FakeClient(empty_text), prepared, meta, settings)

    # 5. Schema violation (invalid box_2d)
    async def schema_bad(**_k: Any) -> types.GenerateContentResponse:
        return _ok_response(
            {
                "board_summary": "Board",
                "errors": [
                    {
                        "category": "math",
                        "detected_text": "1+1=3",
                        "correction_text": "1+1=2",
                        "correction_latex": None,
                        "spoken_alert": "One plus one is two.",
                        "explanation": "Arithmetic sum is incorrect.",
                        "box_2d": [500, 100, 200, 300],
                        "confidence": 0.99,
                    }
                ],
            }
        )

    with pytest.raises(UnusableModelOutputError):
        await analyze_board_image(_FakeClient(schema_bad), prepared, meta, settings)

    # 6. Timeout
    async def raises_timeout(**_k: Any) -> types.GenerateContentResponse:
        raise TimeoutError("deadline exceeded")

    with pytest.raises(AnalysisTimeoutError):
        await analyze_board_image(_FakeClient(raises_timeout), prepared, meta, settings)

    # 7. APIError mapping
    api_cases: list[tuple[int, dict[str, object], type[Exception]]] = [
        (429, {"error": {"message": "Rate limited; retry in 7s"}}, UpstreamRateLimitError),
        (401, {"error": {"message": "Unauthorized"}}, UpstreamAuthError),
        (503, {"error": {"message": "Unavailable"}}, UpstreamUnavailableError),
        (408, {"error": {"message": "Timeout"}}, AnalysisTimeoutError),
        (500, {"error": {"message": "Server fault"}}, UpstreamProviderError),
    ]
    for status, body, exc_cls in api_cases:

        async def raises_api(_s: int = status, _b: dict[str, object] = body, **_k: Any) -> Any:
            raise genai_errors.APIError(_s, _b)

        with pytest.raises(exc_cls) as exc_info:
            await analyze_board_image(_FakeClient(raises_api), prepared, meta, settings)
        if isinstance(exc_info.value, UpstreamRateLimitError):
            assert exc_info.value.retry_after_s == 7
