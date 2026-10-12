import type { ReactNode } from 'react'
import type { Line } from '../../api/receipts'
import { formatQuantity } from '../../lib/format'
import { money, price, recognizedValue } from './state'

/** The headings of the lines table in the order of its columns; the first one is the row heading. */
export type LineColumns = readonly [heading: string, quantity: string, price: string, amount: string, discount: string, paid: string]

/** A Decimal of the server as a comparable string: "2.50" and "2.5" are one value. Never a Number. */
function canonical(value: string | null): string | null {
  const match = value === null ? null : /^(-?)(\d+)(?:\.(\d+))?$/.exec(value)
  if (!match) return null
  const whole = match[2].replace(/^0+(?=\d)/, '')
  const fraction = (match[3] ?? '').replace(/0+$/, '')
  const number = fraction ? `${whole}.${fraction}` : whole
  return number === '0' ? '0' : `${match[1]}${number}`
}

interface Props {
  lines: Line[]
  currency?: string
  columns: LineColumns
  /** The former `<caption>` of the table. */
  caption: ReactNode
  /** The name of the line, its category chip, catalog link and relations: the content of the former row heading. */
  heading: (line: Line) => ReactNode
}

/**
 * The phone view of the lines table: one leader row per line, «МОЛОКО ……… 3 EUR» — the amount of the line at the
 * right in the figures font, the rest of the row heading and the other facts under the name. A zero discount and a
 * paid amount equal to the amount are left out. The source values are compared, not the formatted text; an unreadable
 * value is shown. The row stays the target of a line link: its id and tabindex are those of the former table row.
 */
export default function ReceiptLineLeaders({ lines, currency, columns, caption, heading }: Props) {
  return <div className="receipt-leaders">
    <p className="receipt-note">{caption}</p>
    <ol className="receipt-leader-list" aria-label="Строки чека">{lines.map((line) => {
      const amount = canonical(line.amount)
      const facts: [key: string, label: string, value: string | null][] = [
        ['quantity', columns[1], recognizedValue(formatQuantity(line.quantity, line.unit))],
        ['price', columns[2], price(line.unit_price, currency)],
        ['discount', columns[4], canonical(line.discount_amount) === '0' ? null : money(line.discount_amount, currency)],
        ['paid', columns[5], amount !== null && canonical(line.paid_amount) === amount ? null : money(line.paid_amount, currency)],
      ]
      return <li key={line.id} id={`receipt-line-${line.id}`} tabIndex={-1} className="receipt-leader ck-leader">
        <div className="receipt-leader-main">
          {heading(line)}
          <dl className="receipt-leader-facts">{facts.filter(([, , value]) => value !== null).map(([key, label, value]) => <div key={key}>
            <dt>{label}</dt><dd className="receipt-number">{value}</dd>
          </div>)}</dl>
        </div>
        <span className="receipt-leader-amount ck-figures"><span className="receipt-visually-hidden">{columns[3]}: </span>{money(line.amount, currency)}</span>
      </li>
    })}</ol>
  </div>
}
