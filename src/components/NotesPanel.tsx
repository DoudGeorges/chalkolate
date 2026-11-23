import { ChevronLeft, Download, NotebookPen, Trash2 } from 'lucide-react'
import { useEffect, useMemo, useRef, useState } from 'react'
import { NotesDocument, renderNotesBodyHtml } from '../lib/notes'
import { StudioPanel } from './StudioPanel'

export interface NotesPanelProps {
  open: boolean
  active: boolean
  notes: NotesDocument
  onToggle: () => void
  onClose: () => void
  onDownload: () => void
  onClear: () => void
}

function NoteBody({ markdown }: { markdown: string }) {
  const html = useMemo(() => renderNotesBodyHtml(markdown), [markdown])
  return (
    <div
      className="ui-copy space-y-2.5 overflow-x-auto wrap-anywhere [&_li]:ml-4 [&_ol]:list-decimal [&_ul]:list-disc [&_code]:rounded [&_code]:bg-sunken [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:text-[0.85em] [&_code]:text-ink [&_strong]:font-semibold [&_strong]:text-ink [&_.katex-display]:my-2 [&_.katex-display]:overflow-x-auto"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  )
}

export function NotesPanel({
  open,
  active,
  notes,
  onToggle,
  onClose,
  onDownload,
  onClear,
}: NotesPanelProps) {
  const hasNotes = notes.sections.length > 0
  const SectionHeading = notes.title ? 'h4' : 'h3'
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
    <div className="flex shrink-0 flex-col lg:-my-3 lg:-mr-3 lg:ml-3 lg:flex-row lg:items-stretch">
      <button
        type="button"
        id="notes-toggle"
        onClick={onToggle}
        aria-expanded={open}
        aria-controls="lecture-notes-panel"
        aria-label={open ? 'Hide notes' : 'Show notes'}
        title={open ? 'Hide notes' : 'Show notes'}
        className={`group/toggle flex shrink-0 items-center justify-center gap-1.5 self-end border border-line bg-panel text-xs font-medium text-ink transition-[background-color,border-color,color] duration-150 hover:border-control-line hover:bg-sunken mt-2 h-8 px-2.5 lg:z-10 lg:mt-0 lg:mb-0 lg:-mr-px lg:h-14 lg:w-6 lg:flex-col lg:self-center lg:rounded-l-lg lg:rounded-r-none lg:border lg:border-r-0 lg:border-line lg:px-0 lg:py-2.5 ${
          open ? 'z-10 max-lg:-mb-px max-lg:rounded-t-lg max-lg:rounded-b-none max-lg:border-b-0' : 'rounded-lg'
        }`}
      >
        <ChevronLeft
          className={`size-4 shrink-0 text-muted transition-transform duration-[260ms] ease-[var(--ease-out-quint)] group-hover/toggle:text-ink ${
            open ? 'rotate-90 lg:rotate-180' : '-rotate-90 lg:rotate-0'
          }`}
          aria-hidden="true"
        />
        <span className="lg:hidden">Notes</span>
      </button>

      <StudioPanel id="lecture-notes-panel" title="Notes" open={open} onClose={close}>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4">
          {hasNotes ? (
            <>
              {notes.title && (
                <h3 className="mb-4 border-b border-line pb-3 text-lg leading-snug font-semibold tracking-tight text-ink wrap-anywhere">
                  {notes.title}
                </h3>
              )}
              <div className="divide-y divide-line">
                {notes.sections.map((section) => (
                  <section key={section.id} className="py-4 first:pt-0 last:pb-0 animate-fade-in">
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
            <div className="flex min-h-full flex-col items-center justify-center gap-2 p-4 text-center">
              <span className="grid size-11 place-items-center rounded-xl bg-accent-soft text-accent" aria-hidden="true">
                <NotebookPen className="size-5" />
              </span>
              <p className="ui-label">No notes yet</p>
              <p className="ui-copy max-w-[26ch]">
                {active ? 'Notes appear here as the board changes.' : 'Play the preview to build notes automatically.'}
              </p>
            </div>
          )}
        </div>

        <footer className="flex items-center justify-between gap-2 border-t border-line bg-panel px-4 py-3">
          {confirmingClear && hasNotes ? (
            <div role="group" aria-label="Clear all notes" className="flex w-full items-center gap-2 animate-fade-in">
              <span className="mr-auto text-xs font-semibold text-ink">Clear all notes?</span>
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
              <button type="button" onClick={onDownload} disabled={!hasNotes} className="ui-button ui-compact">
                <Download aria-hidden="true" /> Download
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
    </div>
  )
}
