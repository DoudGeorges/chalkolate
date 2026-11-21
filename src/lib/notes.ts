import katex from 'katex'
import { z } from 'zod'
import { NoteSectionUpdate, NotesContextSection } from '../api/schemas'

/** Permanotes document model: ordered sections of Markdown + KaTeX math with optional snapshot. */
export interface NoteSection {
  id: string
  heading: string
  body_markdown: string
  /** Downscaled JPEG data URL of the board when the model flagged a figure. */
  figure: string | null
  updatedAt: number
}

export interface NotesDocument {
  title: string
  sections: NoteSection[]
}

export const MAX_SECTIONS = 300
/** Server accepts 48 KiB of metadata; leave room for JSON framing and corners. */
export const MAX_CONTEXT_BYTES = 40_000
export const MAX_CONTEXT_SECTIONS = 120
export const NOTES_STORAGE_KEY = 'chalkolate.permanotes.v1'

export function createEmptyNotes(): NotesDocument {
  return { title: '', sections: [] }
}

function byteLength(text: string): number {
  return new TextEncoder().encode(text).length
}

/**
 * Builds the compact notes-so-far context. Newest sections keep full bodies; older ones
 * degrade to heading-only once the byte budget is spent, so long lectures stay within limits.
 */
export function buildNotesContext(
  sections: readonly NoteSection[],
  maxBytes = MAX_CONTEXT_BYTES,
): NotesContextSection[] {
  const recent = sections.slice(-MAX_CONTEXT_SECTIONS)
  const context: NotesContextSection[] = []
  let used = 2 // Array brackets.
  for (let i = recent.length - 1; i >= 0; i--) {
    const s = recent[i]!
    const headingOnly = { id: s.id, heading: s.heading, body_markdown: '' }
    const headingCost = byteLength(JSON.stringify(headingOnly)) + Number(context.length > 0)
    if (used + headingCost > maxBytes) break
    used += headingCost
    context.push(headingOnly)
  }
  for (const [index, section] of context.entries()) {
    const s = recent[recent.length - 1 - index]!
    const bodyCost = byteLength(JSON.stringify(s.body_markdown)) - 2
    if (used + bodyCost <= maxBytes) {
      used += bodyCost
      section.body_markdown = s.body_markdown
    }
  }
  return context.reverse()
}

/** Pixel crop rect for a source-space [ymin, xmin, ymax, xmax] 0..1000 box (whole frame if null). */
export function cropRect(
  box: readonly number[] | null,
  width: number,
  height: number,
): { x: number; y: number; w: number; h: number } {
  if (!box || box.length !== 4) return { x: 0, y: 0, w: width, h: height }
  const [ymin, xmin, ymax, xmax] = box as [number, number, number, number]
  const x = Math.floor((xmin * width) / 1000)
  const y = Math.floor((ymin * height) / 1000)
  const w = Math.max(1, Math.ceil((xmax * width) / 1000) - x)
  const h = Math.max(1, Math.ceil((ymax * height) / 1000) - y)
  return { x, y, w: Math.min(w, width - x), h: Math.min(h, height - y) }
}

/** Merges create-or-replace updates into the document. Never deletes existing sections. */
export function applyNotesUpdate(
  doc: NotesDocument,
  update: { lecture_title: string; updates: readonly NoteSectionUpdate[] },
  figures: ReadonlyMap<string, string | null>,
  nowMs: number,
): NotesDocument {
  const sections = [...doc.sections]
  for (const u of update.updates) {
    const idx = sections.findIndex((s) => s.id === u.id)
    if (idx >= 0) {
      const prev = sections[idx]!
      sections[idx] = {
        ...prev,
        heading: u.heading,
        body_markdown: u.body_markdown,
        figure: (u.has_figure && figures.get(u.id)) || prev.figure,
        updatedAt: nowMs,
      }
      continue
    }
    if (sections.length >= MAX_SECTIONS) continue
    const created: NoteSection = {
      id: u.id,
      heading: u.heading,
      body_markdown: u.body_markdown,
      figure: u.has_figure ? (figures.get(u.id) ?? null) : null,
      updatedAt: nowMs,
    }
    const anchor = u.after_section_id
      ? sections.findIndex((s) => s.id === u.after_section_id)
      : -1
    if (anchor >= 0) {
      sections.splice(anchor + 1, 0, created)
    } else {
      sections.push(created)
    }
  }
  const title = update.lecture_title.trim()
  return { title: doc.title || title, sections }
}

const StoredNotesSchema = z.object({
  title: z.string().max(160),
  sections: z
    .array(
      z.object({
        id: z.string().min(1).max(40),
        heading: z.string().max(120),
        body_markdown: z.string().max(3000),
        figure: z.string().nullable().transform((value) =>
          value && /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/.test(value) ? value : null,
        ),
        updatedAt: z.number(),
      }),
    )
    .max(MAX_SECTIONS),
})

export function loadNotes(storage: Pick<Storage, 'getItem'> | null = safeStorage()): NotesDocument {
  try {
    const raw = storage?.getItem(NOTES_STORAGE_KEY)
    if (!raw) return createEmptyNotes()
    const parsed = StoredNotesSchema.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : createEmptyNotes()
  } catch {
    return createEmptyNotes()
  }
}

