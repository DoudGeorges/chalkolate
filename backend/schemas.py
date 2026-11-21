"""Strict Pydantic v2 schemas separating request, model-space, and source-space contracts."""

from __future__ import annotations

import math
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ErrorCategory = Literal["math", "physics", "spelling"]

MAX_PREV_SUMMARY_LENGTH = 2000
MAX_BOARD_SUMMARY_LENGTH = 600
MAX_FINDINGS = 20
MAX_DETECTED_TEXT_LENGTH = 300
MAX_CORRECTION_TEXT_LENGTH = 300
MAX_CORRECTION_LATEX_LENGTH = 300
MAX_SPOKEN_ALERT_LENGTH = 180
MAX_EXPLANATION_LENGTH = 300
MAX_SPEECH_TEXT_LENGTH = 240


def _validate_finite_coord(value: object) -> float:
    if isinstance(value, bool) or not isinstance(value, int | float):
        raise ValueError("Coordinate must be a finite number.")
    num = float(value)
    if not math.isfinite(num) or not (0.0 <= num <= 1000.0):
        raise ValueError("Coordinate must be finite and within [0, 1000].")
    return num


def _validate_box_int(value: object) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError("box_2d elements must be integers.")
    if not (0 <= value <= 1000):
        raise ValueError("box_2d coordinates must be within [0, 1000].")
    return value


def _strip_outer_latex_delimiters(raw: str) -> str | None:
    text = raw.strip()
    if not text:
        return None
    pairs = (("$$", "$$"), ("$", "$"), (r"\(", r"\)"), (r"\[", r"\]"))
    for left, right in pairs:
        if text.startswith(left) and text.endswith(right) and len(text) > len(left) + len(right):
            inner = text[len(left) : -len(right)].strip()
            return inner or None
    return text


def _normalize_required_text(value: str, field_name: str, max_len: int) -> str:
    cleaned = value.strip()
    if not cleaned:
        raise ValueError(f"{field_name} must not be empty.")
    if len(cleaned) > max_len:
        raise ValueError(f"{field_name} must not exceed {max_len} characters.")
    return cleaned


class StrictModel(BaseModel):
    """Base model forbidding extra fields and nonfinite floats."""

    model_config = ConfigDict(extra="forbid", allow_inf_nan=False)


class AnalysisMetadata(StrictModel):
    """Client-supplied snapshot metadata sent as a JSON string alongside the image upload."""

    request_id: UUID = Field(
        description="Client-generated UUID for correlating this snapshot analysis request.",
    )
    previous_board_summary: str = Field(
        default="",
        max_length=MAX_PREV_SUMMARY_LENGTH,
        description=(
            "Optional brief summary of the previous analyzed board state, up to 2,000 characters."
        ),
    )
    corners: list[tuple[float, float]] | None = Field(
        default=None,
        min_length=4,
        max_length=4,
        description=(
            "Optional board calibration quad as four [x, y] points in TL, TR, BR, BL order, "
            "each normalized to 0..1000 in the upright, unmirrored uploaded image."
        ),
    )

    @field_validator("previous_board_summary")
    @classmethod
    def _validate_prev_summary(cls, value: str) -> str:
        trimmed = value.strip()
        if len(trimmed) > MAX_PREV_SUMMARY_LENGTH:
            raise ValueError(
                f"previous_board_summary must not exceed {MAX_PREV_SUMMARY_LENGTH} characters."
            )
        return trimmed

    @field_validator("corners")
    @classmethod
    def _validate_corners(
        cls, value: list[tuple[float, float]] | None
    ) -> list[tuple[float, float]] | None:
        if value is None:
            return None
        if len(value) != 4:
            raise ValueError("corners must contain exactly four [x, y] points.")
        validated: list[tuple[float, float]] = []
        for point in value:
            if len(point) != 2:
                raise ValueError("Each corner must contain exactly two coordinates [x, y].")
            x = _validate_finite_coord(point[0])
            y = _validate_finite_coord(point[1])
            validated.append((x, y))
        return validated


