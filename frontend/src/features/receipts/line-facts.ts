/** Pure helpers of the lines of a receipt: the facts of a phone row and the categories of the header. */
import type { Line } from '../../api/receipts'
import type { NamedObject } from '../../api/types'
import { formatQuantity } from '../../lib/format'
import { money, price, recognizedValue } from './state'

/** The headings of the lines table in the order of its columns; the first one is the row heading. */
export type LineColumns = readonly [heading: string, quantity: string, price: string, amount: string, discount: string, paid: string]

/** A Decimal of the server as a comparable string: "2.50" and "2.5" are one value. Never a Number. */
export function canonical(value: string | null): string | null {
  const match = value === null ? null : /^(-?)(\d+)(?:\.(\d+))?$/.exec(value)
  if (!match) return null
  const whole = match[2].replace(/^0+(?=\d)/, '')
  const fraction = (match[3] ?? '').replace(/0+$/, '')
  const number = fraction ? `${whole}.${fraction}` : whole
  return number === '0' ? '0' : `${match[1]}${number}`
}

/** One fact under the name of a line: `label` is read by a screen reader only when `quiet`. */
export type LineFact = { key: 'quantity' | 'discount' | 'paid'; label: string; value: string; quiet?: boolean }

/**
 * The facts of a line row, in the order of the table columns. «2 шт × 1,29 €» — only when the quantity is not one (then
 * the price is the amount itself); a zero discount and a paid amount equal to the amount are left out. The source
 * values are compared, not the formatted text; an unreadable value is shown.
 */
export function lineFacts(line: Line, currency: string | undefined, columns: LineColumns): LineFact[] {
  const amount = canonical(line.amount)
  const quantity = canonical(line.quantity)
  const facts: (LineFact | null)[] = [
    quantity === '1' ? null : { key: 'quantity', label: `${columns[1]} и ${columns[2].toLocaleLowerCase('ru-RU')}`, quiet: true,
      value: `${recognizedValue(formatQuantity(line.quantity, line.unit))} × ${price(line.unit_price, currency)}` },
    canonical(line.discount_amount) === '0' ? null : { key: 'discount', label: columns[4], value: money(line.discount_amount, currency) },
    amount !== null && canonical(line.paid_amount) === amount ? null : { key: 'paid', label: columns[5], value: money(line.paid_amount, currency) },
  ]
  return facts.filter((fact): fact is LineFact => fact !== null)
}

/** The categories of the lines of a page, once each, in the order of the lines: the chips of the header. */
export function lineCategories(lines: Line[]): NamedObject[] {
  const seen = new Map<number, NamedObject>()
  for (const line of lines) if (line.category && !seen.has(line.category.id)) seen.set(line.category.id, line.category)
  return [...seen.values()]
}

