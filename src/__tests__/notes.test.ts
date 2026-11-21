import { describe, expect, it } from 'vitest'
import { NoteSectionUpdate } from '../api/schemas'
import {
  NOTES_STORAGE_KEY,
  NotesDocument,
  applyNotesUpdate,
  buildNotesContext,
  createEmptyNotes,
  cropRect,
  exportMarkdown,
  exportPrintHtml,
  loadNotes,
  renderNotesBodyHtml,
  saveNotes,
} from '../lib/notes'

function upd(id: string, over: Partial<NoteSectionUpdate> = {}): NoteSectionUpdate {
  return {
    id,
    heading: `H ${id}`,
    body_markdown: `body ${id}`,
    has_figure: false,
    figure_box_2d: null,
    after_section_id: null,
    ...over,
  }
}

describe('applyNotesUpdate', () => {
  it('appends, inserts after an anchor, and rewrites in place without deleting', () => {
    let doc = applyNotesUpdate(createEmptyNotes(), { lecture_title: 'Physics', updates: [upd('a'), upd('c')] }, new Map(), 1)
    doc = applyNotesUpdate(doc, { lecture_title: 'Other', updates: [upd('b', { after_section_id: 'a' })] }, new Map(), 2)
    expect(doc.sections.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(doc.title).toBe('Physics')

    doc = applyNotesUpdate(doc, { lecture_title: '', updates: [upd('a', { body_markdown: 'new' })] }, new Map(), 3)
    expect(doc.sections.map((s) => s.id)).toEqual(['a', 'b', 'c'])
    expect(doc.sections[0]?.body_markdown).toBe('new')
    expect(doc.sections[0]?.updatedAt).toBe(3)
  })

  it('attaches figure only when flagged and keeps an existing figure otherwise', () => {
    let doc = applyNotesUpdate(createEmptyNotes(), { lecture_title: '', updates: [upd('a', { has_figure: true })] }, new Map([['a', 'data:image/jpeg;base64,AA']]), 1)
    expect(doc.sections[0]?.figure).toBe('data:image/jpeg;base64,AA')
    doc = applyNotesUpdate(doc, { lecture_title: '', updates: [upd('a', { has_figure: false })] }, new Map([['a', 'data:image/jpeg;base64,BB']]), 2)
    expect(doc.sections[0]?.figure).toBe('data:image/jpeg;base64,AA')
    doc = applyNotesUpdate(doc, { lecture_title: '', updates: [upd('z')] }, new Map([['z', 'data:image/jpeg;base64,CC']]), 3)
    expect(doc.sections[1]?.figure).toBeNull()
  })
})

describe('buildNotesContext', () => {
  it('keeps newest bodies and degrades older ones to headings under a byte budget', () => {
    const sections = Array.from({ length: 5 }, (_, i) => ({
      id: `s${i}`,
      heading: `Heading ${i}`,
      body_markdown: 'x'.repeat(100),
      figure: null,
      updatedAt: i,
    }))
    const ctx = buildNotesContext(sections, 400)
    expect(ctx.map((c) => c.id)).toEqual(['s0', 's1', 's2', 's3', 's4'])
    expect(ctx[4]?.body_markdown).toHaveLength(100)
    expect(ctx[0]?.body_markdown).toBe('')
    expect(ctx[0]?.heading).toBe('Heading 0')
  })
})

describe('persistence', () => {
  const doc: NotesDocument = {
    title: 'T',
    sections: [{ id: 'a', heading: 'h', body_markdown: 'b', figure: 'data:image/jpeg;base64,AA', updatedAt: 1 }],
  }

  it('round-trips, tolerates corrupt data, and drops figures when quota is hit', () => {
    const store = new Map<string, string>()
    const storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
    }
    saveNotes(doc, storage)
    expect(loadNotes(storage)).toEqual(doc)
    store.set(NOTES_STORAGE_KEY, '{oops')
    expect(loadNotes(storage)).toEqual(createEmptyNotes())

    let first = true
    const quota = {
      setItem: (k: string, v: string) => {
        if (first) {
          first = false
          throw new DOMException('full', 'QuotaExceededError')
        }
        store.set(k, v)
      },
      removeItem: () => {},
    }
    saveNotes(doc, quota)
    expect(loadNotes(storage).sections[0]?.figure).toBeNull()
  })
})

describe('export', () => {
  const doc: NotesDocument = {
    title: 'Kinematics',
    sections: [
      { id: 'a', heading: 'Equation', body_markdown: 'Use $v=v_0+at$.\n\n- one\n- two', figure: 'data:image/jpeg;base64,AA', updatedAt: 1 },
    ],
  }

  it('produces self-contained Markdown with embedded figures', () => {
    const md = exportMarkdown(doc, new Date('2026-01-02T00:00:00Z'))
    expect(md).toContain('# Kinematics')
    expect(md).toContain('## Equation')
    expect(md).toContain('$v=v_0+at$')
    expect(md).toContain('![Board snapshot: Equation](data:image/jpeg;base64,AA)')
    expect(md).toContain('2026-01-02')
  })

  it('renders print HTML with MathML, lists, and no remote resources', () => {
    const html = exportPrintHtml(doc)
    expect(html).toContain('<!doctype html>')
    expect(html).toContain('<math')
    expect(html).toContain('<li>one</li>')
    expect(html).not.toMatch(/(src|href)="https?:/)
  })

  it('escapes HTML and never executes injected markup', () => {
    const out = renderNotesBodyHtml('<img src=x onerror=alert(1)> **bold** $\\foo{$')
    expect(out).not.toContain('<img')
    expect(out).toContain('&lt;img')
    expect(out).toContain('<strong>bold</strong>')
    const hostile = exportPrintHtml({
      title: '<script>x</script>',
      sections: [{ id: 'a', heading: '<b>', body_markdown: 'ok', figure: 'javascript:alert(1)', updatedAt: 0 }],
    })
    expect(hostile).not.toContain('<script>x')
    expect(hostile).not.toContain('javascript:')
  })
})

describe('cropRect', () => {
  it('maps a source-space box to clamped pixels and falls back to the whole frame', () => {
    expect(cropRect(null, 200, 100)).toEqual({ x: 0, y: 0, w: 200, h: 100 })
    expect(cropRect([100, 250, 600, 750], 200, 100)).toEqual({ x: 50, y: 10, w: 100, h: 50 })
    const edge = cropRect([900, 900, 1000, 1000], 101, 101)
    expect(edge.x + edge.w).toBeLessThanOrEqual(101)
    expect(edge.y + edge.h).toBeLessThanOrEqual(101)
  })
})
