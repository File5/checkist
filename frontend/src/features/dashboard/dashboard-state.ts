import type { Dashboard, DashboardCategory, DashboardRecent, DashboardSubCategory, MonthCode } from '../../api/budget-types'
import { ownerName, peopleOf } from '../../lib/people'
import type { Person } from '../../lib/people'
import type { Decimal, LocalApiFailure } from '../../api/types'
import { formatCentsNumber } from '../../lib/money'
import { NBSP, glue } from '../../lib/text'

/** Money is counted in cents with BigInt: a Decimal never becomes a Number. A malformed value counts as zero. */
export function cents(value: Decimal | null | undefined): bigint {
  const match = value ? /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(value) : null
  if (!match) return 0n
  const result = BigInt(match[2]) * 100n + BigInt((match[3] ?? '').padEnd(2, '0'))
  return match[1] ? -result : result
}

const groupDigits = (digits: string) => digits.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP)

/** «287 450», «1 501»: whole units rounded up (`lib/money.ts`); the cents themselves stay exact. */
export function formatNumber(value: Decimal | bigint): string {
  return formatCentsNumber(typeof value === 'bigint' ? value : cents(value))
}

/** «287 450 KZT»: the whole value never breaks. */
export function formatMoney(value: Decimal | bigint, currency: string): string {
  return glue(formatNumber(value), currency)
}

/** «В октябре» at the start of a sentence. */
export function capitalize(text: string): string {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text
}

const nominative = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь']
const prepositional = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре']
const genitive = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря']

const monthIndex = (month: MonthCode) => Number(month.slice(5, 7)) - 1

/** «Октябрь 2026». */
export function monthTitle(month: MonthCode): string {
  return glue(nominative[monthIndex(month)], month.slice(0, 4))
}
/** «в сентябре». */
export function inMonth(month: MonthCode): string {
  return glue('в', prepositional[monthIndex(month)])
}
/** «12 октября»: a calendar date without a timezone conversion. */
export function dayAndMonth(date: string): string {
  return glue(String(Number(date.slice(8, 10))), genitive[Number(date.slice(5, 7)) - 1])
}

/** The month `delta` months away: `shiftMonth('2026-01', -1)` → `2025-12`. */
export function shiftMonth(month: MonthCode, delta: number): MonthCode {
  const total = Number(month.slice(0, 4)) * 12 + monthIndex(month) + delta
  return `${String(Math.floor(total / 12)).padStart(4, '0')}-${String((total % 12) + 1).padStart(2, '0')}`
}

