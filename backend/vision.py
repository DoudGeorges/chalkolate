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
AUTO_ENHANCE_L_STD = 45.0

BOARD_DETECT_MAX_EDGE = 640
BOARD_DETECT_MIN_AREA_FRAC = 0.10
BOARD_DETECT_MAX_AREA_FRAC = 0.965
BOARD_DETECT_MAX_ASPECT = 4.0
BOARD_DETECT_MIN_ANGLE_DEG = 45.0
BOARD_DETECT_MAX_ANGLE_DEG = 135.0
BOARD_DETECT_MIN_SIDE_RATIO = 0.45
BOARD_DETECT_ACCEPT_SCORE = 0.45


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


@dataclass(frozen=True)
class BoardDetectionResult:
    """Outcome of lightweight automatic board quadrilateral corner detection."""

    detected: bool
    corners: list[tuple[float, float]] | None
    confidence: float


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


def _auto_enhance(bgr: BGRImage) -> BGRImage:
    """Automatically enhance low-contrast boards (LAB L-channel std < 45) using L-only CLAHE.

    High-contrast frames (whiteboards/projected slides with crisp strokes) are returned
    unchanged using a fast strided luma check so normal boards pay minimal preprocessing cost.
    """
    sample_bgr = np.ascontiguousarray(
        bgr[::4, ::4] if bgr.shape[0] >= 16 and bgr.shape[1] >= 16 else bgr
    )
    sample_lab = cv2.cvtColor(sample_bgr, cv2.COLOR_BGR2LAB)
    if float(np.std(sample_lab[:, :, 0])) >= AUTO_ENHANCE_L_STD:
        return bgr

    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    l_channel, a_channel, b_channel = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
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
        resized = bgr

    sx = model_w / float(src_width)
    sy = model_h / float(src_height)
    h_cont = np.diag([sx, sy, 1.0]).astype(np.float64)
    h_cont_inv = np.diag([1.0 / sx, 1.0 / sy, 1.0]).astype(np.float64)
    return resized, h_cont, h_cont_inv


def prepare_image(
    raw_bytes: bytes,
    *,
    corners: Sequence[tuple[float, float]] | None,
    max_image_pixels: int,
    max_long_edge: int,
) -> PreparedImage:
    """Decode upright image, apply calibration/resize and auto enhancement, and encode JPEG."""
    bgr = decode_upright_bgr(raw_bytes, max_image_pixels=max_image_pixels)
    src_height, src_width = bgr.shape[:2]

    if corners is not None:
        processed, h_cont, h_cont_inv = _compute_calibrated_warp(bgr, corners, max_long_edge)
    else:
        processed, h_cont, h_cont_inv = _compute_uncalibrated_resize(bgr, max_long_edge)

    processed = _auto_enhance(processed)

    ok, encoded = cv2.imencode(".jpg", processed, [int(cv2.IMWRITE_JPEG_QUALITY), 90])
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


def _order_quad_tl_tr_br_bl(pts: PointArray) -> PointArray | None:
    """Order 4 working-space points canonically as TL, TR, BR, BL."""
    if pts.shape != (4, 2) or not np.all(np.isfinite(pts)):
        return None
    by_y = pts[np.argsort(pts[:, 1])]
    top_pair = by_y[:2]
    bottom_pair = by_y[2:]
    top_sorted = top_pair[np.argsort(top_pair[:, 0])]
    bottom_sorted = bottom_pair[np.argsort(bottom_pair[:, 0])]
    ordered = np.array(
        [top_sorted[0], top_sorted[1], bottom_sorted[1], bottom_sorted[0]],
        dtype=np.float64,
    )
    return ordered


def _pixel_quad_to_norm(
    pts: PointArray,
    width: int,
    height: int,
) -> list[tuple[float, float]]:
    return [
        (
            round(max(0.0, min(1000.0, float(pts[i, 0]) * 1000.0 / width)), 1),
            round(max(0.0, min(1000.0, float(pts[i, 1]) * 1000.0 / height)), 1),
        )
        for i in range(4)
    ]


