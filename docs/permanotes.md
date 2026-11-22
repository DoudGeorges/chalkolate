# Permanotes

Permanotes builds lecture notes from board snapshots. It starts once the user opens a source and Gemini is configured. Use **Pause notes** to abort the current notes request and discard queued captures. **Add board now** sends a single snapshot while a source is available, including while automatic notes are paused. The mistake monitor has its own Start and Stop controls.

## Capture and requests

The browser samples the board every 500 ms. It sends the first calm frame and later frames with significant changes. It retains smaller stable changes briefly and submits the retained frame if an erasure or large scene change is detected. A change of source or crop invalidates work from the previous view.

POST /api/notes sends an image, optional crop corners, and up to 40,000 bytes of serialized note context. Recent sections can include their full text. Older sections keep their headings as the budget fills. The model returns up to eight section updates and an optional title. The server projects figure boxes into source coordinates before the browser crops a thumbnail from the submitted frame.

The server applies a separate notes concurrency gate and Gemini deadline. Board text and previous notes are untrusted input. The server logs neither image content nor note text.

## Storage and export

The current lecture is stored in localStorage. If storage quota is exceeded, the browser tries again with text only. Notes persist across sources and reloads. Use **Clear** to empty the document.

- **Markdown** includes section text, source math, and JPEG thumbnails.
- **LaTeX** uses standard math commands. Unsupported formulas appear as literal text. Figures are available in the Markdown and print exports.
- **Print / PDF** opens standalone HTML with MathML and embedded JPEGs. Use the browser print dialog to save a PDF.
