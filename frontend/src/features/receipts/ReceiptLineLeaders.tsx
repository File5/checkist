import type { ReactNode } from 'react'
import type { Line } from '../../api/receipts'
import { lineFacts } from './line-facts'
import type { LineColumns } from './line-facts'
import { money, recognizedText } from './state'

export type { LineColumns } from './line-facts'

interface Props {
  lines: Line[]
  currency?: string
  columns: LineColumns
  /** The former `<caption>` of the table; none for a spend typed by hand, whose lines were never printed. */
  caption?: ReactNode
  /** Under the name and the facts: the category chip, the number on the receipt, the catalog link and the relations. */
  details: (line: Line) => ReactNode
}

/**
 * The phone view of the lines table: one row of the card per line — the printed name with the amount of the line at the
 * right, the facts under the name in one quiet line, then the details. The row stays the target of a line link: its id
 * and tabindex are those of the former table row.
 */
export default function ReceiptLineLeaders({ lines, currency, columns, caption, details }: Props) {
  return <div className="receipt-leaders">
    {caption && <p className="receipt-note">{caption}</p>}
    <ol className="receipt-leader-list" aria-label="Строки чека">{lines.map((line) => {
      const facts = lineFacts(line, currency, columns)
      return <li key={line.id} id={`receipt-line-${line.id}`} tabIndex={-1} className="receipt-leader">
        <div className="receipt-leader-main">
          <span className="receipt-printed-name">{recognizedText(line.name)}</span>
          {facts.length > 0 && <dl className="receipt-leader-facts">{facts.map((fact) => <div key={fact.key}>
            <dt className={fact.quiet ? 'receipt-visually-hidden' : undefined}>{fact.label}</dt><dd className="receipt-number">{fact.value}</dd>
          </div>)}</dl>}
          {details(line)}
        </div>
        <span className="receipt-leader-amount ck-figures"><span className="receipt-visually-hidden">{columns[3]}: </span>{money(line.amount, currency)}</span>
      </li>
    })}</ol>
  </div>
}
