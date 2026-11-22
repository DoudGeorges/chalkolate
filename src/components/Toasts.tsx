import { CircleAlert, CircleCheck, Info, X } from 'lucide-react'

export interface ToastItem {
  id: string
  message: string
  tone?: 'info' | 'success' | 'error'
  actionLabel?: string
  onAction?: () => void
}

export interface ToastsProps {
  toasts: readonly ToastItem[]
  onDismiss: (id: string) => void
}

const TOAST_STYLE = {
  info: { icon: Info, color: 'bg-sunken text-accent' },
  success: { icon: CircleCheck, color: 'bg-moss-soft text-moss' },
  error: { icon: CircleAlert, color: 'bg-danger-soft text-danger' },
} as const

export function Toasts({ toasts, onDismiss }: ToastsProps) {
  if (!toasts.length) return null
  return (
    <div className="pointer-events-none fixed inset-x-3 bottom-3 z-50 flex flex-col gap-2 pb-[env(safe-area-inset-bottom)] sm:inset-x-auto sm:right-5 sm:bottom-5 sm:w-[22rem]">
      {toasts.slice(0, 3).map((toast) => {
        const { icon: Icon, color } = TOAST_STYLE[toast.tone ?? 'info']
        return (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className="pointer-events-auto flex items-start gap-2 rounded-xl border border-line bg-panel p-3 text-sm text-ink shadow-pop animate-rise-in"
          >
            <span className={'grid size-7 shrink-0 place-items-center rounded-lg ' + color} aria-hidden="true">
              <Icon className="size-4" />
            </span>
            <div className="min-w-0 flex-1 self-center">
              <p className="leading-relaxed wrap-anywhere">{toast.message}</p>
              {toast.actionLabel && toast.onAction && (
                <button
                  type="button"
                  onClick={() => {
                    toast.onAction?.()
                    onDismiss(toast.id)
                  }}
                  className="ui-button ui-compact mt-2"
                >
                  {toast.actionLabel}
                </button>
              )}
            </div>
            <button type="button" onClick={() => onDismiss(toast.id)} aria-label="Dismiss notification" className="ui-icon size-8">
              <X aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
