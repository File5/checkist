import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import { useNarrow } from '../lib/cards'
import Sheet from './Sheet'
import { filtersButtonLabel } from './filters-label'
import './ResponsiveFilters.css'

export interface ResponsiveFiltersProps {
  /** How many filters differ from their defaults: «Фильтры (N)»; 0 shows «Фильтры». */
  count: number
  /** The existing filter form of the screen, unchanged. */
  children: ReactNode
  /** The heading of the sheet and the word of the button. */
  title?: string
  /** What stays in sight beside the button on a phone, usually a ChipScroller of the active filters. */
  summary?: ReactNode
}

/** The view itself, with the width given: the server render and the tests draw both views through it. */
export function ResponsiveFiltersView({ narrow, count, children, title = 'Фильтры', summary, open, onOpen, onClose, sheetId }: ResponsiveFiltersProps & {
  narrow: boolean
  open: boolean
  onOpen: () => void
  onClose: () => void
  sheetId: string
}) {
  if (!narrow) return <>{children}</>
  return (
    <div className="ck-filters">
      <div className="ck-filters-bar">
        <button type="button" className="ck-filters-toggle" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? sheetId : undefined}
          onClick={onOpen}>{filtersButtonLabel(count, title)}</button>
        {summary && <div className="ck-filters-summary">{summary}</div>}
      </div>
      {/* A filter form submitted inside the sheet has done its work: the sheet closes after the form's own handler. */}
      <Sheet open={open} onClose={onClose} title={title} id={sheetId}>
        <div className="ck-filters-sheet" onSubmit={onClose}>
          {children}
          <button type="button" className="ck-button-secondary ck-filters-done" onClick={onClose}>Готово</button>
        </div>
      </Sheet>
    </div>
  )
}

/**
 * The filters of a screen, by the width of the window: inline from 541 px, on a phone behind the button
 * «Фильтры (N)» that opens them in a sheet from the bottom. The screen wraps its existing form, unchanged:
 * `<ResponsiveFilters count={n}>{form}</ResponsiveFilters>`. A form that applies itself on change keeps doing so
 * inside the sheet; «Готово» or the submit closes it.
 */
export default function ResponsiveFilters(props: ResponsiveFiltersProps) {
  const narrow = useNarrow()
  const [open, setOpen] = useState(false)
  const sheetId = useId()
  return <ResponsiveFiltersView {...props} narrow={narrow} open={open && narrow} onOpen={() => setOpen(true)} onClose={() => setOpen(false)} sheetId={sheetId} />
}