/** Persists notes; if the quota is exceeded, retries without figures (text is the priority). */
export function saveNotes(
  doc: NotesDocument,
  storage: Pick<Storage, 'setItem' | 'removeItem'> | null = safeStorage(),
): void {
  if (!storage) return
  try {
    if (doc.sections.length === 0 && !doc.title) {
      storage.removeItem(NOTES_STORAGE_KEY)
      return
    }
    storage.setItem(NOTES_STORAGE_KEY, JSON.stringify(doc))
  } catch {
    try {
      const slim = { ...doc, sections: doc.sections.map((s) => ({ ...s, figure: null })) }
      storage.setItem(NOTES_STORAGE_KEY, JSON.stringify(slim))
    } catch {
      /* storage unavailable: notes stay in memory and remain exportable */
    }
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window === 'undefined' ? null : window.localStorage
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------------------------

function exportTitle(doc: NotesDocument): string {
  return doc.title.trim() || 'Lecture notes'
}

/** Self-contained Markdown: KaTeX-style $ math stays as text; figures are embedded data URLs. */
export function exportMarkdown(doc: NotesDocument, now: Date = new Date()): string {
  const lines: string[] = [`# ${exportTitle(doc)}`, '', `_Generated by Chalkolate Permanotes on ${now.toISOString().slice(0, 10)}._`, '']
  for (const s of doc.sections) {
    lines.push(`## ${s.heading}`, '', s.body_markdown, '')
    if (s.figure) {
      lines.push(`![Board snapshot: ${s.heading.replace(/[[\]]/g, '')}](${s.figure})`, '')
    }
  }
  return lines.join('\n')
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function renderMath(tex: string, display: boolean): string {
  try {
    // MathML output needs no stylesheet or fonts, so exported HTML stays self-contained.
    return katex.renderToString(tex, {
      displayMode: display,
      throwOnError: true,
      trust: false,
      maxExpand: 250,
      maxSize: 20,
      output: 'mathml',
    })
  } catch {
    return `<code>${escapeHtml(tex)}</code>`
  }
}

function renderInline(text: string): string {
  return text
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>')
}

/**
 * Minimal safe Markdown subset -> HTML: paragraphs, bullet/numbered lists, bold/italic/code,
 * and KaTeX math. All text is HTML-escaped; math is rendered with trust disabled.
 */
export function renderNotesBodyHtml(markdown: string): string {
  const math: string[] = []
  const stash = (html: string) => `\u0000${math.push(html) - 1}\u0000`
  const withMath = markdown.split('\u0000').join('')
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, tex: string) => stash(renderMath(tex.trim(), true)))
    .replace(/(?<![\\$])\$([^$\n]+?)\$(?!\$)/g, (_m, tex: string) =>
      stash(renderMath(tex.trim(), false)),
    )

  const blocks = withMath.split(/\n{2,}/)
  const html = blocks
    .map((block) => {
      const lines = block.split('\n').filter((l) => l.trim().length > 0)
      if (lines.length === 0) return ''
      if (lines.every((l) => /^\s*[-*•]\s+/.test(l))) {
        const items = lines.map((l) => `<li>${renderInline(escapeHtml(l.replace(/^\s*[-*•]\s+/, '')))}</li>`)
        return `<ul>${items.join('')}</ul>`
      }
      if (lines.every((l) => /^\s*\d+[.)]\s+/.test(l))) {
        const items = lines.map((l) => `<li>${renderInline(escapeHtml(l.replace(/^\s*\d+[.)]\s+/, '')))}</li>`)
        return `<ol>${items.join('')}</ol>`
      }
      return `<p>${renderInline(escapeHtml(lines.join('\n'))).replace(/\n/g, '<br>')}</p>`
    })
    .join('\n')

  return html.replace(/\u0000(\d+)\u0000/g, (_m, i: string) => math[Number(i)] ?? '')
}

const PRINT_CSS = `
body{font-family:Georgia,'Times New Roman',serif;max-width:46rem;margin:2rem auto;padding:0 1rem;line-height:1.55;color:#111}
h1{font-size:1.9rem;margin-bottom:.2rem}h2{font-size:1.25rem;margin:1.6rem 0 .4rem;break-after:avoid}
.meta{color:#666;font-size:.85rem;margin-bottom:1.5rem}section{break-inside:avoid-page;margin-bottom:1rem}
img{max-width:100%;border:1px solid #ddd;border-radius:4px;margin:.5rem 0}code{background:#f3f3f3;padding:0 .25em;border-radius:3px}
math[display=block]{margin:.8rem 0}@media print{body{margin:0;max-width:none}}
`

/** Standalone print-friendly HTML (save as PDF via the browser's print dialog). */
export function exportPrintHtml(doc: NotesDocument, now: Date = new Date()): string {
  const title = escapeHtml(exportTitle(doc))
  const sections = doc.sections
    .map((s) => {
      const fig = s.figure && s.figure.startsWith('data:image/')
        ? `<img src="${escapeHtml(s.figure)}" alt="Board snapshot: ${escapeHtml(s.heading)}">`
        : ''
      return `<section><h2>${escapeHtml(s.heading)}</h2>${renderNotesBodyHtml(s.body_markdown)}${fig}</section>`
    })
    .join('\n')
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>${PRINT_CSS}</style></head><body><h1>${title}</h1><div class="meta">Generated by Chalkolate Permanotes on ${now.toISOString().slice(0, 10)}</div>${sections}</body></html>`
}
