/**
 * «Траты» on a phone: receipts grouped by day, the rows and the family filter. Pure functions only — the screen
 * renders what they return, the tests check them without a browser.
 */
import type { CurrencyCode, Decimal, ISODate } from '../../api/types'
import type { ReceiptListItem } from '../../api/receipts'
import type { ReceiptsQuery } from '../../navigation'
import type { Session } from '../../session'
import { glue } from '../../lib/text'
import { noPlace, recognizedText } from './state'

const months = ['янв', 'фев', 'мар', 'апр', 'мая', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']

/** The calendar date of the device: «today» is where the person is, not where the server is. */
export function localToday(now: Date = new Date()): ISODate {
  const pad = (value: number) => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** The day before a calendar date, counted on the calendar (no time zone, no daylight saving). */
export function previousDay(day: ISODate): ISODate {
  const [year, month, date] = day.split('-').map(Number)
  return new Date(Date.UTC(year, month - 1, date - 1)).toISOString().slice(0, 10)
}

/** «11 окт»; another year than today's — «11 окт 2025». The parts are glued: a date never breaks. */
export function shortDate(day: ISODate, today: ISODate): string {
  const [year, month, date] = day.split('-').map(Number)
  return glue(String(date), months[month - 1], ...(day.slice(0, 4) === today.slice(0, 4) ? [] : [String(year)]))
}

/** Header of a day: «Сегодня», «Вчера, 11 окт», «10 окт». */
export function dayLabel(day: ISODate, today: ISODate): string {
  if (day === today) return 'Сегодня'
  if (day === previousDay(today)) return `Вчера, ${shortDate(day, today)}`
  return shortDate(day, today)
}

const amountPattern = /^(-)?(\d+)(?:\.(\d{1,2}))?$/

/** Exact sum of money strings with up to two places, without floating point. `null` when a value is not money. */
export function sumAmounts(values: { amount: Decimal; sign: 1 | -1 }[]): Decimal | null {
  let cents = 0n
  for (const { amount, sign } of values) {
    const match = amountPattern.exec(amount)
    if (!match) return null
    const value = BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'))
    cents += (match[1] ? -value : value) * BigInt(sign)
  }
  const negative = cents < 0n
  const whole = negative ? -cents : cents
  return `${negative ? '-' : ''}${whole / 100n}.${String(whole % 100n).padStart(2, '0')}`
}

export type DayTotal = { currency: CurrencyCode; total: Decimal | null }
export type SpendDay = { day: ISODate; label: string; totals: DayTotal[]; receipts: ReceiptListItem[] }

/**
 * Receipts of one page grouped by `purchased_on`, in the order the API returned them (a day is one group even if
 * the ordering brought it twice). Each day has a total per currency in the order of first appearance — currencies
 * are never added together. A refund is subtracted. The total covers only the receipts of this page.
 */
export function groupByDay(receipts: ReceiptListItem[], today: ISODate): SpendDay[] {
  const days = new Map<ISODate, ReceiptListItem[]>()
  for (const receipt of receipts) {
    const list = days.get(receipt.purchased_on)
    if (list) list.push(receipt)
    else days.set(receipt.purchased_on, [receipt])
  }
  return [...days].map(([day, list]) => {
    const currencies = [...new Set(list.map((receipt) => receipt.currency))]
    return {
      day, label: dayLabel(day, today), receipts: list,
      totals: currencies.map((currency) => ({
        currency,
        total: sumAmounts(list.filter((receipt) => receipt.currency === currency)
          .map((receipt) => ({ amount: receipt.total, sign: receipt.operation === 'refund' ? -1 : 1 }))),
      })),
    }
  })
}

/** Title of a row: the place; a spend without a place — its first line, then its category, then «Без места». */
export function rowTitle(receipt: ReceiptListItem): string {
  if (receipt.store) return recognizedText(receipt.store.name)
  return receipt.first_line?.trim() || receipt.category?.name.trim() || noPlace
}

const plural = (count: number, one: string, few: string, many: string) => {
  const tens = count % 100
  const units = count % 10
  if (tens >= 11 && tens <= 14) return many
  return units === 1 ? one : units >= 2 && units <= 4 ? few : many
}

/** «23 позиции» with the number glued to its word. */
export function positions(count: number): string {
  return glue(count.toLocaleString('ru-RU'), plural(count, 'позиция', 'позиции', 'позиций'))
}

/** «Категория · Владелец · N позиций»; the owner only in a family, «Возврат» for a refund. */
export function rowMeta(receipt: ReceiptListItem, showOwner: boolean): string[] {
  return [
    ...(receipt.category ? [receipt.category.name] : []),
    ...(showOwner ? [receipt.owner] : []),
    positions(receipt.lines_count),
    ...(receipt.operation === 'refund' ? ['Возврат'] : []),
  ]
}

/** The colour of a category: one mapping for every screen (src/lib/category-tone.ts). */
export { categoryTone, categoryTones } from '../../lib/category-tone'

export type OwnerChip = { label: string; owner: string | undefined; current: boolean }

/** «Вся семья» and each member; without a household no chips at all. */
export function ownerChips(session: Session, owner: string | undefined): OwnerChip[] {
  if (session.kind !== 'user' || session.household === null) return []
  return [
    { label: 'Вся семья', owner: undefined, current: owner === undefined },
    ...session.household.members.map((member) => ({ label: member, owner: member, current: owner === member })),
  ]
}

/** The list with another owner: other filters stay, the page goes back to the first. */
export function withOwner(query: ReceiptsQuery, owner: string | undefined): ReceiptsQuery {
  const next: ReceiptsQuery = { ...query, page: 1 }
  delete next.owner
  return owner ? { ...next, owner } : next
}

/**
 * Jobs with a crop waiting for a person (`needs_review`) that were not retried: the server filter `needs_review=1`, so
 * one request with `page_size=1` gives the count. A job is not counted by status: `partial_succeeded` also means a
 * failed crop next to an imported one, which nobody can confirm. Confirming the last crop takes the job off the list.
 */
export const reviewJobsQuery = { needs_review: 1, page: 1 } as const

/** «2 фото ждут проверки». */
export function reviewText(count: number): string {
  return `${glue(count.toLocaleString('ru-RU'), 'фото')} ${count % 10 === 1 && count % 100 !== 11 ? 'ждёт' : 'ждут'} проверки`
}
