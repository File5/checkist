/* mobile-foundation: temporary, integrator removes */
// Minimal copies of the shared pieces the «Основа» branch defines (components/Sheet.tsx, components/ChipScroller.tsx,
// components/ResponsiveFilters.tsx, the figure/tape/leader classes and the type scale of tokens.css). The money screens
// («Главная», «Лимиты», «Траты», чек, форма траты) import them from here until the merge; the integrator points the
// imports at the real components and deletes this file and _tmp-foundation.css.
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNarrow } from '../../lib/cards'
import './_tmp-foundation.css'

const focusable = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

/** A sheet from the bottom of the screen: a modal dialog with its title and «Закрыть»; Escape and the backdrop close it. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const id = useId()
  const panel = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose }, [onClose])
  useEffect(() => {
    if (!open) return
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null
    // A child may have focused its own control already (the confirm button of a deletion).
    if (panel.current && !panel.current.contains(document.activeElement)) panel.current.focus()
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close.current(); return }
      if (event.key !== 'Tab' || !panel.current) return
      const items = [...panel.current.querySelectorAll<HTMLElement>(focusable)]
      if (!items.length) return
      const first = items[0]
      const last = items[items.length - 1]
      if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.current)) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    const root = document.documentElement
    const overflow = root.style.overflow
    root.style.overflow = 'hidden'
    return () => {
      document.removeEventListener('keydown', onKey)
      root.style.overflow = overflow
      if (before?.isConnected) before.focus()
    }
  }, [open])
  if (!open) return null
  return <div className="ck-sheet-layer">
    <div className="ck-sheet-backdrop" aria-hidden="true" onClick={onClose} />
    <div ref={panel} className="ck-sheet" role="dialog" aria-modal="true" aria-labelledby={id} tabIndex={-1}>
      <div className="ck-sheet-head">
        <h2 id={id}>{title}</h2>
        <button type="button" className="ck-sheet-close" aria-label="Закрыть" onClick={onClose}>×</button>
      </div>
      <div className="ck-sheet-body">{children}</div>
    </div>
  </div>
}

/** One line of chips that scrolls sideways and fades at its edges, instead of wrapping into several lines. */
export function ChipScroller({ label, children }: { label: string; children: ReactNode }) {
  return <div className="ck-chip-scroller" role="group" aria-label={label}>{children}</div>
}

/** The filters form as it is on a wide screen; on a phone behind «Фильтры (N)», in a sheet. */
export function ResponsiveFilters({ count, children, narrow }: { count: number; children: ReactNode; narrow?: boolean }) {
  const phone = useNarrow()
  const [open, setOpen] = useState(false)
  if (!(narrow ?? phone)) return <>{children}</>
  return <>
    <button type="button" className="ck-filters-button" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>
      {count > 0 ? `Фильтры (${count})` : 'Фильтры'}
    </button>
    <Sheet open={open} onClose={() => setOpen(false)} title="Фильтры">{children}</Sheet>
  </>
}
