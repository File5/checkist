/* mobile-foundation: temporary, integrator removes */
/* A minimal copy of the shared pieces that the «Основа» work defines (docs/plans/2026-10-12-mobile-design.md):
   `components/Sheet.tsx`, `components/ChipScroller.tsx`, `components/ResponsiveFilters.tsx` and the tokens and classes
   of `_tmp-foundation.css` (and `filtersLabel` of `_tmp-foundation-state.ts`). The names and props are those of the
   contract: on merge the integrator points the imports of
   recognition, catalog, product and classification at the real components and deletes the three files. */
import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useNarrow } from '../../lib/cards'
import { filtersLabel } from './_tmp-foundation-state'
import './_tmp-foundation.css'

/** A sheet from the bottom of the window: a modal `<dialog>`, closed by its button, Escape or a tap on the backdrop.
 * Its content stays in the document while closed, so a half-filled form keeps what was typed. */
export function Sheet({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: ReactNode; children: ReactNode }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  useEffect(() => {
    const node = dialog.current
    if (!node) return
    try {
      if (open && !node.open) node.showModal()
      if (!open && node.open) node.close()
    } catch {
      // A browser without a modal dialog shows nothing; the page stays as it was.
    }
  }, [open])
  return <dialog ref={dialog} className="ck-sheet" aria-labelledby={titleId} onClose={onClose} onCancel={onClose}
    onClick={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <div className="ck-sheet-head">
      <h2 id={titleId}>{title}</h2>
      <button type="button" className="ck-sheet-close" onClick={onClose}>Закрыть</button>
    </div>
    <div className="ck-sheet-body">{children}</div>
  </dialog>
}

/** One row of chips scrolled sideways, with fading edges. `children` are the `<li>` of the chips. */
export function ChipScroller({ label, children }: { label: string; children: ReactNode }) {
  return <div className="ck-chip-scroller" role="region" aria-label={label} tabIndex={0}>
    <ul className="ck-chip-scroller-list">{children}</ul>
  </div>
}

/** The filters of a screen: as they are on a wide screen; on a phone behind «Фильтры (N)» in a sheet from the bottom.
 * A submit inside the sheet closes it, unless the form marked a field invalid in answer to it. */
export function ResponsiveFilters({ count, title = 'Фильтры', children }: { count: number; title?: string; children: ReactNode }) {
  const narrow = useNarrow()
  const [open, setOpen] = useState(false)
  const body = useRef<HTMLDivElement>(null)
  if (!narrow) return <>{children}</>
  return <>
    <button type="button" className="ck-filters-toggle" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(true)}>{filtersLabel(count)}</button>
    <Sheet open={open} onClose={() => setOpen(false)} title={title}>
      <div ref={body} className="ck-sheet-filters" onSubmit={() => {
        // After the form has drawn its answer: a refused field keeps the sheet open next to its message.
        setTimeout(() => { if (!body.current?.querySelector('[aria-invalid="true"]')) setOpen(false) })
      }}>{children}</div>
    </Sheet>
  </>
}
