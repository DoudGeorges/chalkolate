"""Strict Pydantic v2 schemas separating request, model-space, and source-space contracts."""

from __future__ import annotations

import math
from typing import Annotated, Literal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

ErrorCategory = Literal["math", "physics", "spelling", "factual"]
AnswerFormat = Literal["exact", "fraction", "decimal3"]

MAX_PREV_SUMMARY_LENGTH = 2000
MAX_BOARD_SUMMARY_LENGTH = 600
MAX_FINDINGS = 20
MAX_DETECTED_TEXT_LENGTH = 300
MAX_CORRECTION_TEXT_LENGTH = 300
MAX_CORRECTION_LATEX_LENGTH = 300
MAX_SPOKEN_ALERT_LENGTH = 180
MAX_EXPLANATION_LENGTH = 300
MAX_SPEECH_TEXT_LENGTH = 240
VOICE_KEY_PATTERN = r"^[A-Za-z0-9_-]{1,128}$"

MAX_NOTES_CONTEXT_SECTIONS = 120
MAX_NOTES_UPDATES = 8
MAX_NOTE_ID_LENGTH = 40
MAX_NOTE_HEADING_LENGTH = 120
MAX_NOTE_BODY_LENGTH = 3000
MAX_NOTES_TITLE_LENGTH = 160
# Whole notes-context JSON sent with a snapshot; client trims older bodies to fit.
MAX_NOTES_METADATA_BYTES = 48 * 1024


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


