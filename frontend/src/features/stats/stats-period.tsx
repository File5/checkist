import { useId, useState } from 'react'
import type { ReactNode } from 'react'
import Icon from '../../components/Icon'
import Sheet from '../../components/Sheet'
import { Link } from '../../navigation'
import './StatsBar.css'

/** A ready period of a tab: `href` null — not chosen yet (no receipts, or the range is still loading). */
export type PeriodChoice = { key: string; label: string; note?: string; href: string | null; active: boolean; title?: string }

export interface PeriodSheetProps {
  /** The chosen period in a few words: «Всё время», «2025 против 2026», «ноя 2025 — окт 2026». */
  label: ReactNode
  choices: PeriodChoice[]
  /** «Свой период»: the form calls `close` once its period is applied. */
  children: (close: () => void) => ReactNode
  /** A line above the ready periods, e.g. the exact months shown. */
  current?: ReactNode
  /** For the tests: the sheet drawn open without a click. */
  open?: boolean
}

/**
 * «Период: Всё время ▾» of a statistics tab on a phone: the button opens a sheet with the ready periods as rows and
 * «Свой период» under them. A chosen row or an applied period closes the sheet; the period itself lives in the address.
 */
export function PeriodSheet({ label, choices, children, current, open: openProp }: PeriodSheetProps) {
  const [opened, setOpened] = useState(false)
  const open = openProp ?? opened
  const id = useId()
  const close = () => setOpened(false)
  return <>
    <button type="button" className="stats-period-open" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
      onClick={() => setOpened(true)}>
      <span className="stats-period-text"><span className="stats-period-word">Период: </span><strong>{label}</strong></span>
      <Icon name="down" size={18} />
    </button>
    <Sheet open={open} onClose={close} title="Период" id={id}>
      <div className="stats-period-sheet">
        {current}
        {/* A link closes the sheet on its way: the next screen is the chosen period. */}
        <ul className="ck-list stats-period-list" onClick={(event) => { if (event.target instanceof Element && event.target.closest('a')) close() }}>
          {choices.map((choice) => {
            const text = <span className="stats-period-choice-text">
              <span className="stats-period-choice-label">{choice.label}</span>
              {choice.note && <span className="stats-period-choice-note">{choice.note}</span>}
            </span>
            return <li key={choice.key}>{choice.href === null
              ? <span className="stats-period-choice" aria-disabled="true" title={choice.title}>{text}</span>
              : <Link className="stats-period-choice" to={choice.href} aria-current={choice.active ? 'true' : undefined} title={choice.title}>
                {text}{choice.active && <Icon name="check" size={20} />}
              </Link>}</li>
          })}
        </ul>
        <h3 className="stats-period-custom">Свой период</h3>
        {children(close)}
      </div>
    </Sheet>
  </>
}