# Using list[Annotated[int, ...]] ensures Gemini structured JSON Schema uses
# standard array items/minItems/maxItems rather than tuple prefixItems.
Box2D = Annotated[
    list[Annotated[int, Field(ge=0, le=1000)]],
    Field(
        min_length=4,
        max_length=4,
        description=(
            "Tight bounding box [ymin, xmin, ymax, xmax] with four integers in 0..1000, "
            "satisfying ymin < ymax and xmin < xmax."
        ),
    ),
]


class _FindingBase(StrictModel):
    """Shared validated finding payload prior to distinguishing coordinate spaces."""

    category: ErrorCategory = Field(
        description="Mistake category: math, physics, or spelling.",
    )
    detected_text: str = Field(
        min_length=1,
        max_length=MAX_DETECTED_TEXT_LENGTH,
        description="Exact visible erroneous term, equation fragment, unit, or misspelled word.",
    )
    correction_text: str = Field(
        min_length=1,
        max_length=MAX_CORRECTION_TEXT_LENGTH,
        description="Required plain-text readable correction without surrounding LaTeX delimiters.",
    )
    correction_latex: str | None = Field(
        default=None,
        max_length=MAX_CORRECTION_LATEX_LENGTH,
        description=(
            "Optional mathematical LaTeX expression for the correction without surrounding "
            "$, $$, \\(...\\), or \\[...\\] delimiters, or null when not applicable."
        ),
    )
    spoken_alert: str = Field(
        min_length=1,
        max_length=MAX_SPOKEN_ALERT_LENGTH,
        description=(
            "One concise natural-speech alert sentence (max 180 chars) phrasing math, exponents, "
            "and units in plain spoken words without LaTeX markup or square-bracket tags."
        ),
    )
    explanation: str = Field(
        min_length=1,
        max_length=MAX_EXPLANATION_LENGTH,
        description="One concise sentence explaining the error and correction.",
    )
    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description="Model self-assessed confidence in [0.0, 1.0].",
    )

    @field_validator("detected_text")
    @classmethod
    def _validate_detected_text(cls, value: str) -> str:
        return _normalize_required_text(value, "detected_text", MAX_DETECTED_TEXT_LENGTH)

    @field_validator("correction_text")
    @classmethod
    def _validate_correction_text(cls, value: str) -> str:
        return _normalize_required_text(value, "correction_text", MAX_CORRECTION_TEXT_LENGTH)

    @field_validator("correction_latex")
    @classmethod
    def _validate_correction_latex(cls, value: str | None) -> str | None:
        if value is None:
            return None
        stripped = _strip_outer_latex_delimiters(value)
        if stripped is None:
            return None
        if len(stripped) > MAX_CORRECTION_LATEX_LENGTH:
            raise ValueError(
                f"correction_latex must not exceed {MAX_CORRECTION_LATEX_LENGTH} characters."
            )
        return stripped

    @field_validator("spoken_alert")
    @classmethod
    def _validate_spoken_alert(cls, value: str) -> str:
        return _normalize_required_text(value, "spoken_alert", MAX_SPOKEN_ALERT_LENGTH)

    @field_validator("explanation")
    @classmethod
    def _validate_explanation(cls, value: str) -> str:
        return _normalize_required_text(value, "explanation", MAX_EXPLANATION_LENGTH)

    @field_validator("confidence", mode="before")
    @classmethod
    def _validate_confidence(cls, value: object) -> float:
        if isinstance(value, bool) or not isinstance(value, int | float):
            raise ValueError("confidence must be a finite float.")
        num = float(value)
        if not math.isfinite(num) or not (0.0 <= num <= 1.0):
            raise ValueError("confidence must be finite and within [0.0, 1.0].")
        return num


def _validate_box_order(box_2d: list[int]) -> list[int]:
    if len(box_2d) != 4:
        raise ValueError("box_2d must have exactly four integers [ymin, xmin, ymax, xmax].")
    ymin, xmin, ymax, xmax = (_validate_box_int(coord) for coord in box_2d)
    if not (ymin < ymax):
        raise ValueError("box_2d must satisfy ymin < ymax.")
    if not (xmin < xmax):
        raise ValueError("box_2d must satisfy xmin < xmax.")
    return [ymin, xmin, ymax, xmax]


