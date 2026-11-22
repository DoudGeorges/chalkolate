# Chalkolate

Chalkolate monitors lecture boards from a camera, screen share, or uploaded video. It highlights supported errors, can announce corrections aloud, and builds lecture notes from snapshots. Your media source and findings stay in the browser. Gemini receives selected board snapshots and context when enabled. ElevenLabs receives alert text when its speech service is configured.

## Local setup

Use Node.js 22.13 or later on the 22.x line, or Node.js 24 or later. Use uv with Python 3.12 or 3.13. Run these commands from the repository root.

~~~sh
npm ci
uv sync --locked
~~~

For live analysis, copy .env.example to .env and set GEMINI_API_KEY. Add ELEVENLABS_API_KEY and ELEVENLABS_VOICE_ID for ElevenLabs speech, or use your browser's speech synthesis. Source preview and board detection work without provider keys.

Start FastAPI and Next.js in separate terminals.

~~~sh
uv run --locked uvicorn index:app --app-dir api --host 127.0.0.1 --port 8000
~~~

~~~sh
npm run dev
~~~

Open http://localhost:5173. Next.js proxies /api requests to FastAPI in development. Set CHALKOLATE_API_PROXY_TARGET to change the backend origin. FastAPI loads process variables first, then the root .env, then server/.env. See .env.example for the supported settings. Development and production builds use Webpack because the Turbopack PostCSS worker can exit before connecting on Windows.

## Using the studio

1. Pick a board source and an alert mode. Select **Open camera** or **Share screen** and grant browser permission. For a recording, select **Video file**, then **Choose video**. The preview plays as soon as the source opens.
2. Select **Start** to begin checking the board. Uploaded video is checked during playback. Use the playback controls to pause, seek, or restart. Use **Crop board** to straighten a board in a camera feed or video. For screen sharing, choose the lecture tab or window.
3. Select a highlighted correction to read its explanation. Under **Spoken feedback**, **Student** states each mistake and explains the correction. **Professor** gives just the short correction. You can change spoken feedback, voice, alert mode, and number format in **Settings**. **Stop** ends board checks and spoken alerts while the preview keeps playing.
4. Open **Notes** to read or download the lecture notes, which build automatically while a source is live. Notes are kept only for this browser tab: they survive reloads and are discarded when the tab closes, so export them first. Clear them when starting a separate lecture.

Select the Chalkolate wordmark to close the source and return to setup.

Only use captures you have permission to share with the configured providers. Avoid capturing unrelated windows and sensitive information.

## Architecture

- **Next.js** renders the client studio. Change detection, finding history, capture control, and note persistence run in the browser.
- **FastAPI** validates requests and uses Pillow and OpenCV to decode and rectify images. It sends processed JPEGs to Gemini and projects returned bounding boxes back to source coordinates.
- **Permanotes** uses an independent snapshot schedule and uploads bounded note context alongside a JPEG. The API returns incremental updates. Export includes Markdown, printable HTML, and LaTeX. See [Permanotes](docs/permanotes.md).
- **Speech** streams MP3 audio from ElevenLabs when configured. The browser can synthesize an alert if playback has yet to start and the provider is unavailable.

## Checks and contributions

Start changes from current main, keep both lockfiles synchronized, and open a pull request. CI checks Node.js 22 and 24 and Python 3.12 and 3.13.

~~~sh
npm run lint
npm run typecheck
npm run build

uv run --locked ruff check .
uv run --locked ruff format --check .
uv run --locked mypy
~~~

The standalone [board detection lab](experiments/board-detect-lab.html) helps tune OpenCV heuristics. It loads OpenCV.js from a CDN and processes the selected image in the browser.

## Deploying

Keep the Next.js project at the repository root. Vercel routes /api requests to api/index.py, the FastAPI entrypoint. Configure provider keys as server environment variables. Set MAX_UPLOAD_BYTES=4194304 to leave room for multipart metadata within Vercel's default request limit. Match the analysis and notes deadlines to the platform's function duration.

The Python function uses Vercel's Large Functions beta when its assembled image-processing bundle exceeds the standard limit. The build flag is set in vercel.json. Fluid Compute with Active CPU is required.

Verify /api/health, /api/detect-board, /api/analyze, /api/notes, and /api/speech on a preview deployment. Health reports configured credentials without calling providers. Configure access controls or edge rate limits before exposing paid inference to untrusted traffic. The service's concurrency gates and speech limiter are per process.

## Team

Shirley Liu, Adnan Aidan Taha, Jongmin Lee, and Édouard Chassé (SAJE).
