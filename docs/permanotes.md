# Permanotes

Permanotes builds lecture notes from board snapshots. It starts when the preview plays and Gemini is configured. The notes panel has no pause or manual snapshot controls. The mistake monitor has its own Start and Stop controls.

## Capture and requests

The browser samples the board every 500 ms. It sends the first calm frame and later frames with significant changes. It retains smaller stable changes briefly and submits the retained frame if an erasure or large scene change is detected. When a video pauses, an update already in progress can still finish. Changing the source, changing the crop, or seeking invalidates work from the previous view.

POST /api/notes sends an image, optional crop corners, and up to 40,000 bytes of serialized note context. Recent sections can include their full text. Older sections keep their headings as the budget fills. The model returns up to eight section updates and an optional title. The server projects figure boxes into source coordinates before the browser crops a thumbnail from the submitted frame.

The server applies a separate notes concurrency gate and Gemini deadline. Board text and previous notes are untrusted input. The server logs neither image content nor note text.

## Storage and export

The current lecture is stored in sessionStorage, which belongs to one browser tab. Notes survive reloads and source changes in that tab. They are discarded when the tab closes, and other tabs or later visitors on the same browser profile never see them. If storage quota is exceeded, the browser tries again with text only. Builds before this change kept notes in shared localStorage; that key is deleted on load and never read. Use **Clear** to empty the document, and export before closing the tab.

The server keeps no notes. Each POST /api/notes is answered only from its own image and note context, and every API response is sent with `Cache-Control: no-store, private`.

- **Markdown** includes section text, source math, and JPEG thumbnails.
- **LaTeX** uses standard math commands. Unsupported formulas appear as literal text. Figures are available in the Markdown and print exports.
- **Print / PDF** opens standalone HTML with MathML and embedded JPEGs. Use the browser print dialog to save a PDF.
