/**
 * A position of the spend form, like a line of a receipt (one form for every spend, 2026-10-13): name · quantity ·
 * unit · price per unit · discount · sum · category. The sum is counted by itself — quantity × price − discount; a
 * typed sum counts the price back. Pure rules, no network, no React; numbers are scaled `bigint`, never floats.
 */
import type { Line, ManualLineInput } from '../../api/receipts'
import type { Decimal, Unit } from '../../api/types'
import { formatPrice, formatQuantity } from '../../lib/format'
import { formatMoney } from '../../lib/money'
import { evaluateAmount, hasOperator } from './amount-calc'

export type LineDraft = {
  key: number
  /** The saved line being changed (`id` of the body): it keeps its product while its name stays. */
  id?: number
  name: string
  quantity: string
  unit: Unit
  /** Per unit, before the discount; `''` — not typed: the server counts it from the sum. */
  price: string
  /** `''` — none. */
  discount: string
  /** The sum to pay for the line: quantity × price − discount. */
  amount: string
  /** `null` — the category of the spend (of the product, on a photo receipt). */
  category: number | null
  /** What was typed last of price and sum: `amount` — a change of quantity or discount keeps the sum, the price follows. */
  lead?: 'price' | 'amount'
  /** A saved line read with a zero or negative sum (a returned deposit): it keeps its sign. */
  signed?: boolean
}
export type LineField = 'name' | 'quantity' | 'price' | 'discount' | 'amount'
export type LineErrors = Partial<Record<LineField, string>>

/** The units of lines, as on recognised receipts (`ReceiptLine.unit`). */
export const UNITS: Unit[] = ['pcs', 'kg', 'g', 'l', 'ml', 'm']
export const UNIT_LABELS: Record<Unit, string> = { pcs: 'шт', kg: 'кг', g: 'г', l: 'л', ml: 'мл', m: 'м' }
export const NAME_MAX = 200

export const lineMessages = {
  name: 'Назовите позицию.',
  quantity: 'Количество больше нуля, не больше трёх знаков после запятой.',
  price: 'Цена — число, не больше четырёх знаков после запятой.',
  discount: 'Скидка — от нуля до суммы позиции.',
  amount: 'Сумма позиции больше нуля, не больше двух знаков после запятой.',
} as const

let keys = 0
export function newLine(): LineDraft {
  keys += 1
  return { key: keys, name: '', quantity: '1', unit: 'pcs', price: '', discount: '', amount: '', category: null }
}

const MONEY = 2
const QUANTITY = 3
const PRICE = 4
const TEN = 10n

/** A typed decimal as a scaled `bigint` («1790,5» at 4 places → 17905000n, spaces of grouping dropped); `undefined` — not
 * a number of this kind. */
export function scaled(text: string, places: number, signed = false, whole = 12): bigint | undefined {
  const value = text.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.')
  const match = new RegExp(`^(-?)([0-9]{1,${whole}})(?:\\.([0-9]{1,${places}}))?$`).exec(value)
  if (!match || (match[1] && !signed)) return undefined
  const digits = BigInt(match[2] + (match[3] ?? '').padEnd(places, '0'))
  return match[1] ? -digits : digits
}

/** A scaled `bigint` as the API decimal without trailing zeros: 17905000n at 4 → «1790.5». */
export function decimalText(value: bigint, places: number): string {
  const negative = value < 0n
  const digits = (negative ? -value : value).toString().padStart(places + 1, '0')
  const fraction = digits.slice(-places).replace(/0+$/, '')
  return `${negative ? '-' : ''}${digits.slice(0, -places)}${fraction ? `.${fraction}` : ''}`
}

/** Cents as a person writes money in a field: «4500», «230.50» (two places once there are any). */
export function moneyText(cents: bigint): string {
  const text = decimalText(cents, MONEY)
  return /\.[0-9]$/.test(text) ? `${text}0` : text
}

