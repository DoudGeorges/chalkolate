# Chalkolate 🍫

_Smarter than the front row._

## Description

Catches math, physics, and spelling mistakes in near-real time during lectures by monitoring live cameras, shared screens, and uploaded lecture videos.

## Problem

A missing minus sign, an incorrect unit, or a simple typo can completely change the result of a problem. Students often hesitate to interrupt the professor, so these mistakes can go unnoticed and end up in their notes, or waste valuable time when caught later.

## Solution

Chalkolate continuously watches the lecture board, identifies newly written content even while the presenter keeps moving, highlights mistakes directly on the video feed, and keeps corrections pinned until resolved or dismissed.

## Architecture & Privacy Notice

- **Stateless backend (`server/`, served by `api/index.py`)**: Accepts ordinary HTTP `multipart/form-data` snapshot uploads on `POST /api/analyze` (plus lightweight OpenCV corner detection on `POST /api/detect-board`), rectifies and auto-enhances low-contrast frames in memory, forwards the processed JPEG to Gemini (`gemini-3.8-flash`) via the official `google-genai` SDK, and projects findings back into canonical uploaded-image coordinates. When configured, `POST /api/speech` streams synthesized voice alerts from ElevenLabs (`eleven_v4_turbo`) over HTTPS without exposing keys to the browser.
- **Browser-owned session (`src/`, Next.js)**: Holds the active media stream or video playback, tile-based change detection, deduplicated persistent issue tracking with automatic resolution, dismissals, and sequential spoken alert playback (preferring ElevenLabs v4 Turbo streaming when configured, automatically falling back to `window.speechSynthesis`) without a database, WebSockets, or authentication.
- **External data disclosure**: Analyzed board snapshots (plus the optional `previous_board_summary` text) are sent to the Google Gemini API for inference, and spoken alert text is sent to ElevenLabs when ElevenLabs TTS is configured. Do not point Chalkolate at confidential or restricted material without appropriate approval.

## Prerequisites & Supported Versions

- **Python**: `>= 3.12, < 3.14` (managed via `uv`; `.python-version` pins `3.12`)
- **Node.js**: `>= 22.0.0` with `npm`
- **Gemini API key** (optional for preview/calibration/tests; required on the backend for live `POST /api/analyze` inference)
- **ElevenLabs API key & Voice ID** (optional; enables natural ElevenLabs v4 Turbo speech synthesis with automatic fallback to browser `window.speechSynthesis`. Note: Voice Library voices require a paid ElevenLabs plan; free-tier accounts can use any premade ElevenLabs voice ID.)

## Configuration

Copy `.env.example` to `.env` at the repository root (or inside `server/`):

```bash
cp .env.example .env
```

Key settings (process environment variables and `.env` values override defaults):
- `GEMINI_API_KEY`: Backend-only Gemini API key. Never expose secrets via `VITE_*` variables.
- `GEMINI_MODEL`: Gemini vision model ID (default `gemini-3.8-flash`).
- `GEMINI_THINKING_LEVEL`: Reasoning level (`minimal`, `low`, `medium`, `high`; default `low`, use `minimal` for lowest latency).
- `ELEVENLABS_API_KEY`: Backend-only ElevenLabs API key (optional; browser speech synthesis is used when unset or unavailable).
- `ELEVENLABS_MODEL_ID`: ElevenLabs speech model ID (default `eleven_v4_turbo`).
- `ELEVENLABS_VOICE_ID`: Target ElevenLabs voice identifier.
- `ANALYSIS_CONFIDENCE_THRESHOLD`: Product heuristic confidence cutoff (default `0.85`; not a calibrated probability).
- `MAX_MODEL_LONG_EDGE`: Maximum processed image dimension sent to Gemini (default `1600`; recommended `1600` for naturally sized board handwriting — check your `.env` if an older `1280` override is set).
- `CORS_ALLOWED_ORIGINS`: Comma-separated explicit development origins (leave empty when using the Next.js `/api` dev rewrite).

## Installation & Development

