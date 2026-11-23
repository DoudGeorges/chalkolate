import { X } from 'lucide-react'
import { useEffect, useRef } from 'react'

export function StudioPanel({
  id,
  open,
  title,
  onClose,
  children,
}: {
  id: string
  open: boolean
  title: string
  onClose: () => void
  children: React.ReactNode
}) {
  const headingRef = useRef<HTMLHeadingElement>(null)
  useEffect(() => {
    if (open) headingRef.current?.focus({ preventScroll: true })
  }, [open])

  return (
    <div
      inert={!open}
      aria-hidden={!open}
      className={
        open
          ? 'studio-drawer h-[min(44dvh,25rem)] w-full opacity-100 visible lg:h-auto lg:w-88'
          : 'studio-drawer pointer-events-none h-0 w-full opacity-0 invisible lg:h-auto lg:w-0'
      }
    >
      <aside
        id={id}
        aria-labelledby={id + '-heading'}
        className="studio-panel"
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !event.defaultPrevented) {
            event.preventDefault()
            event.stopPropagation()
            onClose()
          }
        }}
      >
        <header className="panel-heading">
          <h2 ref={headingRef} id={id + '-heading'} tabIndex={-1} className="focus:outline-none">
            {title}
          </h2>
          <button type="button" onClick={onClose} aria-label={'Close ' + title.toLowerCase()} className="ui-icon">
            <X aria-hidden="true" />
          </button>
        </header>
        {children}
      </aside>
    </div>
  )
}
