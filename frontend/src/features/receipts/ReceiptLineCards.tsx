import type { ReactNode } from 'react'
import type { Line } from '../../api/receipts'
import { Card, CardList } from '../../lib/cards'
import type { CardFact } from '../../lib/cards'
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
  /** The former content of the row heading (`th`). */
  heading: (line: Line) => ReactNode
}

/**
 * The phone view of the lines table. A card is shorter than a row: a zero discount and a paid amount equal to
 * the amount are left out. The source values are compared, not the formatted text; an unreadable value is shown.
 */
export default function ReceiptLineCards({ lines, currency, columns, caption, heading }: Props) {
  return <CardList label="Строки чека" caption={caption}>
    {lines.map((line) => {
      const amount = canonical(line.amount)
      const facts: CardFact[] = [
        { key: 'quantity', label: columns[1], value: recognizedValue(formatQuantity(line.quantity, line.unit)) },
        { key: 'price', label: columns[2], value: price(line.unit_price, currency) },
        { key: 'amount', label: columns[3], value: money(line.amount, currency) },
        { key: 'discount', label: columns[4], value: canonical(line.discount_amount) === '0' ? null : money(line.discount_amount, currency) },
        { key: 'paid', label: columns[5], value: amount !== null && canonical(line.paid_amount) === amount ? null : money(line.paid_amount, currency) },
      ]
      return <Card id={`receipt-line-${line.id}`} key={line.id} title={heading(line)} facts={facts} />
    })}
  </CardList>
}
