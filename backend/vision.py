"""Image decoding, perspective calibration, CLAHE enhancement, and coordinate projection."""

from __future__ import annotations

import io
import math
from collections.abc import Sequence
from dataclasses import dataclass
from typing import cast

import cv2
import numpy as np
from numpy.typing import NDArray
from PIL import Image, ImageOps, UnidentifiedImageError

from schemas import DetectedError, SourceSpaceDetectedError

BGRImage = NDArray[np.uint8]
RGBImage = NDArray[np.uint8]
HomographyMatrix = NDArray[np.float64]
PointArray = NDArray[np.float64]

SUPPORTED_PILLOW_FORMATS = frozenset({"JPEG", "PNG", "WEBP", "BMP"})
MIN_CORNER_SEPARATION_NORM = 20.0
MIN_CORNER_SIN = 0.08
MIN_QUAD_AREA_NORM = 2500.0
MIN_RECTIFIED_SIDE_PX = 16.0
HOMOGENEOUS_W_EPS = 1e-6
HOMOGRAPHY_MAX_NORM_COND = 1e6
ROUND_EPS = 1e-9


class VisionError(Exception):
    """Base class for image decoding, calibration, and coordinate projection failures."""


class UnsupportedImageFormatError(VisionError):
    """Raised when uploaded bytes are not a supported raster image format."""


class CorruptImageError(VisionError):
    """Raised when uploaded image bytes cannot be decoded cleanly."""


class ImagePixelLimitError(VisionError):
    """Raised when decoded image dimensions exceed the configured pixel budget."""


class InvalidCalibrationError(VisionError):
    """Raised when board calibration corners are invalid, misordered, or degenerate."""


class ProjectionError(VisionError):
    """Raised when a model-space box cannot be validly projected to source space."""


class ImageEncodingError(VisionError):
    """Raised when encoding the prepared JPEG fails."""


@dataclass(frozen=True)
class PreparedImage:
    """Prepared JPEG bytes plus exact forward/inverse continuous-space coordinate maps."""

    jpeg_bytes: bytes
    source_width: int
    source_height: int
    model_width: int
    model_height: int
    forward_homography: HomographyMatrix
    inverse_homography: HomographyMatrix


def norm_to_cont_px(
    norm_x: float,
    norm_y: float,
    width: int,
    height: int,
) -> tuple[float, float]:
    """Convert normalized [0, 1000] image coordinates into continuous pixel bounds."""
    return (norm_x * width / 1000.0, norm_y * height / 1000.0)


def cont_px_to_norm(
    px_x: float,
    px_y: float,
    width: int,
    height: int,
) -> tuple[float, float]:
    """Convert continuous pixel coordinates into normalized [0, 1000] bounds."""
    return (px_x * 1000.0 / width, px_y * 1000.0 / height)


def _translation_matrix(dx: float, dy: float) -> HomographyMatrix:
    return np.array(
        [
            [1.0, 0.0, dx],
            [0.0, 1.0, dy],
            [0.0, 0.0, 1.0],
        ],
        dtype=np.float64,
    )


def continuous_to_opencv_warp_matrix(h_cont: HomographyMatrix) -> HomographyMatrix:
    """Adjust continuous-bounds homography for OpenCV's pixel-center sampling convention.

    Continuous bounds place image edges at [0, W] x [0, H], while OpenCV warpPerspective
    samples integer pixel indices (i, j) whose centers sit at (i + 0.5, j + 0.5).
    Mapping pixel index -> continuous center (+0.5), applying H_cont, then shifting back
    (-0.5) guarantees an identity calibration leaves all pixels and borders unchanged.
    """
    return _translation_matrix(-0.5, -0.5) @ h_cont @ _translation_matrix(0.5, 0.5)


