import { SettingsContent, SettingsContentProps } from './SettingsContent'
import { StudioPanel } from './StudioPanel'

export interface SettingsPanelProps extends SettingsContentProps {
  open: boolean
  onClose: () => void
}

export function SettingsPanel({ open, onClose, ...content }: SettingsPanelProps) {
  const close = () => {
    onClose()
    document.getElementById('settings-toggle')?.focus()
  }
  return (
    <StudioPanel id="studio-settings-panel" side="right" title="Settings" open={open} onClose={close}>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-4 pb-5">
        <SettingsContent {...content} />
      </div>
    </StudioPanel>
  )
}