def _quad_geometry_metrics(
    pts: PointArray,
    width: int,
    height: int,
) -> tuple[float, float] | None:
    """Return (area_fraction, max_angle_deviation_deg) if quad passes board geometry filters."""
    xs = pts[:, 0]
    ys = pts[:, 1]
    area_px = 0.5 * abs(float(np.dot(xs, np.roll(ys, -1)) - np.dot(ys, np.roll(xs, -1))))
    area_frac = area_px / float(width * height)
    if not (BOARD_DETECT_MIN_AREA_FRAC <= area_frac <= BOARD_DETECT_MAX_AREA_FRAC):
        return None

    top_len = float(np.linalg.norm(pts[1] - pts[0]))
    right_len = float(np.linalg.norm(pts[2] - pts[1]))
    bottom_len = float(np.linalg.norm(pts[2] - pts[3]))
    left_len = float(np.linalg.norm(pts[3] - pts[0]))

    raw_w = max(top_len, bottom_len)
    raw_h = max(left_len, right_len)
    if min(top_len, bottom_len, left_len, right_len) < 16.0:
        return None
    if max(raw_w, raw_h) / max(1.0, min(raw_w, raw_h)) > BOARD_DETECT_MAX_ASPECT:
        return None
    if min(top_len, bottom_len) / max(1.0, raw_w) < BOARD_DETECT_MIN_SIDE_RATIO:
        return None
    if min(left_len, right_len) / max(1.0, raw_h) < BOARD_DETECT_MIN_SIDE_RATIO:
        return None

    max_dev = 0.0
    for i in range(4):
        p_prev = pts[(i - 1) % 4]
        p_curr = pts[i]
        p_next = pts[(i + 1) % 4]
        v1 = p_prev - p_curr
        v2 = p_next - p_curr
        denom = float(np.linalg.norm(v1) * np.linalg.norm(v2))
        if denom <= 1e-6:
            return None
        cos_val = max(-1.0, min(1.0, float(np.dot(v1, v2)) / denom))
        angle_deg = math.degrees(math.acos(cos_val))
        if not (BOARD_DETECT_MIN_ANGLE_DEG <= angle_deg <= BOARD_DETECT_MAX_ANGLE_DEG):
            return None
        max_dev = max(max_dev, abs(90.0 - angle_deg))

    return (area_frac, max_dev)


