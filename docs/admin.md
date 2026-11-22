# Admin debug console (`/admin`)

Owner-only page showing every request the app sends to the backend (`/api/analyze`,
`/api/detect-board`, `/api/notes`, `/api/speech`, `/api/voices`, `/api/health`): timestamp, route,
status, latency, request id, session id, client, settings, request contents (metadata, speech
text), the frame as uploaded (thumbnail + full view) and the rectified frame sent to the model,
the response/findings, and error codes. Search, route/status filters, expandable rows, auto-refresh.

## Privacy tradeoff (read first)

This feature **deliberately overrides** the invariant that frames, spoken text and model output
are never stored. While enabled, other users' board photos, spoken alerts and model output are
written to the log store. It is therefore strictly opt-in and meant for short debugging windows:

- Off unless `ADMIN_DEBUG_LOGGING=1` **and** `ADMIN_TOKEN` (>= 16 chars, server-only secret) are
  set. A missing/short token keeps it off. When off: no middleware, no store, no routes — the
  backend answers `/api/admin/*` with 404 and `/admin` renders a real Next.js 404.
- Turn it off (unset the flag) and clear the logs (`Clear` button) when finished.
- Never stored: provider API keys, the admin token, request headers other than an allowlist
  (`content-type`, `content-length`, `user-agent`, `referer`, `accept`, `retry-after`,
  `x-chalkolate-*`); never `cookie`/`authorization`. Secret-looking JSON keys and any occurrence
  of the configured secret values are replaced by `[redacted]` (`admin_log.redact`).
- The client sends a random per-page-load `X-Chalkolate-Session` id so entries group by session.
  All analyze/notes requests are automatic (the UI has no manual check), so `trigger` is `auto`.

## Access control

`POST /api/admin/login {token}` compares in constant time (SHA-256 digests +
`hmac.compare_digest`), is rate-limited (10/min per client), and sets an httpOnly,
`SameSite=Strict`, `Secure` (on https) cookie holding an HMAC-signed 12 h expiry derived from
`ADMIN_TOKEN` (rotating the token invalidates sessions). `Authorization: Bearer <token>` also
works for curl. Every `/api/admin/*` response carries `Cache-Control: no-store` and
`X-Robots-Tag: noindex`; the page has `robots: noindex`. Unauthenticated data requests get 401.
The admin API is the only reader; the studio never queries it, and entries are keyed by random
128-bit ids (not by user-supplied ids), so another user cannot enumerate them.

## Storage and retention

Vercel functions are stateless, so production needs an external store: **Upstash Redis REST**
(Vercel Marketplace "Upstash Redis"/KV) via `UPSTASH_REDIS_REST_URL`/`_TOKEN` (or
`KV_REST_API_URL`/`_TOKEN`). On Vercel without these, logging is disabled with a warning rather
than falling back to per-instance memory. Locally (no `VERCEL` env) it uses a gitignored
`.admin-logs/` directory.

Bounds: `ADMIN_LOG_TTL_SECONDS` (default 3 days; Redis keys use `EX`), `ADMIN_LOG_MAX_ENTRIES`
(default 200, oldest and their images deleted), `ADMIN_LOG_MAX_IMAGE_BYTES` (default 512 KiB;
larger frames are re-encoded smaller, or dropped keeping only a 256 px thumbnail). Responses are
captured only for JSON bodies up to 256 KiB; speech audio is not stored (only its size).

## How it works

`server/admin_log.py` holds an outermost pure-ASGI middleware that tees request/response bytes
for the tracked routes (so 4xx/413 rejections are logged too), re-parses the multipart body after
the response, and writes through the store; write failures never affect the request. `/api/analyze`
and `/api/notes` additionally attach the rectified model-input JPEG. The UI is
`src/app/admin/` (a separate route; not part of the studio bundle).

## Usage

```bash
ADMIN_DEBUG_LOGGING=1
ADMIN_TOKEN=<random 32+ chars>
# Vercel only:
UPSTASH_REDIS_REST_URL=...
UPSTASH_REDIS_REST_TOKEN=...
```

Open `/admin`, sign in with the token.
