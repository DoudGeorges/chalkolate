# Chalkolate 🍫

_Smarter than the front row._

## Description

Catches math, physics, and spelling mistakes as they happen during lectures by monitoring whiteboards, chalkboards, and projected screens in real time.

## Problem

A missing minus sign, an incorrect unit, or a simple typo can completely change the result of a problem. Students often hesitate to interrupt the professor, so these mistakes can go unnoticed and end up in their notes, or waste valuable time when caught later.

## Solution

Chalkolate watches the board as the professor writes, checking equations, calculations, and text for mistakes. When it spots an error, it highlights the exact location on the live video feed and suggests a correction on screen, out loud, or both. This helps the professor catch mistakes before they affect the rest of a derivation or problem. It also helps students avoid copying errors into their notes while minimizing interruptions to the lecture.

## Architecture & Privacy Notice

- **Stateless backend (`backend/`)**: Accepts ordinary HTTP `multipart/form-data` snapshot uploads on `POST /api/analyze`, rectifies/enhances the frame in memory, forwards the processed JPEG snapshot to the configured Gemini model via the official `google-genai` SDK, and projects findings back into canonical uploaded-image coordinates.
- **Browser-owned session (`frontend/`)**: Holds the active media stream/source, stabilization state machine, issue tracking, dismissals, and `window.speechSynthesis` history in memory without a database, WebSockets, or authentication.
- **External data disclosure**: Analyzed board snapshots (plus the optional `previous_board_summary` text) are transmitted to the backend and sent to the Google Gemini API for inference. Do not point Chalkolate at confidential or restricted material without appropriate approval.

## Prerequisites & Supported Versions

- **Python**: `>= 3.12, < 3.14` (managed via `uv`; `backend/.python-version` pins `3.12`)
- **Node.js**: `>= 22.0.0` with `npm`
- **Gemini API key** (optional for preview/calibration/tests; required on the backend for live `POST /api/analyze` inference)

## Configuration

Copy `.env.example` to `.env` at the repository root (or inside `backend/`):

```bash
cp .env.example .env
```

Key settings:
- `GEMINI_API_KEY`: Backend-only Gemini API key. Never expose secrets via `VITE_*` variables.
- `GEMINI_MODEL`: Default model ID (`gemini-4-hydrogen`).
- `GEMINI_DEEP_MODEL`: Higher-reasoning Deep Mode model ID (`gemini-4-carbon`). Setting an empty string disables Deep Mode.
- `ANALYSIS_CONFIDENCE_THRESHOLD`: Product heuristic confidence cutoff (default `0.85`; not a calibrated probability).
- `CORS_ALLOWED_ORIGINS`: Comma-separated explicit development origins (leave empty when using the Vite `/api` dev proxy).

## Installation & Development

All backend commands must be run from `backend/`, and all frontend commands from `frontend/` unless noted otherwise.

### 1. Install dependencies

From `backend/`:
```bash
uv sync
```

From `frontend/`:
```bash
npm install
```

### 2. Run locally in development

Terminal 1 (from `backend/`):
```bash
uv run uvicorn main:app --host 127.0.0.1 --port 8000 --reload
```

Terminal 2 (from `frontend/`):
```bash
npm run dev
```

Open `http://localhost:5173`. Vite proxies `/api/*` requests to `http://127.0.0.1:8000` (override target via `CHALKOLATE_API_PROXY_TARGET`).

## Build, Lint, Type-Check, and Test Commands

### Backend (working directory: `backend/`)

```bash
uv run ruff check .
uv run ruff format --check .
uv run mypy .
uv run pytest -v
```

### Frontend (working directory: `frontend/`)

```bash
npm run lint
npm run typecheck
npm test
npm run build
```

## Capture Sources & Limitations

- **Live Camera**: Uses `navigator.mediaDevices.getUserMedia` (requires a secure context — HTTPS or `localhost` — and camera permission, audio disabled).
- **Screen Share**: Uses `navigator.mediaDevices.getDisplayMedia` (browser tabs, windows, or screens supported by the browser). Chalkolate does not connect directly to remote iPads over the network; to monitor an iPad, mirror it to the host via AirPlay, USB/Sidecar, or a capture card and select that window/device.
- **Demo Mode**: Supports browser-decodable image/video uploads and **Load Sample Mistake**, which renders a synthetic chalkboard containing intentional mistakes and sends it through the normal capture and `/api/analyze` path.
- **Session-scoped tracking & dismissals**: Dismissals suppress matching `detected_text` at the matched board location only for the active board session. Chalkolate cannot distinguish identical text that was erased and rewritten at the same spot between observations. Use **New Board**, **Reset**, or **Undo Dismiss** when board content changes or to review suppressed findings.

## Team

Shirley Liu, Adnan Aidan Taha, Jongmin Lee, and Édouard Chassé (SAJE)
