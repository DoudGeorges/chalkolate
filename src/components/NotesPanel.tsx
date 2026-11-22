import { Download, FileText, Printer, Trash2, X } from 'lucide-react'
import { useMemo } from 'react'
import { NotesPhase } from '../hooks/useNotesBuilder'
import { NotesDocument, renderNotesBodyHtml } from '../lib/notes'

export interface NotesPanelProps {
  open: boolean
  /** Notes are being built automatically right now (source live and not paused). */
  active: boolean
  configured: boolean
  phase: NotesPhase
  error: string | null
  notes: NotesDocument
  onToggleOpen: () => void
  onExportMarkdown: () => void
  onExportLatex: () => void
  onExportPrint: () => void
  onClear: () => void
}

function NoteBody({ markdown }: { markdown: string }) {
  // Output is escaped by renderNotesBodyHtml and KaTeX runs with trust disabled.
  const html = useMemo(() => renderNotesBodyHtml(markdown), [markdown])
  return (
    <div
      className="space-y-2 text-sm leading-relaxed text-zinc-700 [&_li]:ml-4 [&_ol]:list-decimal [&_ul]:list-disc"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function NotesPanel({
  open,
  active,
  configured,
  phase,
  error,
  notes,
  onToggleOpen,
  onExportMarkdown,
  onExportLatex,
  onExportPrint,
  onClear,
}: NotesPanelProps) {
  const count = notes.sections.length
  const status =
    phase === 'building'
      ? 'Updating notes…'
      : !configured
        ? 'Board analysis unavailable'
        : !active
          ? 'Waiting for a camera, screen, or video'
          : null

  return (
    <>
      <button
        type="button"
        onClick={onToggleOpen}
        aria-expanded={open}
        aria-label="Toggle lecture notes"
        className="absolute bottom-3 left-3 z-20 flex h-8 items-center gap-1.5 rounded-full border border-line bg-white px-3 text-xs text-zinc-700 hover:bg-zinc-100"
      >
        <FileText className="h-3.5 w-3.5" aria-hidden />
        Notes{count > 0 ? ` (${count})` : ''}
        {active && <span className="h-1.5 w-1.5 rounded-full bg-rose-500" aria-hidden />}
      </button>

      {open && (
        <aside
          aria-label="Lecture notes"
          className="absolute inset-y-0 right-0 z-30 flex w-full max-w-md flex-col border-l border-line bg-white shadow-xl"
        >
          <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
            <h2 className="truncate text-sm font-medium text-zinc-900">
              {notes.title || 'Lecture notes'}
            </h2>
            <button
              type="button"
              onClick={onToggleOpen}
              aria-label="Close notes"
              className="rounded p-1 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
            >
              <X className="h-4 w-4" aria-hidden />
            </button>
          </header>

          {status && (
            <p role="status" className="border-b border-line px-3 py-2 text-xs text-zinc-600">
              {status}
            </p>
          )}

          {error && (
            <div role="alert" className="border-b border-amber-500/20 bg-amber-50 px-3 py-1.5 text-xs text-amber-800">
              {error}
            </div>
          )}

          <div className="flex-1 space-y-5 overflow-y-auto px-3 py-3">
            {count === 0 ? (
              <p className="text-sm text-zinc-500">
                No notes yet.
              </p>
            ) : (
              notes.sections.map((section) => (
                <section key={section.id} aria-label={section.heading}>
                  <h3 className="mb-1 text-sm font-semibold text-zinc-900">{section.heading}</h3>
                  <NoteBody markdown={section.body_markdown} />
                  {section.figure && (
                    <img
                      src={section.figure}
                      alt={`Board snapshot: ${section.heading}`}
                      className="mt-2 rounded border border-line"
                    />
                  )}
                </section>
              ))
            )}
          </div>

          <footer className="flex flex-wrap items-center gap-2 border-t border-line px-3 py-2 text-xs">
            <button
              type="button"
              onClick={onExportMarkdown}
              disabled={count === 0}
              className="flex items-center gap-1 rounded border border-line px-2 py-1 text-zinc-900 hover:bg-zinc-100 disabled:opacity-40"
            >
              <Download className="h-3 w-3" aria-hidden /> Export Markdown
            </button>
            <button
              type="button"
              onClick={onExportLatex}
              disabled={count === 0}
              className="flex items-center gap-1 rounded border border-line px-2 py-1 text-zinc-900 hover:bg-zinc-100 disabled:opacity-40"
            >
              <Download className="h-3 w-3" aria-hidden /> LaTeX
            </button>
            <button
              type="button"
              onClick={onExportPrint}
              disabled={count === 0}
              className="flex items-center gap-1 rounded border border-line px-2 py-1 text-zinc-900 hover:bg-zinc-100 disabled:opacity-40"
            >
              <Printer className="h-3 w-3" aria-hidden /> Print / PDF
            </button>
            <button
              type="button"
              onClick={onClear}
              disabled={count === 0}
              className="ml-auto flex items-center gap-1 rounded px-2 py-1 text-zinc-600 hover:text-rose-700 disabled:opacity-40"
            >
              <Trash2 className="h-3 w-3" aria-hidden /> Clear
            </button>
          </footer>
        </aside>
      )}
    </>
  )
}