class DetectedError(_FindingBase):
    """Model-space finding whose box_2d refers to the processed JPEG sent to Gemini."""

    box_2d: Box2D = Field(
        description=(
            "Model-space bounding box [ymin, xmin, ymax, xmax] in 0..1000 relative to the "
            "exact processed image provided to the model."
        ),
    )

    @field_validator("box_2d", mode="before")
    @classmethod
    def _check_box_order(cls, value: object) -> list[int]:
        if not isinstance(value, list):
            raise ValueError("box_2d must be a list of four integers.")
        return _validate_box_order(value)


class SourceSpaceDetectedError(_FindingBase):
    """Source-space finding whose box_2d is projected into the canonical uploaded image."""

    box_2d: Box2D = Field(
        description=(
            "Source-space bounding box [ymin, xmin, ymax, xmax] in 0..1000 relative to the "
            "canonical upright, unmirrored uploaded image."
        ),
    )

    @field_validator("box_2d", mode="before")
    @classmethod
    def _check_box_order(cls, value: object) -> list[int]:
        if not isinstance(value, list):
            raise ValueError("box_2d must be a list of four integers.")
        return _validate_box_order(value)


class BoardAnalysisResult(StrictModel):
    """Complete structured output returned by the Gemini model in model image coordinates."""

    board_summary: str = Field(
        default="",
        max_length=MAX_BOARD_SUMMARY_LENGTH,
        description=(
            "At most two short sentences describing currently visible work; "
            "empty string if the board is blank or illegible."
        ),
    )
    errors: list[DetectedError] = Field(
        default_factory=list,
        max_length=MAX_FINDINGS,
        description=(
            "List of at most 20 high-confidence demonstrable math, physics, or spelling errors "
            "currently visible in the image; empty list when none are justified."
        ),
    )

    @field_validator("board_summary")
    @classmethod
    def _validate_board_summary(cls, value: str) -> str:
        trimmed = value.strip()
        if len(trimmed) > MAX_BOARD_SUMMARY_LENGTH:
            raise ValueError(
                f"board_summary must not exceed {MAX_BOARD_SUMMARY_LENGTH} characters."
            )
        return trimmed

    @model_validator(mode="after")
    def _validate_errors_count(self) -> BoardAnalysisResult:
        if len(self.errors) > MAX_FINDINGS:
            raise ValueError(f"At most {MAX_FINDINGS} errors are allowed per analysis.")
        return self


class AnalysisResponse(StrictModel):
    """HTTP response returned to the browser in canonical source-image coordinates."""

    request_id: str = Field(description="UUID echoed from the validated request metadata.")
    board_summary: str = Field(
        max_length=MAX_BOARD_SUMMARY_LENGTH,
        description="Concise summary of the currently visible board.",
    )
    errors: list[SourceSpaceDetectedError] = Field(
        max_length=MAX_FINDINGS,
        description=(
            "Validated findings projected into canonical upright uploaded-image coordinates."
        ),
    )
    image_width: int = Field(gt=0, description="Width in pixels of the upright uploaded image.")
    image_height: int = Field(gt=0, description="Height in pixels of the upright uploaded image.")
    latency_ms: int = Field(ge=0, description="Nonnegative server elapsed latency in milliseconds.")


class SpeechRequest(StrictModel):
    """Client text-to-speech synthesis request generated from an alert sentence."""

    text: str = Field(
        min_length=1,
        max_length=MAX_SPEECH_TEXT_LENGTH,
        description="Plain-language spoken alert sentence to synthesize.",
    )

    @field_validator("text")
    @classmethod
    def _validate_text(cls, value: str) -> str:
        return _normalize_required_text(value, "text", MAX_SPEECH_TEXT_LENGTH)


class HealthResponse(StrictModel):
    """Process health and configuration availability flags without upstream probing."""

    status: Literal["ok"] = "ok"
    analysis_configured: bool
    speech_configured: bool = False
    credentials_verified: Literal[False] = False


class BoardDetectionResponse(StrictModel):
    """Automatic OpenCV board boundary detection result in source-image 0..1000 coordinates."""

    detected: bool
    corners: list[tuple[float, float]] | None = Field(default=None, min_length=4, max_length=4)
    confidence: float = Field(default=0.0, ge=0.0, le=1.0)


class ErrorEnvelope(StrictModel):
    """Consistent error envelope returned for all backend HTTP failures."""

    code: str
    message: str
    request_id: str | None = None
