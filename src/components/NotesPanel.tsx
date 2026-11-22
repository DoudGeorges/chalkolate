import { FileCode2, FileText, NotebookPen, Printer, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { NotesPhase } from '../hooks/useNotesBuilder'
import { NotesDocument, renderNotesBodyHtml } from '../lib/notes'
import { StudioPanel } from './StudioPanel'

export interface NotesPanelProps {
  open: boolean
  active: boolean
  configured: boolean
  editingCrop: boolean
  phase: NotesPhase
  error: string | null
  notes: NotesDocument
  onClose: () => void
  onExportMarkdown: () => void
  onExportLatex: () => void
  onExportPrint: () => void
  onClear: () => void
}

function NoteBody({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderNotesBodyHtml(markdown), [markdown])
  return (
    <div
      className="ui-copy space-y-2 overflow-x-auto wrap-anywhere [&_li]:ml-4 [&_ol]:list-decimal [&_ul]:list-disc"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function NotesPanel({
  open,
  active,
  configured,
  editingCrop,
  phase,
  error,
  notes,
  onClose,
  onExportMarkdown,
  onExportLatex,
  onExportPrint,
  onClear,
}: NotesPanelProps) {
  const hasNotes = notes.sections.length > 0
  const SectionHeading = notes.title ? 'h4' : 'h3'
  let status: string | null = null
  if (!configured) status = 'Automatic notes are unavailable.'
  else if (editingCrop) status = 'Notes will resume when you finish cropping.'
  else if (phase === 'building') status = 'Updating notes…'
  else if (!active) status = 'Waiting for the preview to play.'
  const [confirmingClear, setConfirmingClear] = useState(false)
  const cancelClearRef = useRef<HTMLButtonElement>(null)
  const clearButtonRef = useRef<HTMLButtonElement>(null)

  useEffect(() => {
    if (!hasNotes || !open) setConfirmingClear(false)
  }, [hasNotes, open])

  useEffect(() => {
    if (!confirmingClear) return
    cancelClearRef.current?.focus()
    const timer = window.setTimeout(() => {
      const restoreFocus = cancelClearRef.current?.parentElement?.contains(document.activeElement)
      setConfirmingClear(false)
      if (restoreFocus) requestAnimationFrame(() => clearButtonRef.current?.focus())
    }, 5000)
    return () => window.clearTimeout(timer)
  }, [confirmingClear])

  const close = () => {
    setConfirmingClear(false)
    onClose()
    document.getElementById('notes-toggle')?.focus()
  }

  return (
    <StudioPanel id="lecture-notes-panel" side="left" title="Notes" open={open} onClose={close}>
      {status && (
        <p role="status" className="flex items-center gap-2 border-b border-line bg-sunken px-4 py-2 text-xs text-muted">
          {phase === 'building' && configured && !editingCrop && <span className="ui-spinner-dot" aria-hidden="true" />}
          {status}
        </p>
      )}
      {error && (
        <p role="alert" className="border-b border-warn-line bg-warn-soft px-4 py-2 text-xs leading-relaxed text-warn">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
        {hasNotes ? (
          <>
            {notes.title && (
              <h3 className="mb-4 text-xl leading-tight font-semibold tracking-tight wrap-anywhere">{notes.title}</h3>
            )}
            <div className="divide-y divide-line">
              {notes.sections.map((section) => (
                <section key={section.id} className="py-4 first:pt-0 animate-fade-in">
                  <SectionHeading className="ui-label mb-2 wrap-anywhere">{section.heading}</SectionHeading>
                  <NoteBody markdown={section.body_markdown} />
                  {section.figure && (
                    <img
                      src={section.figure}
                      alt={'Board snapshot for ' + section.heading}
                      loading="lazy"
                      className="mt-3 max-w-full rounded-lg border border-line"
                    />
                  )}
                </section>
              ))}
            </div>
          </>
        ) : (
          <div className="flex min-h-full flex-col items-center justify-center gap-2 p-3 text-center">
            <span className="grid size-10 place-items-center rounded-xl bg-accent-soft text-accent" aria-hidden="true">
              <NotebookPen className="size-5" />
            </span>
            <p className="text-sm font-semibold text-ink">No notes yet</p>
            {active && <p className="ui-copy max-w-[26ch]">Notes appear here as the board changes.</p>}
          </div>
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t border-line p-3">
        {confirmingClear && hasNotes ? (
          <div role="group" aria-label="Clear all notes" className="flex w-full items-center gap-2 animate-fade-in">
            <span className="mr-auto text-xs font-medium text-ink">Clear all notes?</span>
            <button
              ref={cancelClearRef}
              type="button"
              onClick={() => {
                setConfirmingClear(false)
                requestAnimationFrame(() => clearButtonRef.current?.focus())
              }}
              className="ui-button ui-compact"
              data-variant="quiet"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setConfirmingClear(false)
                onClear()
                document.getElementById('lecture-notes-panel-heading')?.focus()
              }}
              className="ui-button ui-compact"
              data-variant="danger-solid"
            >
              Clear
            </button>
          </div>
        ) : (
          <>
            <button type="button" onClick={onExportMarkdown} disabled={!hasNotes} className="ui-button ui-compact" aria-label="Export Markdown">
              <FileText aria-hidden="true" /> Markdown
            </button>
            <button type="button" onClick={onExportLatex} disabled={!hasNotes} className="ui-button ui-compact" aria-label="Export LaTeX">
              <FileCode2 aria-hidden="true" /> LaTeX
            </button>
            <button type="button" onClick={onExportPrint} disabled={!hasNotes} className="ui-button ui-compact" aria-label="Print notes or save as PDF">
              <Printer aria-hidden="true" /> Print
            </button>
            <button
              ref={clearButtonRef}
              type="button"
              onClick={() => setConfirmingClear(true)}
              disabled={!hasNotes}
              className="ui-button ui-compact ml-auto"
              data-variant="danger"
            >
              <Trash2 aria-hidden="true" /> Clear
            </button>
          </>
        )}
      </footer>
    </StudioPanel>
  )
}
