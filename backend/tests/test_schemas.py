"""Tests for strict Pydantic v2 contracts and JSON Schema completeness."""

from __future__ import annotations

import json
import math
from uuid import uuid4

import pytest
from pydantic import ValidationError

from schemas import (
    AnalysisMetadata,
    AnalysisResponse,
    BoardAnalysisResult,
    BoardDetectionResponse,
    DetectedError,
    SourceSpaceDetectedError,
)


def _valid_finding_dict(**overrides: object) -> dict[str, object]:
    base: dict[str, object] = {
        "category": "math",
        "detected_text": "(a + b)^2 = a^2 + b^2",
        "correction_text": "(a + b)^2 = a^2 + 2ab + b^2",
        "correction_latex": "(a + b)^2 = a^2 + 2ab + b^2",
        "spoken_alert": "Missing middle term 2ab when expanding a plus b squared.",
        "explanation": "Expanding (a + b)^2 requires the cross term 2ab.",
        "box_2d": [100, 120, 200, 620],
        "confidence": 0.94,
    }
    base.update(overrides)
    return base


def test_analysis_metadata_valid_and_unknown_fields_rejected() -> None:
    req_id = str(uuid4())
    payload = json.dumps(
        {
            "request_id": req_id,
            "previous_board_summary": "Quadratic expansion",
            "corners": [[10, 10], [990, 10], [990, 990], [10, 990]],
        }
    )
    parsed = AnalysisMetadata.model_validate_json(payload)
    assert str(parsed.request_id) == req_id
    assert parsed.previous_board_summary == "Quadratic expansion"

    bad_extra = json.dumps({"request_id": req_id, "deep_mode": True})
    with pytest.raises(ValidationError):
        AnalysisMetadata.model_validate_json(bad_extra)

    bad_subject = json.dumps({"request_id": req_id, "subject_hint": "math"})
    with pytest.raises(ValidationError):
        AnalysisMetadata.model_validate_json(bad_subject)

    bad_dismissed = json.dumps({"request_id": req_id, "dismissed_errors": ["abc"]})
    with pytest.raises(ValidationError):
        AnalysisMetadata.model_validate_json(bad_dismissed)


def test_analysis_metadata_bounds_and_invalid_corners() -> None:
    req_id = str(uuid4())

    with pytest.raises(ValidationError):
        AnalysisMetadata.model_validate_json(
            json.dumps({"request_id": req_id, "previous_board_summary": "x" * 2001})
        )

    with pytest.raises(ValidationError):
        AnalysisMetadata.model_validate_json(
            json.dumps(
                {
                    "request_id": req_id,
                    "corners": [[0, 0], [1001, 0], [1000, 1000], [0, 1000]],
                }
            )
        )

    with pytest.raises(ValidationError):
        AnalysisMetadata(
            request_id=uuid4(),
            corners=[(0.0, 0.0), (math.nan, 0.0), (100.0, 100.0), (0.0, 100.0)],
        )

    det_ok = BoardDetectionResponse(
        detected=True,
        corners=[(100.0, 100.0), (900.0, 100.0), (900.0, 900.0), (100.0, 900.0)],
        confidence=0.88,
    )
    assert det_ok.detected is True
    det_none = BoardDetectionResponse(detected=False, corners=None, confidence=0.0)
    assert det_none.corners is None


def test_detected_error_bounds_delimiters_and_box_validation() -> None:
    # Strips outer LaTeX delimiters cleanly
    err = DetectedError.model_validate(_valid_finding_dict(correction_latex="$$x^2 + 2xy + y^2$$"))
    assert err.correction_latex == "x^2 + 2xy + y^2"

    err_inline = DetectedError.model_validate(_valid_finding_dict(correction_latex=r"\(F = ma\)"))
    assert err_inline.correction_latex == "F = ma"

    err_empty_latex = DetectedError.model_validate(_valid_finding_dict(correction_latex="   "))
    assert err_empty_latex.correction_latex is None

    # Shorter bound for spoken_alert (>180 rejected)
    with pytest.raises(ValidationError):
        DetectedError.model_validate(_valid_finding_dict(spoken_alert="a" * 181))

    # Invalid box ordering, out-of-range, bools, floats
    for bad_box in (
        [200, 100, 200, 300],
        [300, 100, 200, 300],
        [100, 300, 200, 300],
        [100, 300, 200, 250],
        [-1, 100, 200, 300],
        [100, 100, 1001, 300],
        [100, 100, 200],
        [True, 100, 200, 300],
        [100.5, 100, 200, 300],
    ):
        with pytest.raises(ValidationError):
            DetectedError.model_validate(_valid_finding_dict(box_2d=bad_box))

    # Invalid confidence
    for bad_conf in (-0.01, 1.01, True):
        with pytest.raises(ValidationError):
            DetectedError.model_validate(_valid_finding_dict(confidence=bad_conf))


def test_board_analysis_result_max_findings_and_malformed_json() -> None:
    many_errors = [_valid_finding_dict() for _ in range(21)]
    with pytest.raises(ValidationError):
        BoardAnalysisResult.model_validate({"board_summary": "ok", "errors": many_errors})

    with pytest.raises(ValidationError):
        BoardAnalysisResult.model_validate({"board_summary": "x" * 601, "errors": []})

    with pytest.raises(ValidationError):
        DetectedError.model_validate(_valid_finding_dict(explanation="x" * 301))

    with pytest.raises(ValidationError):
        BoardAnalysisResult.model_validate_json('{"board_summary": "unterminated')

    # Distinct coordinate-space types reject mixing model-space DetectedError in AnalysisResponse
    model_finding = DetectedError.model_validate(_valid_finding_dict())
    source_finding = SourceSpaceDetectedError.model_validate(_valid_finding_dict())
    resp = AnalysisResponse(
        request_id=str(uuid4()),
        board_summary="Test board",
        errors=[source_finding],
        image_width=1280,
        image_height=720,
        latency_ms=42,
    )
    assert len(resp.errors) == 1
    assert model_finding.box_2d == source_finding.box_2d


def test_model_json_schema_has_descriptions_on_every_model_visible_field() -> None:
    schema = BoardAnalysisResult.model_json_schema()
    props = schema["properties"]
    assert "description" in props["board_summary"]
    assert "description" in props["errors"]
    defs = schema.get("$defs", {})
    err_props = defs["DetectedError"]["properties"]
    for field_name in (
        "category",
        "detected_text",
        "correction_text",
        "correction_latex",
        "spoken_alert",
        "explanation",
        "box_2d",
        "confidence",
    ):
        assert "description" in err_props[field_name], f"Missing description on {field_name}"
