import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'

export function StudioPanel({
  id,
  open,
  side,
  title,
  onClose,
  children,
}: {
  id: string
  open: boolean
  side: 'left' | 'right'
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (open) headingRef.current?.focus()
  }, [open])

  return (
    <aside
      id={id}
      hidden={!open}
      data-side={side}
      aria-labelledby={id + '-heading'}
      className={open ? 'studio-panel rounded-xl border border-line' : undefined}
      onKeyDown={(event) => {
        if (event.key === 'Escape' && !event.defaultPrevented) {
          event.preventDefault()
          event.stopPropagation()
          onClose()
        }
      }}
    >
      {open && (
        <>
          <header className="panel-heading">
            <h2 ref={headingRef} id={id + '-heading'} tabIndex={-1} className="focus:outline-none">
              {title}
            </h2>
            <button type="button" onClick={onClose} aria-label={'Close ' + title.toLowerCase()} className="ui-icon">
              <X aria-hidden="true" />
            </button>
          </header>
          {children}
        </>
      )}
    </aside>
  )
}