def _extract_contour_quads(
    binary_map: NDArray[np.uint8],
    img_area: float,
) -> list[PointArray]:
    contours, _ = cv2.findContours(binary_map, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return []

    scored_contours: list[tuple[float, NDArray[np.int32]]] = []
    min_area = 0.08 * img_area
    for contour in contours:
        area = float(cv2.contourArea(contour))
        if area >= min_area:
            scored_contours.append((area, cast(NDArray[np.int32], contour)))

    scored_contours.sort(key=lambda item: item[0], reverse=True)
    quads: list[PointArray] = []
    for area, contour in scored_contours[:12]:
        hull = cast(NDArray[np.int32], cv2.convexHull(contour))
        peri = float(cv2.arcLength(hull, True))
        if peri <= 0.0:
            continue
        for eps in (0.015, 0.025, 0.04, 0.06):
            approx = cv2.approxPolyDP(hull, eps * peri, True)
            if len(approx) == 4:
                quads.append(approx.reshape(4, 2).astype(np.float64))
                break

        rect = cv2.minAreaRect(hull)
        rect_w, rect_h = rect[1]
        rect_area = float(rect_w * rect_h)
        if rect_area > 0.0 and area / rect_area >= 0.80:
            box = cv2.boxPoints(rect).astype(np.float64)
            quads.append(box)
    return quads


def _intersect_lines(
    line_a: tuple[float, float, float, float],
    line_b: tuple[float, float, float, float],
) -> tuple[float, float] | None:
    x1, y1, x2, y2 = line_a
    x3, y3, x4, y4 = line_b
    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 1e-6:
        return None
    px = ((x1 * y2 - y1 * x2) * (x3 - x4) - (x1 - x2) * (x3 * y4 - y3 * x4)) / denom
    py = ((x1 * y2 - y1 * x2) * (y3 - y4) - (y1 - y2) * (x3 * y4 - y3 * x4)) / denom
    if not (math.isfinite(px) and math.isfinite(py)):
        return None
    return (px, py)


def _extract_hough_quads(
    edges: NDArray[np.uint8],
    width: int,
    height: int,
) -> list[PointArray]:
    min_dim = min(width, height)
    raw_lines = cv2.HoughLinesP(
        edges,
        rho=1.0,
        theta=math.pi / 180.0,
        threshold=max(36, min_dim // 10),
        minLineLength=max(32, min_dim // 5),
        maxLineGap=max(12, min_dim // 25),
    )
    if raw_lines is None:
        return []

    top_lines: list[tuple[float, tuple[float, float, float, float]]] = []
    bottom_lines: list[tuple[float, tuple[float, float, float, float]]] = []
    left_lines: list[tuple[float, tuple[float, float, float, float]]] = []
    right_lines: list[tuple[float, tuple[float, float, float, float]]] = []

    half_h = height * 0.5
    half_w = width * 0.5
    for row in raw_lines.reshape(-1, 4):
        x1, y1, x2, y2 = (float(row[0]), float(row[1]), float(row[2]), float(row[3]))
        dx = x2 - x1
        dy = y2 - y1
        length = math.hypot(dx, dy)
        if length < 20.0:
            continue
        angle = abs(math.degrees(math.atan2(dy, dx)))
        if angle > 90.0:
            angle = 180.0 - angle

        seg = (x1, y1, x2, y2)
        if angle <= 26.0:
            mid_y = 0.5 * (y1 + y2)
            if mid_y < half_h:
                top_lines.append((length, seg))
            else:
                bottom_lines.append((length, seg))
        elif angle >= 64.0:
            mid_x = 0.5 * (x1 + x2)
            if mid_x < half_w:
                left_lines.append((length, seg))
            else:
                right_lines.append((length, seg))

    if not (top_lines and bottom_lines and left_lines and right_lines):
        return []

    top_best = [seg for _, seg in sorted(top_lines, key=lambda item: item[0], reverse=True)[:2]]
    bottom_best = [
        seg for _, seg in sorted(bottom_lines, key=lambda item: item[0], reverse=True)[:2]
    ]
    left_best = [seg for _, seg in sorted(left_lines, key=lambda item: item[0], reverse=True)[:2]]
    right_best = [seg for _, seg in sorted(right_lines, key=lambda item: item[0], reverse=True)[:2]]

    quads: list[PointArray] = []
    for top_seg in top_best:
        for bot_seg in bottom_best:
            for left_seg in left_best:
                for right_seg in right_best:
                    tl = _intersect_lines(top_seg, left_seg)
                    tr = _intersect_lines(top_seg, right_seg)
                    br = _intersect_lines(bot_seg, right_seg)
                    bl = _intersect_lines(bot_seg, left_seg)
                    if tl is None or tr is None or br is None or bl is None:
                        continue
                    candidate = np.array([tl, tr, br, bl], dtype=np.float64)
                    if (
                        np.all(candidate[:, 0] >= -4.0)
                        and np.all(candidate[:, 0] <= width + 4.0)
                        and np.all(candidate[:, 1] >= -4.0)
                        and np.all(candidate[:, 1] <= height + 4.0)
                    ):
                        candidate[:, 0] = np.clip(candidate[:, 0], 0.0, float(width))
                        candidate[:, 1] = np.clip(candidate[:, 1], 0.0, float(height))
                        quads.append(candidate)
    return quads


def _compute_color_gradients(
    bgr_smooth: BGRImage,
) -> tuple[NDArray[np.float64], NDArray[np.float64], NDArray[np.float64]]:
    """Compute per-pixel dominant directional Sobel gradient across BGR channels."""
    channels = cv2.split(bgr_smooth)
    best_gx = np.zeros(bgr_smooth.shape[:2], dtype=np.float64)
    best_gy = np.zeros(bgr_smooth.shape[:2], dtype=np.float64)
    best_mag_sq = np.zeros(bgr_smooth.shape[:2], dtype=np.float64)

    for channel in channels:
        gx = cv2.Sobel(channel, cv2.CV_64F, 1, 0, ksize=3)
        gy = cv2.Sobel(channel, cv2.CV_64F, 0, 1, ksize=3)
        mag_sq = gx * gx + gy * gy
        mask = mag_sq > best_mag_sq
        best_gx = np.where(mask, gx, best_gx)
        best_gy = np.where(mask, gy, best_gy)
        best_mag_sq = np.where(mask, mag_sq, best_mag_sq)

    return best_gx, best_gy, np.sqrt(best_mag_sq)


def _score_board_quad(
    pts: PointArray,
    *,
    gx: NDArray[np.float64],
    gy: NDArray[np.float64],
    grad_mag: NDArray[np.float64],
    lab_float: NDArray[np.float64],
    area_frac: float,
    max_angle_dev: float,
) -> float:
    """Score a board candidate in [0, 1] using aligned edge support, contrast, and geometry."""
    height, width = grad_mag.shape[:2]
    t_vals = np.linspace(0.06, 0.94, 40)
    band_offsets = (-2.0, -1.0, 0.0, 1.0, 2.0)

    side_supports: list[float] = []
    side_contrasts: list[float] = []

    for i in range(4):
        p0 = pts[i]
        p1 = pts[(i + 1) % 4]
        edge_vec = p1 - p0
        edge_len = float(np.linalg.norm(edge_vec))
        if edge_len <= 1.0:
            return 0.0

        tx = float(edge_vec[0]) / edge_len
        ty = float(edge_vec[1]) / edge_len
        # For clockwise vertices in image coordinates (x right, y down), (ty, -tx) points outward.
        nx = ty
        ny = -tx

        base_x = p0[0] + t_vals * edge_vec[0]
        base_y = p0[1] + t_vals * edge_vec[1]

        best_aligned = np.zeros_like(t_vals, dtype=np.float64)
        for off in band_offsets:
            sx = np.rint(base_x + off * nx).astype(np.int64)
            sy = np.rint(base_y + off * ny).astype(np.int64)
            valid = (sx >= 2) & (sx <= width - 3) & (sy >= 2) & (sy <= height - 3)
            if not np.any(valid):
                continue
            vx = sx[valid]
            vy = sy[valid]
            mag = grad_mag[vy, vx]
            dot = np.abs(gx[vy, vx] * nx + gy[vy, vx] * ny)
            cos_align = np.where(mag > 1e-6, dot / np.maximum(mag, 1e-6), 0.0)
            # Divide 3x3 Sobel magnitude by 4 to normalize into approximate intensity-step units.
            aligned_step = (mag * 0.25) * (cos_align * cos_align)
            best_aligned[valid] = np.maximum(best_aligned[valid], aligned_step)

        # Require meaningful step edges above sensor noise (~6 intensity units).
        support_curve = np.clip((best_aligned - 5.0) / 18.0, 0.0, 1.0)
        side_supports.append(float(np.mean(support_curve)))

        in_x = np.rint(base_x - 6.0 * nx).astype(np.int64)
        in_y = np.rint(base_y - 6.0 * ny).astype(np.int64)
        out_x = np.rint(base_x + 6.0 * nx).astype(np.int64)
        out_y = np.rint(base_y + 6.0 * ny).astype(np.int64)
        pair_valid = (
            (in_x >= 0)
            & (in_x < width)
            & (in_y >= 0)
            & (in_y < height)
            & (out_x >= 0)
            & (out_x < width)
            & (out_y >= 0)
            & (out_y < height)
        )
        if np.any(pair_valid):
            diff = (
                lab_float[in_y[pair_valid], in_x[pair_valid]]
                - lab_float[out_y[pair_valid], out_x[pair_valid]]
            )
            delta_e = np.linalg.norm(diff, axis=1)
            side_contrasts.append(float(np.mean(np.clip((delta_e - 4.0) / 28.0, 0.0, 1.0))))
        else:
            side_contrasts.append(0.0)

    mean_edge = sum(side_supports) / 4.0
    min_edge = min(side_supports)
    strong_sides = sum(1 for val in side_supports if val >= 0.30)
    if strong_sides < 3 or mean_edge < 0.38 or min_edge < 0.12:
        return 0.0

    mean_contrast = sum(side_contrasts) / 4.0
    area_prior = min(1.0, area_frac / 0.55)
    rect_score = max(0.0, 1.0 - max_angle_dev / 45.0)
    geom_score = 0.65 * area_prior + 0.35 * rect_score

    score = 0.55 * mean_edge + 0.15 * min_edge + 0.15 * mean_contrast + 0.15 * geom_score
    return max(0.0, min(1.0, score))


def detect_board_corners(
    raw_bytes: bytes,
    *,
    max_image_pixels: int,
) -> BoardDetectionResult:
    """Detect the four corners of a whiteboard, chalkboard, or projected screen via OpenCV.

    Returns canonical [TL, TR, BR, BL] normalized [0..1000] coordinates when a board boundary
    is confidently detected, or detected=False when no reliable quadrilateral boundary exists.
    """
    bgr = decode_upright_bgr(raw_bytes, max_image_pixels=max_image_pixels)
    src_h, src_w = bgr.shape[:2]
    long_edge = max(src_w, src_h)
    if long_edge > BOARD_DETECT_MAX_EDGE:
        scale = BOARD_DETECT_MAX_EDGE / float(long_edge)
        work_w = max(1, round(src_w * scale))
        work_h = max(1, round(src_h * scale))
        work = cast(BGRImage, cv2.resize(bgr, (work_w, work_h), interpolation=cv2.INTER_AREA))
    else:
        work = bgr
        work_h, work_w = src_h, src_w

    if work_w < 32 or work_h < 32:
        return BoardDetectionResult(detected=False, corners=None, confidence=0.0)

    bgr_smooth = cast(BGRImage, cv2.bilateralFilter(work, 7, 50, 50))
    lab = cv2.cvtColor(bgr_smooth, cv2.COLOR_BGR2LAB)
    lab_float = lab.astype(np.float64)
    l_channel = cast(NDArray[np.uint8], lab[:, :, 0])

    gx, gy, grad_mag = _compute_color_gradients(bgr_smooth)

    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    l_clahe = cast(NDArray[np.uint8], clahe.apply(l_channel))

    close_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    img_area = float(work_w * work_h)
    raw_candidates: list[PointArray] = []

    # 1. Multi-threshold Canny edge proposals across raw L, CLAHE L, and color gradient map.
    grad_u8 = np.clip(grad_mag * 0.5, 0.0, 255.0).astype(np.uint8)
    edge_sources: list[tuple[NDArray[np.uint8], int, int]] = [
        (l_channel, 30, 100),
        (l_channel, 60, 160),
        (l_clahe, 35, 110),
        (grad_u8, 25, 80),
    ]
    primary_edges: NDArray[np.uint8] | None = None
    for idx, (src_gray, low_t, high_t) in enumerate(edge_sources):
        edges = cast(NDArray[np.uint8], cv2.Canny(src_gray, low_t, high_t))
        if idx == 0:
            primary_edges = edges
        closed = cast(NDArray[np.uint8], cv2.morphologyEx(edges, cv2.MORPH_CLOSE, close_kernel))
        raw_candidates.extend(_extract_contour_quads(closed, img_area))

    # 2. Bright-board and dark-board Otsu segmentation masks (skipped on nearly flat frames).
    if float(np.std(l_channel)) >= 10.0:
        _, bright_mask = cv2.threshold(l_channel, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
        dark_mask = cast(NDArray[np.uint8], cv2.bitwise_not(bright_mask))
        morph_sz = max(5, round(min(work_w, work_h) * 0.02)) | 1
        morph_kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (morph_sz, morph_sz))
        for mask in (cast(NDArray[np.uint8], bright_mask), dark_mask):
            filled = cast(NDArray[np.uint8], cv2.morphologyEx(mask, cv2.MORPH_CLOSE, morph_kernel))
            cleaned = cast(
                NDArray[np.uint8], cv2.morphologyEx(filled, cv2.MORPH_OPEN, morph_kernel)
            )
            raw_candidates.extend(_extract_contour_quads(cleaned, img_area))

    # 3. Line-intersection fallback for boards partially occluded along one edge.
    if primary_edges is not None:
        raw_candidates.extend(_extract_hough_quads(primary_edges, work_w, work_h))

    best_score = 0.0
    best_corners: list[tuple[float, float]] | None = None
    seen_keys: set[tuple[tuple[int, int], ...]] = set()

    for raw_pts in raw_candidates:
        ordered = _order_quad_tl_tr_br_bl(raw_pts)
        if ordered is None:
            continue
        geom = _quad_geometry_metrics(ordered, work_w, work_h)
        if geom is None:
            continue

        norm_corners = _pixel_quad_to_norm(ordered, work_w, work_h)
        dedupe_key = tuple((round(x / 8.0), round(y / 8.0)) for x, y in norm_corners)
        if dedupe_key in seen_keys:
            continue
        seen_keys.add(dedupe_key)

        try:
            validate_calibration_corners(norm_corners)
        except InvalidCalibrationError:
            continue

        area_frac, max_angle_dev = geom
        score = _score_board_quad(
            ordered,
            gx=gx,
            gy=gy,
            grad_mag=grad_mag,
            lab_float=lab_float,
            area_frac=area_frac,
            max_angle_dev=max_angle_dev,
        )
        if score > best_score:
            best_score = score
            best_corners = norm_corners

    if best_corners is None or best_score < BOARD_DETECT_ACCEPT_SCORE:
        return BoardDetectionResult(detected=False, corners=None, confidence=0.0)

    return BoardDetectionResult(
        detected=True,
        corners=best_corners,
        confidence=round(best_score, 3),
    )
