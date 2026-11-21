# AGENTS.md — Chalkolate Architecture & Invariants

## Repository Layout

- `backend/` — Stateless Python 3.12+ FastAPI service (`uv`-managed, `backend/uv.lock`).
  - `backend/config.py`: Resolves `REPO_ROOT/.env` and `BACKEND_DIR/.env` independently of the launch working directory (`load_dotenv(..., override=False)`), validates all numeric/CORS settings, and redacts `gemini_api_key` in `__repr__`.
  - `backend/schemas.py`: Strict Pydantic v2 contracts (`extra="forbid"`, `allow_inf_nan=False`) with field descriptions on all model-visible fields. Separates model-space `DetectedError` (used only in `BoardAnalysisResult`) from canonical source-space `SourceSpaceDetectedError` (used only in `AnalysisResponse`).
  - `backend/vision.py`: Safe Pillow decoding with pre-decode pixel cap (`ImagePixelLimitError`) and `exif_transpose`, explicit RGB/BGR/LAB conversions, strict TL/TR/BR/BL convex calibration validation without reordering, `getPerspectiveTransform`/`warpPerspective` using OpenCV pixel-center adjustment (`M_cv = T(-0.5) @ H_cont @ T(+0.5)`), optional L-channel CLAHE (`enhance_chalkboard`), JPEG encoding (`max_long_edge = 1280`, no upscaling), and 4-corner inverse projection with outward rounding and clamping.
  - `backend/analyzer.py`: Async Gemini inference via `client.aio.models.generate_content`, `ThinkingLevel.LOW` (normal) / `MEDIUM` (Deep Mode), `response_mime_type="application/json"`, `response_json_schema`, bounded `max_output_tokens`, millisecond `HttpOptions(timeout=...)`, no `temperature`/`top_p`/`top_k`, explicit handling of blocks/truncation/malformed JSON/API errors, and heuristic `confidence >= 0.85` filtering.
  - `backend/main.py`: FastAPI lifespan managing a single `genai.Client` (`aio.aclose()` + `close()`), `RequestBodyLimitMiddleware` enforcing upload limits on both `Content-Length` and streamed bodies before multipart parsing, non-blocking `ConcurrencyGate`, `GET /api/health` (no Gemini probe), `POST /api/analyze` offloading OpenCV/Pillow to `asyncio.to_thread`, and consistent `ErrorEnvelope` responses without logging secrets, image frames, or raw provider text.
- `frontend/` — React 19 + TypeScript + Vite + Tailwind CSS v4 studio (`frontend/package-lock.json`).
  - `frontend/src/api/schemas.ts` & `client.ts`: Zod runtime validation of all `/api/health`, `/api/analyze`, and `ErrorEnvelope` payloads; typed errors with `Retry-After` extraction; relative `/api/*` URLs via Vite proxy.
  - `frontend/src/lib/geometry.ts`: `object-contain` `ContainedImageRect` calculation, letterbox-excluding pointer mapping, strict TL/TR/BR/BL quad validation, normalized quad pixel masks, and clamped HTML pill positioning.
  - `frontend/src/lib/frameCapture.ts` & `sampleBoard.ts`: Low-res (~160px long edge) grayscale sampling, masked MAD comparison, upright JPEG capture (max 1280px, no upscaling), and synthetic sample chalkboard generation.
  - `frontend/src/lib/issueTracker.ts`: Deterministic one-to-one matching on `(category, normalized_text, spatial IoU/center-distance)` preserving mathematical case/signs/exponents/units, bounded history (`MAX_TRACKED_HISTORY = 120`), session-scoped dismissals with Undo/Reset, and Mark Fixed (`verifying` / `no_longer_detected` / failure rollback).
  - `frontend/src/hooks/useMediaSource.ts`: Secure-context/capability checks, camera/screen/media lifecycle, stale stream cancellation, track `ended`, `devicechange`, video `resize`/`seeked`, and object URL/track cleanup.
  - `frontend/src/hooks/useSpeechAlerts.ts`: `window.speechSynthesis` feature detection, separate queued vs started utterance tracking (marks spoken only on `onstart`), GC-safe utterance retention, cancellation on invalidation/pause/dismissal/unmount, and fallback error surfacing.
  - `frontend/src/hooks/useBoardMonitor.ts`: Explicit `useReducer` state machine (`PAUSED | WATCHING | WRITING | STABILIZING | ANALYZING`), Strict-Mode-safe 400ms loop, motion hysteresis, quiet-window drift gating, single-flight + coalesced pending intent (`manual` > `auto`), generation/revision/settings ownership checks before committing results/errors, and retry-storm prevention.
  - `frontend/src/components/`: `HeaderBar`, `ControlBar`, `StageViewport`, `DetectionOverlay` (`SVG viewBox="0 0 1000 1000"` + separate HTML pills, colors `#f43f5e` / `#f59e0b` / `#38bdf8`), `CalibrationOverlay`, `FindingsSidebar`, `IssueCard`, and `MathCorrection` (`katex` with `trust: false`, guarded fallback).

## Key Engineering Invariants

1. **Coordinate Spaces**:
   - Canonical source coordinates are normalized `[0, 1000]` on the upright, unmirrored uploaded frame (`x_px = x * W / 1000`, `y_px = y * H / 1000`).
   - OpenCV pixel indices sit at centers `(i + 0.5, j + 0.5)`; `continuous_to_opencv_warp_matrix` converts continuous-bounds homographies via `T(-0.5) @ H_cont @ T(+0.5)` so identity calibration preserves every pixel and border identically.
   - Model `box_2d` coordinates always project all four corners through `inverse_homography`, validate `w > 1e-6` and finiteness, take source min/max, round outward, and clamp to `0..1000`. Perspective skew makes this source-space enclosure looser than the rectified box.
2. **Scheduling & Staleness**:
   - At most one in-flight `/api/analyze` request and one coalesced pending intent (`manual` overrides `auto`). Frames are captured at dispatch time.
   - Ordinary motion marks prior results stale and invalidates speech without aborting the active HTTP request; Pause, calibration edit, source change, deadline, and unmount abort locally.
   - Late completions (success or failure) failing source/frame/settings/request ownership never mutate findings, summary, baseline, status, or speech.
3. **Secrets & Privacy**:
   - `GEMINI_API_KEY` lives strictly on the backend environment; never add `VITE_*` secret variables or expose raw credentials/frames/model output in logs or HTTP error responses.

## Verified Commands

Run backend checks from `backend/`:
- `uv run ruff check .`
- `uv run ruff format --check .`
- `uv run mypy .`
- `uv run pytest -v`

Run frontend checks from `frontend/`:
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
