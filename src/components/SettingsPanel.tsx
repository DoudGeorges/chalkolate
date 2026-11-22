import { X } from 'lucide-react'
import { useCallback, useEffect, useRef } from 'react'
import { SettingsContent, SettingsContentProps } from './SettingsContent'

export interface SettingsPanelProps extends SettingsContentProps {
  open: boolean
  onClose: () => void
}

export function SettingsPanel({ open, onClose, ...content }: SettingsPanelProps) {
  const headingRef = useRef<HTMLHeadingElement>(null)

  const close = useCallback(() => {
    onClose()
    document.getElementById('settings-toggle')?.focus()
  }, [onClose])

  const closeRef = useRef(close)
  closeRef.current = close

  useEffect(() => {
    if (!open) return
    headingRef.current?.focus({ preventScroll: true })
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault()
        event.stopPropagation()
        closeRef.current()
      }
    }
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [open])

  if (!open) return null

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/35 p-4 sm:p-6 animate-fade-in"
      onClick={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div
        id="studio-settings-panel"
        role="dialog"
        aria-modal="true"
        aria-labelledby="studio-settings-panel-heading"
        className="flex max-h-[min(86dvh,42rem)] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-line bg-panel shadow-pop animate-rise-in"
      >
        <header className="panel-heading">
          <h2 ref={headingRef} id="studio-settings-panel-heading" tabIndex={-1} className="focus:outline-none">
            Settings
          </h2>
          <button type="button" onClick={close} aria-label="Close settings" className="ui-icon">
            <X aria-hidden="true" />
          </button>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-5">
          <SettingsContent {...content} />
        </div>
      </div>
    </div>
  )
}