def decode_upright_bgr(raw_bytes: bytes, *, max_image_pixels: int) -> BGRImage:
    """Decode JPEG/PNG/WEBP/BMP bytes safely, apply EXIF orientation, and convert to BGR."""
    if not raw_bytes:
        raise CorruptImageError("Image payload is empty.")

    old_max_pixels = Image.MAX_IMAGE_PIXELS
    # Keep Pillow's decompression-bomb protection active at a high ceiling while avoiding
    # spurious DecompressionBombWarning when small test caps reject via ImagePixelLimitError.
    Image.MAX_IMAGE_PIXELS = max(max_image_pixels * 2, 50_000_000)
    try:
        try:
            with Image.open(io.BytesIO(raw_bytes)) as opened:
                fmt = (opened.format or "").upper()
                if fmt not in SUPPORTED_PILLOW_FORMATS:
                    raise UnsupportedImageFormatError(
                        f"Unsupported image format {fmt or 'unknown'}. "
                        "Allowed: JPEG, PNG, WEBP, BMP."
                    )

                width, height = opened.size
                if width <= 0 or height <= 0:
                    raise CorruptImageError("Image has nonpositive dimensions.")
                if width * height > max_image_pixels:
                    raise ImagePixelLimitError(
                        f"Image pixel count ({width * height}) exceeds limit ({max_image_pixels})."
                    )

                opened.load()
                upright = ImageOps.exif_transpose(opened)
                try:
                    u_w, u_h = upright.size
                    if u_w <= 0 or u_h <= 0:
                        raise CorruptImageError("Transposed image has nonpositive dimensions.")
                    if u_w * u_h > max_image_pixels:
                        raise ImagePixelLimitError(
                            f"Image pixel count ({u_w * u_h}) exceeds limit ({max_image_pixels})."
                        )
                    with upright.convert("RGB") as rgb_img:
                        rgb_array: RGBImage = np.asarray(rgb_img, dtype=np.uint8)
                finally:
                    if upright is not opened:
                        upright.close()
        except VisionError:
            raise
        except Image.DecompressionBombError as exc:
            raise ImagePixelLimitError("Image exceeds maximum safe pixel count.") from exc
        except UnidentifiedImageError as exc:
            raise UnsupportedImageFormatError(
                "Uploaded file is not a valid supported image."
            ) from exc
        except (OSError, SyntaxError, ValueError, EOFError) as exc:
            raise CorruptImageError("Uploaded image appears corrupt or truncated.") from exc
    finally:
        Image.MAX_IMAGE_PIXELS = old_max_pixels

    bgr = cast(BGRImage, cv2.cvtColor(rgb_array, cv2.COLOR_RGB2BGR))
    return bgr


def validate_calibration_corners(corners: Sequence[tuple[float, float]]) -> PointArray:
    """Validate 4 normalized corners strictly in TL, TR, BR, BL order without reordering."""
    if len(corners) != 4:
        raise InvalidCalibrationError("Calibration requires exactly four corners.")

    pts = np.empty((4, 2), dtype=np.float64)
    for idx, corner in enumerate(corners):
        if len(corner) != 2:
            raise InvalidCalibrationError("Each calibration corner must have two coordinates.")
        x, y = float(corner[0]), float(corner[1])
        if not (math.isfinite(x) and math.isfinite(y)):
            raise InvalidCalibrationError("Calibration corners must be finite numbers.")
        if not (0.0 <= x <= 1000.0 and 0.0 <= y <= 1000.0):
            raise InvalidCalibrationError("Calibration corners must lie within 0..1000.")
        pts[idx, 0] = x
        pts[idx, 1] = y

    # Minimum pairwise separation
    for i in range(4):
        for j in range(i + 1, 4):
            dist = float(np.linalg.norm(pts[i] - pts[j]))
            if dist < MIN_CORNER_SEPARATION_NORM:
                raise InvalidCalibrationError(
                    "Calibration corners are too close together to form a valid board region."
                )

    # Strict clockwise convexity in image coordinates (x right, y down => cross_z > 0)
    for i in range(4):
        p0 = pts[i]
        p1 = pts[(i + 1) % 4]
        p2 = pts[(i + 2) % 4]
        e1 = p1 - p0
        e2 = p2 - p1
        n1 = float(np.linalg.norm(e1))
        n2 = float(np.linalg.norm(e2))
        cross_z = float(e1[0] * e2[1] - e1[1] * e2[0])
        if cross_z <= 0.0:
            raise InvalidCalibrationError(
                "Calibration corners must be strictly convex and ordered TL, TR, BR, BL."
            )
        sin_theta = cross_z / (n1 * n2)
        if sin_theta < MIN_CORNER_SIN:
            raise InvalidCalibrationError(
                "Calibration corners are nearly collinear; adjust handles into a clear quad."
            )

    # Shoelace area in normalized units
    xs = pts[:, 0]
    ys = pts[:, 1]
    area = 0.5 * abs(float(np.dot(xs, np.roll(ys, -1)) - np.dot(ys, np.roll(xs, -1))))
    if area < MIN_QUAD_AREA_NORM:
        raise InvalidCalibrationError("Calibration quadrilateral area is too small.")

    # Enforce explicit TL, TR, BR, BL orientation without silently reordering invalid input.
    tl, tr, br, bl = pts[0], pts[1], pts[2], pts[3]
    if not (tr[0] > tl[0] and br[0] > bl[0] and bl[1] > tl[1] and br[1] > tr[1]):
        raise InvalidCalibrationError(
            "Calibration corners must follow TL, TR, BR, BL order without swapping sides."
        )

    return pts


