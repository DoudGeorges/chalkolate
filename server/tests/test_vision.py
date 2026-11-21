"""Tests for image decoding, EXIF normalization, calibration, homography, and projection."""

from __future__ import annotations

import io
import math

import cv2
import numpy as np
import pytest
from PIL import Image

from schemas import DetectedError
from vision import (
    CorruptImageError,
    ImagePixelLimitError,
    InvalidCalibrationError,
    PreparedImage,
    ProjectionError,
    UnsupportedImageFormatError,
    _auto_enhance,
    cont_px_to_norm,
    decode_upright_bgr,
    detect_board_corners,
    norm_to_cont_px,
    prepare_image,
    project_box_to_source,
    project_finding_to_source,
    validate_calibration_corners,
)


def _encode_pil_bytes(img: Image.Image, fmt: str = "PNG") -> bytes:
    buf = io.BytesIO()
    img.save(buf, format=fmt)
    return buf.getvalue()


def test_decode_rejects_unsupported_corrupt_and_oversized_images() -> None:
    # GIF is unsupported
    gif_bytes = _encode_pil_bytes(Image.new("RGB", (64, 48), color=(10, 20, 30)), fmt="GIF")
    with pytest.raises(UnsupportedImageFormatError):
        decode_upright_bgr(gif_bytes, max_image_pixels=100_000)

    # Arbitrary non-image bytes
    with pytest.raises(UnsupportedImageFormatError):
        decode_upright_bgr(b"not an image at all", max_image_pixels=100_000)

    # Truncated PNG
    valid_png = _encode_pil_bytes(Image.new("RGB", (64, 64), color=(10, 20, 30)), fmt="PNG")
    with pytest.raises(CorruptImageError):
        decode_upright_bgr(valid_png[: len(valid_png) // 2], max_image_pixels=100_000)

    # Exceeds pixel limit BEFORE full decode
    big_png = _encode_pil_bytes(Image.new("RGB", (200, 200), color=(0, 0, 0)), fmt="PNG")
    with pytest.raises(ImagePixelLimitError):
        decode_upright_bgr(big_png, max_image_pixels=10_000)


def test_decode_applies_exif_orientation_to_upright() -> None:
    # Create a 120x60 landscape image with EXIF Orientation=6 (rotate 90 CW => upright 60x120)
    raw_img = Image.new("RGB", (120, 60), color=(20, 40, 60))
    exif = Image.Exif()
    exif[0x0112] = 6
    buf = io.BytesIO()
    raw_img.save(buf, format="JPEG", exif=exif.tobytes())

    bgr = decode_upright_bgr(buf.getvalue(), max_image_pixels=1_000_000)
    assert bgr.shape == (120, 60, 3)


def test_calibration_validation_rejects_degenerate_and_misordered_quads() -> None:
    # Valid tilted quad
    pts = validate_calibration_corners([(100, 120), (880, 90), (920, 900), (80, 860)])
    assert pts.shape == (4, 2)

    invalid_cases: list[list[tuple[float, float]]] = [
        # Swapped TL/TR (does NOT silently reorder)
        [(900, 100), (100, 100), (900, 900), (100, 900)],
        # Counter-clockwise order
        [(100, 100), (100, 900), (900, 900), (900, 100)],
        # Self-intersecting bowtie
        [(100, 100), (900, 900), (900, 100), (100, 900)],
        # Nearly collinear
        [(100, 100), (500, 105), (900, 110), (100, 800)],
        # Negligible area / tiny separation
        [(100, 100), (110, 100), (110, 110), (100, 110)],
        # Out of bounds
        [(-5, 100), (900, 100), (900, 900), (100, 900)],
        # Nonfinite
        [(math.nan, 100), (900, 100), (900, 900), (100, 900)],
    ]
    for bad in invalid_cases:
        with pytest.raises(InvalidCalibrationError):
            validate_calibration_corners(bad)


def test_identity_calibration_and_uncalibrated_preserve_geometry_and_borders() -> None:
    # Nonsquare 800x500 image with distinct colored 2px borders
    img = np.zeros((500, 800, 3), dtype=np.uint8)
    img[:, :] = (30, 30, 30)
    img[0:2, :] = (0, 255, 0)
    img[-2:, :] = (255, 0, 0)
    img[:, 0:2] = (0, 0, 255)
    img[:, -2:] = (255, 255, 0)
    pil = Image.fromarray(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
    raw_bytes = _encode_pil_bytes(pil, fmt="PNG")

    identity_prepared = prepare_image(
        raw_bytes,
        corners=[(0.0, 0.0), (1000.0, 0.0), (1000.0, 1000.0), (0.0, 1000.0)],
        max_image_pixels=10_000_000,
        max_long_edge=1280,
    )
    assert identity_prepared.source_width == 800
    assert identity_prepared.source_height == 500
    assert identity_prepared.model_width == 800
    assert identity_prepared.model_height == 500
    assert np.allclose(identity_prepared.forward_homography, np.eye(3))
    assert np.allclose(identity_prepared.inverse_homography, np.eye(3))

    decoded_model = decode_upright_bgr(identity_prepared.jpeg_bytes, max_image_pixels=10_000_000)
    assert decoded_model.shape == (500, 800, 3)
    # Border pixel colors survive JPEG encoding without 0.5px clipping drift
    assert int(decoded_model[0, 400, 1]) > 180  # green top border
    assert int(decoded_model[499, 400, 0]) > 180  # blue-channel BGR bottom border

    # Round-trip exact box
    assert project_box_to_source([100, 200, 400, 600], identity_prepared) == [100, 200, 400, 600]

    # Oversized uncalibrated nonsquare image (2560x1440) scales down to 1280x720 without upscaling
    large = Image.new("RGB", (2560, 1440), color=(40, 50, 60))
    large_prepared = prepare_image(
        _encode_pil_bytes(large, fmt="PNG"),
        corners=None,
        max_image_pixels=10_000_000,
        max_long_edge=1280,
    )
    assert large_prepared.source_width == 2560
    assert large_prepared.source_height == 1440
    assert large_prepared.model_width == 1280
    assert large_prepared.model_height == 720
    assert project_box_to_source([250, 125, 750, 875], large_prepared) == [250, 125, 750, 875]


def test_skewed_homography_roundtrip_and_four_corner_vs_diagonal_projection() -> None:
    # Build nonsquare 1200x800 source image with a strongly skewed quadrilateral
    src_w, src_h = 1200, 800
    canvas = np.full((src_h, src_w, 3), 25, dtype=np.uint8)

    # Trapezoidal board quad in normalized source space [0..1000]
    corners_norm = [(180.0, 120.0), (880.0, 200.0), (940.0, 860.0), (80.0, 740.0)]
    src_poly = np.array(
        [norm_to_cont_px(x, y, src_w, src_h) for x, y in corners_norm],
        dtype=np.int32,
    )
    cv2.fillConvexPoly(canvas, src_poly, (200, 200, 200))

    raw_bytes = _encode_pil_bytes(Image.fromarray(canvas), fmt="PNG")
    prepared = prepare_image(
        raw_bytes,
        corners=corners_norm,
        max_image_pixels=10_000_000,
        max_long_edge=1280,
    )

    # Forward-project a rectangle in model space and verify all 4 transformed source corners
    # sit strictly inside the returned axis-aligned source enclosure.
    model_box = [200, 250, 600, 750]
    source_box = project_box_to_source(model_box, prepared)
    ymin_s, xmin_s, ymax_s, xmax_s = source_box

    x0, y0 = norm_to_cont_px(
        float(model_box[1]), float(model_box[0]), prepared.model_width, prepared.model_height
    )
    x1, y1 = norm_to_cont_px(
        float(model_box[3]), float(model_box[2]), prepared.model_width, prepared.model_height
    )
    four_model_corners = np.array(
        [[x0, y0, 1.0], [x1, y0, 1.0], [x1, y1, 1.0], [x0, y1, 1.0]],
        dtype=np.float64,
    )
    transformed = (prepared.inverse_homography @ four_model_corners.T).T
    src_norms = [
        cont_px_to_norm(
            float(pt[0] / pt[2]),
            float(pt[1] / pt[2]),
            prepared.source_width,
            prepared.source_height,
        )
        for pt in transformed
    ]

    for nx, ny in src_norms:
        assert xmin_s <= nx + 1e-9
        assert xmax_s >= nx - 1e-9
        assert ymin_s <= ny + 1e-9
        assert ymax_s >= ny - 1e-9

    # Demonstrate why 4-corner projection matters: top-right & bottom-left corners can extend
    # horizontally beyond the top-left..bottom-right diagonal pair under trapezoid skew.
    diag_min_x = min(src_norms[0][0], src_norms[2][0])
    diag_max_x = max(src_norms[0][0], src_norms[2][0])
    all_min_x = min(nx for nx, _ in src_norms)
    all_max_x = max(nx for nx, _ in src_norms)
    assert all_min_x < diag_min_x or all_max_x > diag_max_x

    # Point round-trip test using forward and inverse homographies
    sample_src_px = norm_to_cont_px(500.0, 500.0, src_w, src_h)
    fwd = prepared.forward_homography @ np.array([sample_src_px[0], sample_src_px[1], 1.0])
    model_px = np.array([fwd[0] / fwd[2], fwd[1] / fwd[2], 1.0])
    back = prepared.inverse_homography @ model_px
    rec_px = (back[0] / back[2], back[1] / back[2])
    assert math.isclose(rec_px[0], sample_src_px[0], abs_tol=1e-4)
    assert math.isclose(rec_px[1], sample_src_px[1], abs_tol=1e-4)


def test_projection_rejects_nonfinite_horizon_and_collapsed_boxes() -> None:
    bad_inv = np.array(
        [
            [1.0, 0.0, 0.0],
            [0.0, 1.0, 0.0],
            [0.0, 0.0, 0.0],  # w = 0 everywhere
        ],
        dtype=np.float64,
    )
    prepared = PreparedImage(
        jpeg_bytes=b"123",
        source_width=1000,
        source_height=1000,
        model_width=1000,
        model_height=1000,
        forward_homography=np.eye(3, dtype=np.float64),
        inverse_homography=bad_inv,
    )
    with pytest.raises(ProjectionError):
        project_box_to_source([100, 100, 200, 200], prepared)

    # Offscreen box that clamps entirely outside [0, 1000] collapses to empty width/height
    shifted_inv = np.array(
        [
            [1.0, 0.0, 5000.0],
            [0.0, 1.0, 5000.0],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )
    offscreen = PreparedImage(
        jpeg_bytes=b"123",
        source_width=1000,
        source_height=1000,
        model_width=1000,
        model_height=1000,
        forward_homography=np.eye(3, dtype=np.float64),
        inverse_homography=shifted_inv,
    )
    with pytest.raises(ProjectionError):
        project_box_to_source([100, 100, 200, 200], offscreen)

    # Valid finding projection preserves all text fields
    identity_prep = PreparedImage(
        jpeg_bytes=b"123",
        source_width=1000,
        source_height=1000,
        model_width=1000,
        model_height=1000,
        forward_homography=np.eye(3, dtype=np.float64),
        inverse_homography=np.eye(3, dtype=np.float64),
    )
    finding = DetectedError(
        category="spelling",
        detected_text="Acceleraton",
        correction_text="Acceleration",
        correction_latex=None,
        spoken_alert="Misspelling of acceleration.",
        explanation="The letter i is missing in acceleration.",
        box_2d=[10, 20, 30, 40],
        confidence=0.91,
    )
    projected = project_finding_to_source(finding, identity_prep)
    assert projected.box_2d == [10, 20, 30, 40]
    assert projected.detected_text == "Acceleraton"


def test_auto_enhance_improves_low_contrast_and_preserves_high_contrast() -> None:
    # Low-contrast chalkboard (L std < 45) gets LAB L-channel CLAHE boost
    low = np.full((240, 320, 3), 50, dtype=np.uint8)
    cv2.putText(low, "F = ma", (40, 140), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (72, 72, 72), 3)
    low_enhanced = _auto_enhance(low)
    assert low_enhanced.shape == low.shape
    assert float(low_enhanced.std()) > float(low.std())

    # High-contrast whiteboard/slide (L std >= 45) passes through pixel-identical
    high = np.full((240, 320, 3), 245, dtype=np.uint8)
    high[:, :160] = (20, 20, 20)
    high_out = _auto_enhance(high)
    assert np.array_equal(high_out, high)


def test_detect_board_corners_whiteboard_chalkboard_perspective_and_fallback() -> None:
    # 1. Whiteboard on darker wall with writing inside
    wb = np.full((600, 800, 3), 65, dtype=np.uint8)
    cv2.rectangle(wb, (120, 90), (680, 510), (244, 245, 247), thickness=-1)
    cv2.rectangle(wb, (120, 90), (680, 510), (160, 165, 170), thickness=3)
    cv2.putText(
        wb, "(a+b)^2 = a^2 + b^2", (180, 280), cv2.FONT_HERSHEY_SIMPLEX, 1.1, (25, 25, 35), 2
    )
    wb_bytes = _encode_pil_bytes(Image.fromarray(cv2.cvtColor(wb, cv2.COLOR_BGR2RGB)), fmt="PNG")
    wb_res = detect_board_corners(wb_bytes, max_image_pixels=5_000_000)
    assert wb_res.detected is True
    assert wb_res.corners is not None
    assert wb_res.confidence >= 0.45
    expected_wb = [(150.0, 150.0), (850.0, 150.0), (850.0, 850.0), (150.0, 850.0)]
    for actual, exp in zip(wb_res.corners, expected_wb, strict=True):
        assert abs(actual[0] - exp[0]) <= 35.0
        assert abs(actual[1] - exp[1]) <= 35.0

    # 2. Dark green chalkboard on a light wall with chalk text
    cb = np.full((600, 800, 3), 215, dtype=np.uint8)
    cv2.rectangle(cb, (96, 108), (704, 492), (42, 68, 38), thickness=-1)
    cv2.putText(cb, "F = m * a", (250, 310), cv2.FONT_HERSHEY_SIMPLEX, 1.3, (235, 235, 230), 2)
    cb_bytes = _encode_pil_bytes(Image.fromarray(cv2.cvtColor(cb, cv2.COLOR_BGR2RGB)), fmt="PNG")
    cb_res = detect_board_corners(cb_bytes, max_image_pixels=5_000_000)
    assert cb_res.detected is True
    assert cb_res.corners is not None
    expected_cb = [(120.0, 180.0), (880.0, 180.0), (880.0, 820.0), (120.0, 820.0)]
    for actual, exp in zip(cb_res.corners, expected_cb, strict=True):
        assert abs(actual[0] - exp[0]) <= 35.0
        assert abs(actual[1] - exp[1]) <= 35.0

    # 3. Perspective-skewed board trapezoid
    skew = np.full((600, 800, 3), 55, dtype=np.uint8)
    poly_px = np.array([[140, 110], [670, 160], [720, 490], [90, 450]], dtype=np.int32)
    cv2.fillConvexPoly(skew, poly_px, (240, 240, 242))
    skew_bytes = _encode_pil_bytes(
        Image.fromarray(cv2.cvtColor(skew, cv2.COLOR_BGR2RGB)), fmt="PNG"
    )
    skew_res = detect_board_corners(skew_bytes, max_image_pixels=5_000_000)
    assert skew_res.detected is True
    assert skew_res.corners is not None
    expected_skew = [
        (140 * 1000 / 800, 110 * 1000 / 600),
        (670 * 1000 / 800, 160 * 1000 / 600),
        (720 * 1000 / 800, 490 * 1000 / 600),
        (90 * 1000 / 800, 450 * 1000 / 600),
    ]
    for actual, exp in zip(skew_res.corners, expected_skew, strict=True):
        assert abs(actual[0] - exp[0]) <= 40.0
        assert abs(actual[1] - exp[1]) <= 40.0

    # 4. Uniform wall returns detected=False honestly
    flat = np.full((480, 640, 3), 130, dtype=np.uint8)
    flat_bytes = _encode_pil_bytes(Image.fromarray(flat), fmt="PNG")
    flat_res = detect_board_corners(flat_bytes, max_image_pixels=5_000_000)
    assert flat_res.detected is False
    assert flat_res.corners is None
    assert flat_res.confidence == 0.0

    # 5. Cluttered non-board scene (random circles) returns detected=False
    clutter = np.full((480, 640, 3), 120, dtype=np.uint8)
    rng = np.random.default_rng(42)
    for _ in range(35):
        cx = int(rng.integers(20, 620))
        cy = int(rng.integers(20, 460))
        rad = int(rng.integers(12, 48))
        col = tuple(int(v) for v in rng.integers(30, 230, size=3))
        cv2.circle(clutter, (cx, cy), rad, col, thickness=-1)
    clutter_bytes = _encode_pil_bytes(
        Image.fromarray(cv2.cvtColor(clutter, cv2.COLOR_BGR2RGB)), fmt="PNG"
    )
    clutter_res = detect_board_corners(clutter_bytes, max_image_pixels=5_000_000)
    assert clutter_res.detected is False
    assert clutter_res.corners is None
