import { X } from 'lucide-react'
import { SettingsContent, SettingsContentProps } from './SettingsContent'

export interface SettingsPanelProps extends SettingsContentProps {
  open: boolean
  onClose: () => void
}

/** Right-edge side panel that flex-resizes the stage instead of overlapping it. */
export function SettingsPanel({ open, onClose, ...content }: SettingsPanelProps) {
  return (
    <div
      data-testid="settings-panel-container"
      className={`relative z-30 shrink-0 overflow-hidden bg-white transition-[width,height] duration-200 ease-out ${
        open
          ? 'h-[42vh] w-full border-t border-line md:h-auto md:w-[360px] md:border-t-0 md:border-l'
          : 'h-0 w-full border-transparent md:h-auto md:w-0'
      }`}
    >
      <aside
        aria-label="Settings"
        aria-hidden={!open}
        inert={!open}
        className="flex h-full w-full flex-col md:w-[360px]"
      >
        <header className="flex items-center justify-between gap-2 border-b border-line px-3 py-2">
          <h2 className="text-sm font-medium text-zinc-900">Settings</h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close settings"
            className="rounded p-1 text-zinc-600 hover:bg-zinc-100 hover:text-zinc-900"
          >
            <X className="h-4 w-4" aria-hidden />
          </button>
        </header>
        <div className="flex-1 overflow-y-auto p-4">
          <SettingsContent {...content} />
        </div>
      </aside>
    </div>
  )
}