def _apply_clahe_lab(bgr: BGRImage) -> BGRImage:
    """Apply CLAHE contrast enhancement strictly to the LAB luminance channel."""
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.5, tileGridSize=(8, 8))
    enhanced_l = clahe.apply(l_channel)
    merged_lab = cv2.merge((enhanced_l, a_channel, b_channel))
    return cast(BGRImage, cv2.cvtColor(merged_lab, cv2.COLOR_LAB2BGR))


def _normalize_inverse_sign(
    h_inv: HomographyMatrix,
    model_width: int,
    model_height: int,
) -> HomographyMatrix:
    center = np.array([model_width / 2.0, model_height / 2.0, 1.0], dtype=np.float64)
    projected_center = h_inv @ center
    w_center = float(projected_center[2])
    if not math.isfinite(w_center) or abs(w_center) <= HOMOGENEOUS_W_EPS:
        raise InvalidCalibrationError("Inverse perspective transform is singular at board center.")
    return -h_inv if w_center < 0.0 else h_inv


def _compute_calibrated_warp(
    bgr: BGRImage,
    corners: Sequence[tuple[float, float]],
    max_long_edge: int,
) -> tuple[BGRImage, HomographyMatrix, HomographyMatrix]:
    src_height, src_width = bgr.shape[:2]
    norm_pts = validate_calibration_corners(corners)

    src_cont = np.empty((4, 2), dtype=np.float64)
    for idx in range(4):
        src_cont[idx, 0], src_cont[idx, 1] = norm_to_cont_px(
            float(norm_pts[idx, 0]),
            float(norm_pts[idx, 1]),
            src_width,
            src_height,
        )

    top_len = float(np.linalg.norm(src_cont[1] - src_cont[0]))
    bottom_len = float(np.linalg.norm(src_cont[2] - src_cont[3]))
    left_len = float(np.linalg.norm(src_cont[3] - src_cont[0]))
    right_len = float(np.linalg.norm(src_cont[2] - src_cont[1]))

    raw_w = max(top_len, bottom_len)
    raw_h = max(left_len, right_len)
    if raw_w < MIN_RECTIFIED_SIDE_PX or raw_h < MIN_RECTIFIED_SIDE_PX:
        raise InvalidCalibrationError(
            "Selected board region is too small in pixels to rectify reliably."
        )

    # Preserve rectified aspect ratio and never upscale beyond natural edge length.
    scale = min(1.0, max_long_edge / max(raw_w, raw_h))
    model_w = max(16, round(raw_w * scale))
    model_h = max(16, round(raw_h * scale))

    dst_cont = np.array(
        [
            [0.0, 0.0],
            [float(model_w), 0.0],
            [float(model_w), float(model_h)],
            [0.0, float(model_h)],
        ],
        dtype=np.float64,
    )

    # Identity calibration fast path keeps exact float64 identity transform.
    if (
        np.allclose(src_cont, dst_cont, atol=1e-6)
        and model_w == src_width
        and model_h == src_height
    ):
        h_cont = np.eye(3, dtype=np.float64)
        h_cont_inv = np.eye(3, dtype=np.float64)
        return bgr.copy(), h_cont, h_cont_inv

    h_cont = cast(
        HomographyMatrix,
        cv2.getPerspectiveTransform(
            src_cont.astype(np.float32),
            dst_cont.astype(np.float32),
        ).astype(np.float64),
    )

    if not np.all(np.isfinite(h_cont)) or abs(float(np.linalg.det(h_cont))) <= 1e-12:
        raise InvalidCalibrationError("Perspective transform is singular or nonfinite.")

    # Check conditioning in scale-normalized unit coordinates [0, 1]^2.
    s_src = np.diag([1.0 / src_width, 1.0 / src_height, 1.0])
    s_dst = np.diag([1.0 / model_w, 1.0 / model_h, 1.0])
    h_unit = s_dst @ h_cont @ np.linalg.inv(s_src)
    cond = float(np.linalg.cond(h_unit))
    if not math.isfinite(cond) or cond > HOMOGRAPHY_MAX_NORM_COND:
        raise InvalidCalibrationError("Perspective transform is ill-conditioned; widen board quad.")

    try:
        h_cont_inv = cast(HomographyMatrix, np.linalg.inv(h_cont))
    except np.linalg.LinAlgError as exc:
        raise InvalidCalibrationError("Perspective transform is not invertible.") from exc

    if not np.all(np.isfinite(h_cont_inv)):
        raise InvalidCalibrationError("Inverse perspective transform is nonfinite.")

    h_cont_inv = _normalize_inverse_sign(h_cont_inv, model_w, model_h)

    m_cv = continuous_to_opencv_warp_matrix(h_cont)
    interpolation = cv2.INTER_AREA if scale < 0.75 else cv2.INTER_LINEAR
    warped = cast(
        BGRImage,
        cv2.warpPerspective(
            bgr,
            m_cv,
            (model_w, model_h),
            flags=interpolation,
            borderMode=cv2.BORDER_REPLICATE,
        ),
    )
    return warped, h_cont, h_cont_inv