/** The month of the device; the dashboard does not offer a month after it. */
export function deviceMonth(now: Date = new Date()): MonthCode {
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}`
}

/** «1 день», «2 дня», «5 дней». */
export function plural(count: number | bigint, one: string, few: string, many: string): string {
  const n = BigInt(count) < 0n ? -BigInt(count) : BigInt(count)
  const lastTwo = n % 100n
  const last = n % 10n
  if (lastTwo >= 11n && lastTwo <= 14n) return many
  if (last === 1n) return one
  if (last >= 2n && last <= 4n) return few
  return many
}

export type Comparison = { tone: 'less' | 'more' | 'same' | 'new'; text: string }

/** «на 12% меньше, чем в сентябре». Percent of the previous month, rounded half up; no comparison without the previous spends. */
export function compareMonths(spent: Decimal, previous: Decimal, previousMonth: MonthCode): Comparison | null {
  const now = cents(spent)
  const before = cents(previous)
  if (before <= 0n) return now > 0n ? { tone: 'new', text: `${inMonth(previousMonth)} трат не было` } : null
  const difference = now - before
  if (difference === 0n) return { tone: 'same', text: `столько же, сколько ${inMonth(previousMonth)}` }
  const absolute = difference < 0n ? -difference : difference
  const percent = (absolute * 200n + before) / (before * 2n)
  if (percent === 0n) return { tone: 'same', text: `почти столько же, сколько ${inMonth(previousMonth)}` }
  const less = difference < 0n
  return { tone: less ? 'less' : 'more', text: `на${NBSP}${groupDigits(percent.toString())}${NBSP}% ${less ? 'меньше' : 'больше'}, чем ${inMonth(previousMonth)}` }
}

export type Progress = {
  /** Width of the filled part, 0–100: an overspent bar is full. */
  percent: number
  over: boolean
  remaining: bigint
  overBy: bigint
}

/** Spent against a limit; no bar for a missing or non-positive limit. */
export function progress(spent: Decimal, limit: Decimal | null): Progress | null {
  if (limit === null) return null
  const total = cents(limit)
  if (total <= 0n) return null
  const used = cents(spent)
  const over = used > total
  const filled = used <= 0n ? 0n : over ? 100n : (used * 100n) / total
  return { percent: Number(filled), over, remaining: over ? 0n : total - used, overBy: over ? used - total : 0n }
}

/** Colour of a category: a stable number 1–6 by its id (`--ck-cat-N`); 0 — no category, the neutral colour.
 * The same mapping as «Траты» (src/lib/category-tone.ts). */
export { categoryTone } from '../../lib/category-tone'

/** «А» for «Андрей», «АМ» for «anna_maria»: up to two letters of the name's parts (src/lib/people.ts). */
export { initials } from '../../lib/people'

/** The family of the month with names to show; the usernames stay the keys. */
export function dashboardPeople(data: Dashboard): Person[] {
  return peopleOf(data.members, data.people)
}

/** The limited sub-categories under a top-level row; an older server sends none. */
export function subCategories(category: DashboardCategory | DashboardSubCategory): DashboardSubCategory[] {
  return category.children ?? []
}

/** First letter of a category for its badge. */
export function badgeLetter(name: string | null, title: string): string {
  return ([...(name ?? title).trim()][0] ?? '•').toUpperCase()
}

/** «Лиза · 12 октября · 23 позиции», «вручную» for a spend without a receipt; the name, or the username without one. */
export function recentMeta(item: DashboardRecent): string {
  const what = item.source === 'manual' ? 'вручную'
    : glue(String(item.lines_count), plural(item.lines_count, 'позиция', 'позиции', 'позиций'))
  return [ownerName(item), dayAndMonth(item.purchased_on), what].join(' · ')
}

/** «ещё 19 дней» до конца месяца. */
export function daysLeftText(days: number): string {
  return glue('ещё', String(days), plural(days, 'день', 'дня', 'дней'))
}

/** A month with nothing spent in any currency: limits may still be there with zeros. */
export function monthIsEmpty(data: Dashboard): boolean {
  return data.currencies.every((block) => cents(block.spent) === 0n)
}

/** The id of a category by its name, for the colour of a recent spend's badge: the dashboard sends the name only. */
export function categoryIds(data: Dashboard): Map<string, number> {
  const ids = new Map<string, number>()
  const add = (category: DashboardCategory | DashboardSubCategory) => {
    if (category.category_id !== null && !ids.has(category.name)) ids.set(category.name, category.category_id)
    subCategories(category).forEach(add)
  }
  for (const block of data.currencies) block.categories.forEach(add)
  return ids
}

/** Local texts only: a server message never reaches the screen. */
export function dashboardErrorMessage(failure: Pick<LocalApiFailure, 'reason'>): string {
  switch (failure.reason) {
    case 'timeout': return 'Сервер не ответил вовремя. Повторите попытку.'
    case 'network': return 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.'
    case 'database_unavailable': return 'Данные временно недоступны. Повторите попытку позже.'
    case 'invalid_parameter': case 'invalid_request': return 'Не удалось открыть этот месяц. Вернитесь к текущему.'
    case 'permission_denied': return 'Нет доступа к тратам. Войдите под своей учётной записью.'
    case 'invalid_response': return 'Сервер вернул неожиданный ответ. Повторите попытку.'
    default: return 'Не удалось загрузить траты месяца. Повторите попытку.'
  }
}