Everything runs from the repository root: the Next.js app lives at the root (`src/`), the Python modules in `server/`, and the Vercel entrypoint in `api/index.py`.

### 1. Install dependencies

```bash
uv sync
npm install
```

### 2. Run locally in development

Terminal 1:
```bash
uv run uvicorn index:app --app-dir api --host 127.0.0.1 --port 8000 --env-file .env
```

Terminal 2:
```bash
npm run dev
```

Open `http://localhost:5173`. Next.js rewrites `/api/*` requests to `http://127.0.0.1:8000` (override target via `CHALKOLATE_API_PROXY_TARGET`).

### Deploying to Vercel

The repository deploys as a single Vercel project: Next.js at the repo root plus one Python function, `api/index.py`, which imports the FastAPI app from `server/`. The root `vercel.json` rewrites `/api/*` to that function, so the browser stays same-origin and the API keys never leave the server. Only `api/index.py` lives in `api/` because Vercel turns every `.py` file there into its own function.

> **Untested on Vercel.** Vercel's docs don't spell out a Next.js app at the root alongside a root `api/` Python function (they show [Services](https://vercel.com/docs/services) with subdirectories instead). If the first deploy misroutes `/api/*` or picks the wrong framework preset, the fallback is the Services layout from commit `8ba24f7`.

1. Import the repo in Vercel (Root Directory empty).
2. Add `GEMINI_API_KEY`, `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID` (and any other names from `.env.example`) as project environment variables. Set `MAX_UPLOAD_BYTES=4194304`, because Vercel Functions reject request bodies over about 4.5 MB.
3. The first request after an idle period pays a Python cold start (OpenCV and NumPy imports); the app's page-load `/api/health` call warms the function. Check the bundle size with `VERCEL_ANALYZE_BUILD_OUTPUT=1` if a deploy fails on size (Python limit: 500 MB uncompressed).
4. The in-memory speech rate limiter and concurrency gates are per function instance, so on serverless they are best-effort. Add a Vercel WAF rate-limit rule for real abuse protection.

### 3. Using Chalkolate

1. Select a source in the top bar: **Camera** (choose integrated webcam, external camera, or virtual camera), **Screen**, or **Upload** (lecture video or image).
2. Monitoring is **stopped by default** when the app opens and does not request camera permissions automatically.
3. Click **Start** to begin near-real-time monitoring (click **Stop** at any time to pause analysis and speech while keeping preview and playback active).
4. For uploaded lecture videos, use the bottom playback bar to play, pause, restart, or scrub; seeking or restarting resets tracked findings for the new timestamp.
5. Click the subtle chevron along the right edge of the board (or any highlighted bounding box/pill) to smoothly expand or collapse the **Findings** sidebar; the video resizes naturally alongside it.
6. Click the **Crop** icon at bottom-right to open board calibration — Chalkolate automatically detects likely board corners using OpenCV and lets you fine-tune them manually before applying.

## Build, Lint, Type-Check, and Test Commands

### Backend (working directory: repository root)

```bash
uv run ruff check .
uv run ruff format --check .
uv run mypy
uv run pytest -v
```

### Frontend (working directory: repository root)

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Capture Sources & Limitations

- **Camera Devices**: Chalkolate displays real camera devices reported by the browser (excluding `OBS Virtual Camera`), prioritizes the integrated laptop webcam by default, releases prior stream handles before switching cameras, and retries transient driver lock/constraint errors.
- **Screen Share**: Uses `navigator.mediaDevices.getDisplayMedia` (browser tabs, windows, or screens supported by the browser). To monitor an iPad, mirror it to the host via AirPlay, USB/Sidecar, or a capture card and select that window/device.
- **Session-scoped tracking & dismissals**: Findings remain visible across motion, staleness, and transient API errors until verified resolved or dismissed. Dismissals suppress matching `detected_text` at that location for the current board session.

## Team

Shirley Liu, Adnan Aidan Taha, Jongmin Lee, and Édouard Chassé (SAJE)