def _compute_uncalibrated_resize(
    bgr: BGRImage,
    max_long_edge: int,
) -> tuple[BGRImage, HomographyMatrix, HomographyMatrix]:
    src_height, src_width = bgr.shape[:2]
    long_edge = max(src_width, src_height)
    scale = min(1.0, max_long_edge / long_edge)

    if scale < 1.0:
        model_w = max(1, round(src_width * scale))
        model_h = max(1, round(src_height * scale))
        resized = cast(
            BGRImage,
            cv2.resize(bgr, (model_w, model_h), interpolation=cv2.INTER_AREA),
        )
    else:
        model_w = src_width
        model_h = src_height
        resized = bgr.copy()

    sx = model_w / float(src_width)
    sy = model_h / float(src_height)
    h_cont = np.diag([sx, sy, 1.0]).astype(np.float64)
    h_cont_inv = np.diag([1.0 / sx, 1.0 / sy, 1.0]).astype(np.float64)
    return resized, h_cont, h_cont_inv


def prepare_image(
    raw_bytes: bytes,
    *,
    corners: Sequence[tuple[float, float]] | None,
    enhance_chalkboard: bool,
    max_image_pixels: int,
    max_long_edge: int,
) -> PreparedImage:
    """Decode upright image, apply calibration/resize and optional CLAHE, and encode JPEG."""
    bgr = decode_upright_bgr(raw_bytes, max_image_pixels=max_image_pixels)
    src_height, src_width = bgr.shape[:2]

    if corners is not None:
        processed, h_cont, h_cont_inv = _compute_calibrated_warp(bgr, corners, max_long_edge)
    else:
        processed, h_cont, h_cont_inv = _compute_uncalibrated_resize(bgr, max_long_edge)

    if enhance_chalkboard:
        processed = _apply_clahe_lab(processed)

    ok, encoded = cv2.imencode(".jpg", processed, [int(cv2.IMWRITE_JPEG_QUALITY), 88])
    if not ok or encoded.size == 0:
        raise ImageEncodingError("Failed to encode prepared board snapshot as JPEG.")

    model_height, model_width = processed.shape[:2]
    return PreparedImage(
        jpeg_bytes=encoded.tobytes(),
        source_width=src_width,
        source_height=src_height,
        model_width=model_width,
        model_height=model_height,
        forward_homography=h_cont,
        inverse_homography=h_cont_inv,
    )


