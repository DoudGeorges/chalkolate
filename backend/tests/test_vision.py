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
    cont_px_to_norm,
    decode_upright_bgr,
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
        enhance_chalkboard=False,
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
        enhance_chalkboard=False,
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
        enhance_chalkboard=False,
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


def test_enhance_chalkboard_applies_clahe_in_lab_luminance() -> None:
    # Low-contrast grayscale board image
    img = np.full((240, 320, 3), 50, dtype=np.uint8)
    cv2.putText(img, "F = ma", (40, 140), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (72, 72, 72), 3)
    raw = _encode_pil_bytes(Image.fromarray(img), fmt="PNG")

    plain = prepare_image(
        raw,
        corners=None,
        enhance_chalkboard=False,
        max_image_pixels=1_000_000,
        max_long_edge=1280,
    )
    enhanced = prepare_image(
        raw,
        corners=None,
        enhance_chalkboard=True,
        max_image_pixels=1_000_000,
        max_long_edge=1280,
    )
    plain_bgr = decode_upright_bgr(plain.jpeg_bytes, max_image_pixels=1_000_000)
    enh_bgr = decode_upright_bgr(enhanced.jpeg_bytes, max_image_pixels=1_000_000)

    assert enh_bgr.shape == plain_bgr.shape
    assert float(enh_bgr.std()) > float(plain_bgr.std())