/** `a / b`, rounded half away from zero. */
function divide(a: bigint, b: bigint): bigint {
  const negative = (a < 0n) !== (b < 0n)
  const [x, y] = [a < 0n ? -a : a, b < 0n ? -b : b]
  const result = (x * 2n + y) / (y * 2n)
  return negative ? -result : result
}

/** «4500.00» → «4500», «0.350» → «0.35»: a saved value as a person would type it. */
export function trimDecimal(value: Decimal): string {
  return value.includes('.') ? value.replace(/0+$/, '').replace(/\.$/, '') : value
}

const quantityOf = (line: LineDraft) => scaled(line.quantity.trim() || '1', QUANTITY, line.signed, 9)
const priceOf = (line: LineDraft) => line.price.trim() ? scaled(line.price, PRICE, false, 10) : undefined
const discountOf = (line: LineDraft) => line.discount.trim() ? scaled(line.discount, MONEY) : 0n
/** The sum to pay in cents; «1200+350» is counted (`amount-calc.ts`). */
export function sumOf(line: LineDraft): bigint | undefined {
  if (!line.signed && hasOperator(line.amount)) {
    const counted = evaluateAmount(line.amount)
    return counted === undefined ? undefined : scaled(counted, MONEY)
  }
  const value = scaled(line.amount, MONEY, line.signed)
  return value !== undefined && (value > 0n || line.signed) ? value : undefined
}

/** quantity × price − discount, in cents. */
function countedSum(quantity: bigint, price: bigint, discount: bigint): bigint {
  return divide(quantity * price, TEN ** 5n) - discount
}

/** (sum + discount) / quantity, at 4 places. */
function countedPrice(sum: bigint, discount: bigint, quantity: bigint): bigint {
  return divide((sum + discount) * TEN ** 5n, quantity)
}

/**
 * A typed field of a line, with its sum or price kept in step. A price, quantity or discount counts the sum
 * (quantity × price − discount); a typed sum counts the price ((sum + discount) / quantity). After a typed sum a change
 * of quantity or discount keeps the sum and counts the price again — «Панини 3 580», then «2 шт» reads 2 × 1 790.
 */
export function editLine(line: LineDraft, field: LineField, text: string): LineDraft {
  const next: LineDraft = { ...line, [field]: text }
  if (field === 'name') return next
  if (field === 'price') next.lead = 'price'
  if (field === 'amount') next.lead = text.trim() ? 'amount' : undefined
  const quantity = quantityOf(next)
  const discount = discountOf(next)
  if (quantity === undefined || quantity === 0n || discount === undefined) return next
  if (next.lead === 'amount') {
    const sum = sumOf(next)
    if (sum !== undefined && !(field === 'amount' && hasOperator(text))) next.price = decimalText(countedPrice(sum, discount, quantity), PRICE)
    return next
  }
  const price = priceOf(next)
  if (price !== undefined) next.amount = moneyText(countedSum(quantity, price, discount))
  return next
}

/** A calculation typed into the sum («1200+350») becomes its result when the field is left. */
export function settleLine(line: LineDraft): LineDraft {
  if (line.signed || !hasOperator(line.amount)) return line
  const counted = evaluateAmount(line.amount)
  return counted === undefined ? line : editLine(line, 'amount', counted)
}

/** Anything typed in the row: an untouched empty row is not a position. */
export const isFilled = (line: LineDraft) => Boolean(line.name.trim() || line.amount.trim() || line.price.trim())

/** The body of one line (`lines[]` of `POST /api/receipts/manual/` and `PATCH /api/receipts/{id}/`), or its messages.
 * `amount` of the body is before the discount, as the server stores it; the price goes only when it is typed or known. */
