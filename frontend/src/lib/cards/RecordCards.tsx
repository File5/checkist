import type { ReactNode } from 'react'
import './Cards.css'

export type CardFactKind = 'value' | 'text' | 'block'

export interface CardFact {
  key: string
  /** The heading of the table column this fact replaces. */
  label: string
  /** null, undefined, false and an empty string mean "no fact": the pair is not rendered. */
  value: ReactNode
  /** `value` (default) — one unbreakable value; `text` — free text; `block` — a list or a `dl` under the label. */
  kind?: CardFactKind
}

export type CardListProps = ({ label: string; labelledBy?: undefined } | { labelledBy: string; label?: undefined }) & {
  /** The former `<caption>` of the table. */
  caption?: ReactNode
  children: ReactNode
}

export interface CardProps {
  /** With an id the card is a target of a link (`#receipt-line-3`) and takes the focus from a script. */
  id?: string
  /** The former content of the row heading (`th`), links included. */
  title: ReactNode
  facts: CardFact[]
  /** Actions of the row. */
  footer?: ReactNode
  tone?: 'total'
}

const empty = (value: ReactNode) => value === null || value === undefined || value === false || value === ''

/** The phone view of a table: a list of cards. Renders markup only, the screen chooses the view with useNarrow(). */
export function CardList({ label, labelledBy, caption, children }: CardListProps) {
  return (
    <div className="ck-cards">
      {empty(caption) ? null : <p className="ck-cards-caption">{caption}</p>}
      <ul className="ck-cards-list" aria-label={label} aria-labelledby={labelledBy}>{children}</ul>
    </div>
  )
}

/** One row of the table: the heading and the pairs "column heading — value" in the order of the columns. */
export function Card({ id, title, facts, footer, tone }: CardProps) {
  const shown = facts.filter((fact) => !empty(fact.value))
  return (
    <li className="ck-card" id={id} tabIndex={id === undefined ? undefined : -1} data-tone={tone}>
      <div className="ck-card-title">{title}</div>
      {shown.length > 0 ? (
        <dl className="ck-card-facts">
          {shown.map((fact) => (
            <div className="ck-card-fact" data-kind={fact.kind ?? 'value'} key={fact.key}>
              <dt>{fact.label}</dt>
              <dd>{fact.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      {empty(footer) ? null : <div className="ck-card-footer">{footer}</div>}
    </li>
  )
}
