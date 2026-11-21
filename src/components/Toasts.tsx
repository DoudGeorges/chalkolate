import { AlertCircle, RefreshCw, X } from 'lucide-react'

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

export function Toasts({ toasts, onDismiss }: ToastsProps) {
  if (toasts.length === 0) return null

  return (
    <div
      aria-live="polite"
      className="pointer-events-none fixed top-16 left-1/2 z-50 flex w-full max-w-md -translate-x-1/2 flex-col items-center gap-2 px-4"
    >
      {toasts.slice(0, 3).map((toast) => {
        const ringTone =
          toast.tone === 'error'
            ? 'border-rose-500/40 text-rose-100'
            : toast.tone === 'success'
              ? 'border-emerald-500/40 text-emerald-100'
              : 'border-line text-zinc-100'

        return (
          <div
            key={toast.id}
            role={toast.tone === 'error' ? 'alert' : 'status'}
            className={`pointer-events-auto flex w-full items-center gap-2.5 rounded-xl border bg-panel px-3.5 py-2.5 text-xs shadow-2xl backdrop-blur-xl animate-pill-in ${ringTone}`}
          >
            {toast.tone === 'error' && (
              <AlertCircle className="h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden="true" />
            )}
            <span className="flex-1 leading-snug">{toast.message}</span>
            {toast.actionLabel && toast.onAction && (
              <button
                type="button"
                onClick={() => {
                  toast.onAction?.()
                  onDismiss(toast.id)
                }}
                className="inline-flex shrink-0 items-center gap-1 rounded-md bg-white/10 px-2 py-1 text-[11px] font-medium text-zinc-100 transition hover:bg-white/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
              >
                {toast.tone === 'error' && <RefreshCw className="h-3 w-3" aria-hidden="true" />}
                {toast.actionLabel}
              </button>
            )}
            <button
              type="button"
              aria-label="Dismiss notification"
              onClick={() => onDismiss(toast.id)}
              className="rounded p-0.5 text-zinc-400 transition hover:text-zinc-100"
            >
              <X className="h-3.5 w-3.5" aria-hidden="true" />
            </button>
          </div>
        )
      })}
    </div>
  )
}