export function lineInput(line: LineDraft): { input: ManualLineInput } | { errors: LineErrors } {
  const errors: LineErrors = {}
  const name = line.name.trim()
  if (!name || [...name].length > NAME_MAX) errors.name = lineMessages.name
  const quantity = quantityOf(line)
  if (quantity === undefined || quantity === 0n) errors.quantity = lineMessages.quantity
  const price = line.price.trim() ? priceOf(line) : undefined
  if (line.price.trim() && price === undefined) errors.price = lineMessages.price
  const discount = discountOf(line)
  const sum = sumOf(line)
  if (sum === undefined) errors.amount = lineMessages.amount
  if (discount === undefined || (sum !== undefined && discount > 0n && sum < 0n)) errors.discount = lineMessages.discount
  if (Object.keys(errors).length || sum === undefined || quantity === undefined || discount === undefined) return { errors }
  return { input: {
    ...(line.id !== undefined && { id: line.id }), name, quantity: decimalText(quantity, QUANTITY), unit: line.unit,
    ...(price !== undefined && { unit_price: decimalText(price, PRICE) }),
    amount: decimalText(sum + discount, MONEY), discount_amount: decimalText(discount, MONEY), category: line.category,
  } }
}

/** The sum of the typed positions, cents; `undefined` while any of them is not a valid sum or none is typed. */
export function linesCents(lines: LineDraft[]): bigint | undefined {
  const filled = lines.filter(isFilled)
  if (!filled.length) return undefined
  let total = 0n
  for (const line of filled) {
    const sum = sumOf(line)
    if (sum === undefined) return undefined
    total += sum
  }
  return total
}

/** A saved line of a receipt (any source) as a row of the form. */
export function lineFromSaved(line: Line): LineDraft {
  const discount = scaled(line.discount_amount, MONEY, true) ?? 0n
  const amount = scaled(line.amount, MONEY, true) ?? 0n
  return {
    ...newLine(), id: line.id, name: line.name, quantity: trimDecimal(line.quantity), unit: line.unit,
    price: trimDecimal(line.unit_price), discount: discount ? moneyText(discount) : '',
    amount: moneyText(amount - discount), category: line.category?.id ?? null, signed: amount <= 0n,
  }
}

/** A line of a body (a parse, a past spend to repeat, a spend waiting offline) as a row of the form: `amount` of the
 * body is before the discount. */
export function lineFromBody(line: Pick<ManualLineInput, 'name' | 'amount'> & Partial<ManualLineInput>, category: number | null): LineDraft {
  const discount = line.discount_amount ? scaled(line.discount_amount, MONEY) ?? 0n : 0n
  const amount = scaled(line.amount, MONEY)
  return {
    ...newLine(), name: line.name, quantity: trimDecimal(line.quantity ?? '1'), unit: line.unit ?? 'pcs',
    price: line.unit_price ? trimDecimal(line.unit_price) : '', discount: discount ? moneyText(discount) : '',
    amount: amount === undefined ? line.amount : moneyText(amount - discount), category,
    lead: line.unit_price ? 'price' : 'amount',
  }
}

/** The row of a folded card on a phone: «Панини», «2 шт × 1 790,00 ₸ − 80 ₸» and the sum «3 500 ₸». `detail` is empty for
 * one piece without a discount. */
export function lineSummary(line: LineDraft, currency: string): { title: string; detail: string; sum: string } {
  const quantity = quantityOf(line)
  const discount = discountOf(line) ?? 0n
  const sum = sumOf(line)
  let price = priceOf(line)
  if (price === undefined && sum !== undefined && quantity) price = countedPrice(sum, discount, quantity)
  const single = quantity === 1000n && line.unit === 'pcs' && !discount
  const parts = single || quantity === undefined || price === undefined ? []
    : [`${formatQuantity(decimalText(quantity, QUANTITY), line.unit)} × ${formatPrice(decimalText(price, PRICE), currency)}`]
  if (discount) parts.push(`скидка ${formatMoney(decimalText(discount, MONEY), currency)}`)
  return {
    title: line.name.trim() || 'Без названия', detail: parts.join(' · '),
    sum: sum === undefined ? '—' : formatMoney(decimalText(sum, MONEY), currency),
  }
}