def _validate_corners_list(
    value: list[tuple[float, float]] | None,
) -> list[tuple[float, float]] | None:
    if value is None:
        return None
    if len(value) != 4:
        raise ValueError("corners must contain exactly four [x, y] points.")
    validated: list[tuple[float, float]] = []
    for point in value:
        if len(point) != 2:
            raise ValueError("Each corner must contain exactly two coordinates [x, y].")
        validated.append((_validate_finite_coord(point[0]), _validate_finite_coord(point[1])))
    return validated


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
    answer_format: AnswerFormat = Field(
        default="exact",
        description=(
            "How numeric values in corrections are written: exact (symbolic, e.g. sqrt(2)/2), "
            "fraction (reduced fractions), or decimal3 (decimals rounded to 3 places)."
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

    speech_style: Literal["student", "professor"] = Field(
        default="student", description="Wording of spoken corrections for this snapshot."
    )

    @model_validator(mode="before")
    @classmethod
    def _discard_legacy_role(cls, data: object) -> object:
        # Tabs opened before the speech style update can still send this field.
        if (
            isinstance(data, dict)
            and "role" in data
            and data["role"] in (None, "student", "professor")
        ):
            return {key: value for key, value in data.items() if key != "role"}
        return data

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
        return _validate_corners_list(value)


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
        description=(
            "Use math for mathematics (including false mathematical statements), logic, or code. "
            "Use physics for physical science or engineering, spelling for clear spelling or "
            "grammar errors, and factual for any other demonstrably false assertion."
        ),
    )
    detected_text: str = Field(
        min_length=1,
        max_length=MAX_DETECTED_TEXT_LENGTH,
        description="Exact visible span inside box_2d that the replacement corrects.",
    )
    correction_text: str = Field(
        min_length=1,
        max_length=MAX_CORRECTION_TEXT_LENGTH,
        description="Plain-text replacement for exactly detected_text, omitting unchanged context.",
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
            "One short spoken sentence identifying the mistake and stating the correction. "
            "Use spoken words for symbols and units. Put the reason in explanation."
        ),
    )
    explanation: str = Field(
        min_length=1,
        max_length=MAX_EXPLANATION_LENGTH,
        description="One plain-language sentence with the reason, calculation, or counterexample.",
    )
    confidence: float = Field(
        ge=0.0,
        le=1.0,
        description="Confidence in both the reading and the verified correction, from 0 to 1.",
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


def _validate_box_order(value: object) -> list[int]:
    if not isinstance(value, list):
        raise ValueError("box_2d must be a list of four integers.")
    if len(value) != 4:
        raise ValueError("box_2d must have exactly four integers [ymin, xmin, ymax, xmax].")
    ymin, xmin, ymax, xmax = (_validate_box_int(coord) for coord in value)
    if not (ymin < ymax):
        raise ValueError("box_2d must satisfy ymin < ymax.")
    if not (xmin < xmax):
        raise ValueError("box_2d must satisfy xmin < xmax.")
    return [ymin, xmin, ymax, xmax]


class DetectedError(_FindingBase):
    """Model-space finding whose box_2d refers to the processed JPEG sent to Gemini."""

    box_2d: Box2D = Field(
        description=(
            "Tight box around the actual erroneous ink in detected_text. Exclude correct "
            "neighbors. Use [ymin, xmin, ymax, xmax] in 0..1000 on the provided image."
        ),
    )

    @field_validator("box_2d", mode="before")
    @classmethod
    def _check_box_order(cls, value: object) -> list[int]:
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
        return _validate_box_order(value)


class BoardAnalysisResult(StrictModel):
    """Complete structured output returned by the Gemini model in model image coordinates."""

    board_summary: str = Field(
        max_length=MAX_BOARD_SUMMARY_LENGTH,
        description=(
            "One short sentence describing currently visible work, "
            "or an empty string if the board is blank or illegible."
        ),
    )
    errors: list[DetectedError] = Field(
        max_length=MAX_FINDINGS,
        description=(
            "Up to 20 distinct, demonstrable mistakes from the current image, including false "
            "written assertions, or empty when none are justified."
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

    voice: str = Field(
        default="default",
        pattern=VOICE_KEY_PATTERN,
        description=(
            "'default' for the backend-configured voice, or an ElevenLabs voice ID listed by "
            "/api/voices for this account."
        ),
    )

    @field_validator("text")
    @classmethod
    def _validate_text(cls, value: str) -> str:
        return _normalize_required_text(value, "text", MAX_SPEECH_TEXT_LENGTH)


NoteId = Annotated[
    str,
    Field(
        min_length=1,
        max_length=MAX_NOTE_ID_LENGTH,
        pattern=r"^[A-Za-z0-9_-]+$",
        description="Stable section identifier: letters, digits, underscore, or hyphen.",
    ),
]


class NotesSectionContext(StrictModel):
    """One previously built notes section echoed back to the model as untrusted context."""

    id: NoteId
    heading: str = Field(max_length=MAX_NOTE_HEADING_LENGTH)
    body_markdown: str = Field(default="", max_length=MAX_NOTE_BODY_LENGTH)


class NotesMetadata(StrictModel):
    """Client metadata for an incremental notes update, sent as JSON beside the image."""

    request_id: UUID = Field(description="Client-generated UUID correlating this notes request.")
    sections: list[NotesSectionContext] = Field(
        default_factory=list,
        max_length=MAX_NOTES_CONTEXT_SECTIONS,
        description="Notes built so far, in order. Older bodies may be empty to save space.",
    )
    corners: list[tuple[float, float]] | None = Field(
        default=None,
        min_length=4,
        max_length=4,
        description="Optional TL, TR, BR, BL calibration quad normalized to 0..1000.",
    )

    @field_validator("corners")
    @classmethod
    def _validate_corners(
        cls, value: list[tuple[float, float]] | None
    ) -> list[tuple[float, float]] | None:
        return _validate_corners_list(value)


class NoteSectionUpdate(StrictModel):
    """Create-or-replace instruction for a single notes section."""

    id: NoteId = Field(
        description=(
            "Existing section id to rewrite in place, or a new short unique id "
            "(e.g. 'sec-7') to append a section."
        ),
    )
    heading: str = Field(
        min_length=1,
        max_length=MAX_NOTE_HEADING_LENGTH,
        description="Short plain-text section heading.",
    )
    body_markdown: str = Field(
        min_length=1,
        max_length=MAX_NOTE_BODY_LENGTH,
        description=(
            "Section content as concise Markdown for students. Use $...$ for inline math and "
            "$$...$$ for display math (KaTeX-compatible LaTeX). No HTML."
        ),
    )
    has_figure: bool = Field(
        description=(
            "True only when this section depends on a diagram, graph, or drawing that the "
            "text cannot convey, in which case the client attaches a snapshot."
        ),
    )
    figure_box_2d: Box2D | None = Field(
        default=None,
        description=(
            "When has_figure is true: tight box [ymin, xmin, ymax, xmax] in 0..1000 around the "
            "diagram/graph/drawing in the provided image (include labels, exclude surrounding "
            "text), else null. The server converts it to source-image coordinates."
        ),
    )
    after_section_id: NoteId | None = Field(
        default=None,
        description=(
            "For a NEW section: id of the section it should follow, or null to append at the "
            "end. Ignored when rewriting an existing section."
        ),
    )

    @field_validator("figure_box_2d", mode="before")
    @classmethod
    def _check_figure_box(cls, value: object) -> list[int] | None:
        if value is None:
            return None
        return _validate_box_order(value)

    @field_validator("heading", "body_markdown")
    @classmethod
    def _strip_nonempty(cls, value: str) -> str:
        cleaned = value.strip()
        if not cleaned:
            raise ValueError("Text must not be empty.")
        return cleaned


class BoardNotesResult(StrictModel):
    """Structured model output: only the sections that changed for this snapshot."""

    lecture_title: str = Field(
        default="",
        max_length=MAX_NOTES_TITLE_LENGTH,
        description="Short lecture title if evident from the board, else empty string.",
    )
    updates: list[NoteSectionUpdate] = Field(
        default_factory=list,
        max_length=MAX_NOTES_UPDATES,
        description=(
            "At most 8 create-or-replace section updates, or empty when the board adds nothing "
            "new to the notes."
        ),
    )

    @field_validator("lecture_title")
    @classmethod
    def _trim_title(cls, value: str) -> str:
        return value.strip()


class NotesResponse(StrictModel):
    """HTTP response for an incremental notes update."""

    request_id: str
    lecture_title: str = Field(max_length=MAX_NOTES_TITLE_LENGTH)
    updates: list[NoteSectionUpdate] = Field(max_length=MAX_NOTES_UPDATES)
    latency_ms: int = Field(ge=0)


class SpeechVoiceOption(StrictModel):
    """Selectable ElevenLabs voice advertised to the client settings UI."""

    id: str = Field(pattern=VOICE_KEY_PATTERN)
    label: str = Field(min_length=1, max_length=80)


class VoicesResponse(StrictModel):
    """Voices available to the configured ElevenLabs account, with 'default' always first."""

    voices: list[SpeechVoiceOption]


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
