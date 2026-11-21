# Permanotes — design note

Goal: while the professor teaches, build a shareable notes document of the **whole lecture**
(the blackboard equivalent of sharing slides afterwards), in parallel with, and independent of,
mistake highlighting.

## Isolation from mistake detection
Separate everything: `POST /api/notes` (own concurrency gate `notes_concurrency_gate`, own
timeout/token settings `NOTES_*`), own client hook `useNotesBuilder` (own 500 ms sampling loop,
own detector state, own in-flight request). It reads the media element but shares no state,
reducer, or request with `useBoardMonitor`, so a slow or failing notes call can never delay,
abort, or alter a mistake check. Notes are **automatic and effortless**: they build as soon as a camera/screen/video source is
live and the backend is configured, with no start step for the professor (unlike mistake
monitoring, which is opt-in). A small Pause button is the only control; nothing calls
`getUserMedia` on its own.

## When to snapshot (`src/lib/notesTrigger.ts`, pure and unit-tested)
Not every frame. The board must be *calm* (≈1.5 s without motion) and then:
- first calm frame → send;
- ≥4% of tiles differ from the last sent snapshot and ≥15 s since the last send → send;
- 1.5–4% differ (or too soon) → retain a **stable candidate** frame (refreshed ≤ every 5 s);
- ≥12% of tiles differ from the stable candidate (erasure / scene change), ≥5 s since last
  send → **flush the candidate first**, so content is captured before it disappears;
- on Pause, any unsent stable candidate is flushed. "Add board now" forces a snapshot.

## Incremental building (`server/notes.py`)
Request: image (+ optional calibration corners) and JSON metadata holding the notes so far
(newest bodies in full, older sections degraded to headings to stay under 40 KB). The model
returns only **create-or-replace section updates** (≤8) plus an optional lecture title, never
the whole document, so cost stays flat as notes grow. Sections are never deleted (erased
content stays in the notes); intentional board corrections rewrite a section in place. Notes
context and image text are marked untrusted in the prompt. Same Gemini config conventions as
analysis (structured JSON schema, thinking level, bounded tokens/timeout, 503-only retries,
shared error mapping, no secret/frame/model-text logging).

## Data model
`NotesDocument { title, sections[] }`, `NoteSection { id, heading, body_markdown (Markdown with
$…$ / $$…$$ KaTeX), figure: data-URL | null, updatedAt }`. `has_figure` is set by the model only
when a diagram is essential and returns `figure_box_2d`; the server projects that box through the
calibration's inverse homography into source space (same as mistake boxes; invalid → null) and
the client crops the figure (≤800 px JPEG) from the exact frame it sent, or the whole frame
if the box is null.

## Persistence and export
Client-side `localStorage` (`chalkolate.permanotes.v1`, zod-validated on load; figures dropped
first if quota is hit). Notes survive source changes and reloads; "Clear" empties them.
Export: **Markdown** (self-contained, figures embedded as data URLs, math left as `$…$`) and
**LaTeX** (`.tex` article for Overleaf/pdflatex: math verbatim, text escaped, figures omitted
since there are no external files), and **print HTML** (standalone, math as MathML via KaTeX so no CSS/fonts are needed; open and
use the browser's Print → Save as PDF).

## Deliberately left out (v1)
server-side storage, accounts,
or share links (export-and-send only); audio/transcript fusion; manual editing/reordering of
sections; multi-lecture library; de-duplicating near-identical figures; deleting sections;
a live health flag for notes (reuses `analysis_configured`); rate limiting beyond the
concurrency gate; automatic end-of-lecture finalisation beyond the Stop flush.