def project_box_to_source(box_2d: Sequence[int], prepared: PreparedImage) -> list[int]:
    """Project a model-space [ymin, xmin, ymax, xmax] box into source-space [0..1000].

    All four corners of the model box are transformed through the inverse homography
    so perspective skew maps to the true axis-aligned enclosure in source coordinates.
    Under strong perspective skew, this axis-aligned enclosure is necessarily looser
    than the rectified box.
    """
    if len(box_2d) != 4:
        raise ProjectionError("box_2d must contain four coordinates.")

    ymin_norm, xmin_norm, ymax_norm, xmax_norm = (int(v) for v in box_2d)
    x0, y0 = norm_to_cont_px(
        float(xmin_norm), float(ymin_norm), prepared.model_width, prepared.model_height
    )
    x1, y1 = norm_to_cont_px(
        float(xmax_norm), float(ymax_norm), prepared.model_width, prepared.model_height
    )

    model_corners = np.array(
        [
            [x0, y0, 1.0],
            [x1, y0, 1.0],
            [x1, y1, 1.0],
            [x0, y1, 1.0],
        ],
        dtype=np.float64,
    )

    projected = (prepared.inverse_homography @ model_corners.T).T
    if not np.all(np.isfinite(projected)):
        raise ProjectionError("Projected bounding box produced nonfinite coordinates.")

    ws = projected[:, 2]
    if np.any(ws <= HOMOGENEOUS_W_EPS):
        raise ProjectionError("Projected bounding box crossed invalid homogeneous divisor.")

    src_xs_px = projected[:, 0] / ws
    src_ys_px = projected[:, 1] / ws

    src_xs_norm: list[float] = []
    src_ys_norm: list[float] = []
    for px_x, px_y in zip(src_xs_px, src_ys_px, strict=True):
        nx, ny = cont_px_to_norm(
            float(px_x),
            float(px_y),
            prepared.source_width,
            prepared.source_height,
        )
        if not (math.isfinite(nx) and math.isfinite(ny)):
            raise ProjectionError("Normalized source coordinates are nonfinite.")
        src_xs_norm.append(nx)
        src_ys_norm.append(ny)

    min_x = min(src_xs_norm)
    max_x = max(src_xs_norm)
    min_y = min(src_ys_norm)
    max_y = max(src_ys_norm)

    # Round outward with tiny float tolerance so exact integer round-trips do not drift.
    xmin_out = max(0, min(1000, math.floor(min_x + ROUND_EPS)))
    ymin_out = max(0, min(1000, math.floor(min_y + ROUND_EPS)))
    xmax_out = max(0, min(1000, math.ceil(max_x - ROUND_EPS)))
    ymax_out = max(0, min(1000, math.ceil(max_y - ROUND_EPS)))

    if not (ymin_out < ymax_out and xmin_out < xmax_out):
        raise ProjectionError("Projected source bounding box collapsed outside image bounds.")

    return [ymin_out, xmin_out, ymax_out, xmax_out]


def project_finding_to_source(
    finding: DetectedError,
    prepared: PreparedImage,
) -> SourceSpaceDetectedError:
    """Convert a validated model-space DetectedError into a source-space finding."""
    projected_box = project_box_to_source(finding.box_2d, prepared)
    return SourceSpaceDetectedError(
        category=finding.category,
        detected_text=finding.detected_text,
        correction_text=finding.correction_text,
        correction_latex=finding.correction_latex,
        spoken_alert=finding.spoken_alert,
        explanation=finding.explanation,
        box_2d=projected_box,
        confidence=finding.confidence,
    )
