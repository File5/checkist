/**
 * The period of «Динамика» without React: ready periods (chips), the period of the address, the two month fields «С» and
 * «По», their check in Russian and a period typed in words. Months are `ГГГГ-ММ` strings everywhere. Pure.
 */
import { glue } from '../../lib/text'
import { maxTrendsPeriodMonths, trendsHref, trendsSpan } from '../../navigation'
import type { TrendsQuery } from '../../navigation'
import { monthName } from './trends-state'

export interface Period { from: string; to: string }

/** The month `delta` months after `month` (before it when negative). */
export function shiftMonth(month: string, delta: number): string {
  const index = Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7)) - 1 + delta
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`
}
/** The local month of a date: the month of the person until the server says its own. */
export const monthOfDate = (date: Date) => `${String(date.getFullYear()).padStart(4, '0')}-${String(date.getMonth() + 1).padStart(2, '0')}`
export const periodMonths = (period: Period) => trendsSpan(period.from, period.to)
export const samePeriod = (a: Period, b: Period) => a.from === b.from && a.to === b.to
/** `months` months ending with `to`. */
export const lastMonths = (to: string, months: number): Period => ({ from: shiftMonth(to, 1 - months), to })

export const defaultPeriodMonths = 12
/** The period the address asks for: `from` … `to`, or the older `months` (12 without it) ending at `current`. */
export function resolvePeriod(query: TrendsQuery, current: string): Period {
  if (query.from && query.to) return { from: query.from, to: query.to }
  return lastMonths(current, query.months ?? defaultPeriodMonths)
}
/** Another period keeps the category and closes the opened month: it may be outside the new period. */
export const periodHref = (query: TrendsQuery, period: Period) =>
  trendsHref({ ...query, from: period.from, to: period.to, months: undefined, month: undefined })

// --- words ---

function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100
  const units = count % 10
  if (tens >= 11 && tens <= 14) return many
  if (units === 1) return one
  if (units >= 2 && units <= 4) return few
  return many
}
/** «1 месяц», «3 месяца», «12 месяцев», glued. */
export const monthsCount = (count: number) => glue(String(count), plural(count, 'месяц', 'месяца', 'месяцев'))
/** «май 2026 — октябрь 2026, 6 месяцев»; one month — «сентябрь 2026, 1 месяц». */
export function periodText(period: Period): string {
  const span = period.from === period.to ? monthName(period.from) : `${monthName(period.from)} — ${monthName(period.to)}`
  return `${span}, ${monthsCount(periodMonths(period))}`
}

// --- ready periods ---

export type PresetKey = 'm3' | 'm6' | 'm12' | 'm24' | 'this-year' | 'last-year' | 'all'
export const presetKeys: readonly PresetKey[] = ['m3', 'm6', 'm12', 'm24', 'this-year', 'last-year', 'all']
const presetLabels: Record<PresetKey, string> = {
  m3: monthsCount(3), m6: monthsCount(6), m12: monthsCount(12), m24: monthsCount(24),
  'this-year': 'Этот год', 'last-year': 'Прошлый год', all: 'Всё время',
}
/**
 * The period of a chip at the month `current`. «Всё время» starts at the first month with receipts (`first`), at most
 * 60 months back; without receipts, or before the range is known (`undefined`), it has no period.
 */
export function presetPeriod(key: PresetKey, current: string, first?: string | null): Period | null {
  const year = current.slice(0, 4)
  switch (key) {
    case 'm3': return lastMonths(current, 3)
    case 'm6': return lastMonths(current, 6)
    case 'm12': return lastMonths(current, 12)
    case 'm24': return lastMonths(current, 24)
    case 'this-year': return { from: `${year}-01`, to: current }
    case 'last-year': {
      const last = String(Number(year) - 1).padStart(4, '0')
      return { from: `${last}-01`, to: `${last}-12` }
    }
    case 'all': {
      if (!first) return null
      const from = first > current ? current : first
      return trendsSpan(from, current) > maxTrendsPeriodMonths ? lastMonths(current, maxTrendsPeriodMonths) : { from, to: current }
    }
  }
}
export interface PresetChoice {
  key: PresetKey
  label: string
  /** `null` — the chip cannot be chosen yet (no receipts, or the range is still loading). */
  href: string | null
  active: boolean
  /** «Всё время» longer than the server allows: the chip shows the last 60 months. */
  clipped: boolean
}
/** `hrefOf` — where a period leads: «Динамика» keeps its category, «Доходы» of the statistics pass their own. */
export function presetChoices(query: TrendsQuery, current: string, first?: string | null,
  hrefOf: (period: Period) => string = (period) => periodHref(query, period)): PresetChoice[] {
  const shown = resolvePeriod(query, current)
  return presetKeys.map((key) => {
    const period = presetPeriod(key, current, first)
    return {
      key, label: presetLabels[key], href: period && hrefOf(period), active: period !== null && samePeriod(period, shown),
      clipped: key === 'all' && period !== null && !!first && first < period.from,
    }
  })
}

/** The words of «Период: …» on a phone: the chosen ready period, otherwise its months, «ноя 2025 — окт 2026». */
export function periodLabel(period: Period, choices: readonly PresetChoice[]): string {
  const chosen = choices.find((choice) => choice.active)
  if (chosen) return chosen.label
  return period.from === period.to ? monthName(period.from, true) : `${monthName(period.from, true)} — ${monthName(period.to, true)}`
}

// --- the fields «С» and «По» ---

const monthWords: readonly (readonly string[])[] = [
  ['январь', 'января', 'январе', 'янв'], ['февраль', 'февраля', 'феврале', 'фев', 'февр'], ['март', 'марта', 'марте', 'мар'],
  ['апрель', 'апреля', 'апреле', 'апр'], ['май', 'мая', 'мае'], ['июнь', 'июня', 'июне', 'июн'], ['июль', 'июля', 'июле', 'июл'],
  ['август', 'августа', 'августе', 'авг'], ['сентябрь', 'сентября', 'сентябре', 'сен', 'сент'],
  ['октябрь', 'октября', 'октябре', 'окт'], ['ноябрь', 'ноября', 'ноябре', 'ноя', 'нояб'], ['декабрь', 'декабря', 'декабре', 'дек'],
]
/** 1–12 for a Russian month word in any of its usual forms («май», «мая», «сент.»), otherwise `null`. */
export function monthNumber(word: string): number | null {
  const clean = word.toLowerCase().replace(/ё/g, 'е').replace(/\.$/, '')
  const index = monthWords.findIndex((forms) => forms.includes(clean))
  return index < 0 ? null : index + 1
}
const label = (year: number, month: number) => `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}`
const realMonth = (year: number, month: number) => year >= 1901 && year <= 9999 && month >= 1 && month <= 12

/**
 * One month as a person types it: `05.2026`, `5.2026`, `05/2026`, `2026-05` (the value of a native month field) or
 * «май 2026». `null` — not a month; a year before 1901 is not one either, like on the server.
 */
export function parseMonthField(text: string): string | null {
  const value = text.trim().toLowerCase()
  let match = /^(\d{4})-(\d{1,2})$/.exec(value)
  if (match) return realMonth(Number(match[1]), Number(match[2])) ? label(Number(match[1]), Number(match[2])) : null
  match = /^(\d{1,2})\s*[./]\s*(\d{4})$/.exec(value)
  if (match) return realMonth(Number(match[2]), Number(match[1])) ? label(Number(match[2]), Number(match[1])) : null
  match = /^([а-яё]+\.?)\s+(\d{4})$/.exec(value)
  const number = match ? monthNumber(match[1]) : null
  return match && number !== null && realMonth(Number(match[2]), number) ? label(Number(match[2]), number) : null
}
/** The value of a field: `ГГГГ-ММ` in a native month field, `ММ.ГГГГ` in the text one. */
export const fieldValue = (month: string, native: boolean) => (native ? month : `${month.slice(5, 7)}.${month.slice(0, 4)}`)

/**
 * A native month field where the browser has one (iPhone and Android show a month and year picker, desktop Chrome too);
 * elsewhere (desktop Firefox and Safari) a text field «ММ.ГГГГ». Without a browser — the text field.
 */
export function supportsMonthInput(): boolean {
  if (typeof document === 'undefined') return false
  const input = document.createElement('input')
  input.setAttribute('type', 'month')
  return input.type === 'month'
}

export interface PeriodDraft { from: string; to: string }
export type PeriodErrors = Partial<Record<keyof PeriodDraft, string>>
export const periodMessages = {
  emptyFrom: 'Укажите месяц «С».',
  emptyTo: 'Укажите месяц «По».',
  format: 'Месяц — как 05.2026, 2026-05 или «май 2026»; год не раньше 1901.',
  order: '«По» не может быть раньше «С».',
  tooLong: (months: number) => `Не больше ${monthsCount(maxTrendsPeriodMonths)}, а здесь ${monthsCount(months)}.`,
}
/** «С» and «По» as a period, or the message of each wrong field. */
export function checkPeriod(draft: PeriodDraft): { period: Period } | { errors: PeriodErrors } {
  const errors: PeriodErrors = {}
  const from = parseMonthField(draft.from)
  const to = parseMonthField(draft.to)
  if (!draft.from.trim()) errors.from = periodMessages.emptyFrom
  else if (from === null) errors.from = periodMessages.format
  if (!draft.to.trim()) errors.to = periodMessages.emptyTo
  else if (to === null) errors.to = periodMessages.format
  if (from === null || to === null) return { errors }
  const months = trendsSpan(from, to)
  if (months < 1) return { errors: { to: periodMessages.order } }
  if (months > maxTrendsPeriodMonths) return { errors: { from: periodMessages.tooLong(months) } }
  return { period: { from, to } }
}

// --- a period in words ---

interface Spoken { month: number; year: number | null }
const spokenMonth = String.raw`(?:(\d{4})-(\d{1,2})|(\d{1,2})[./](\d{4})|([а-яё]+\.?)(?:\s+(\d{4}))?)`
const rangePattern = new RegExp(String.raw`^(?:с\s+)?${spokenMonth}(?:\s*[-–—]\s*|\s+(?:по|до)\s+)${spokenMonth}$`)
const singlePattern = new RegExp(String.raw`^${spokenMonth}$`)

function spoken(groups: (string | undefined)[]): Spoken | null {
  const [isoYear, isoMonth, dotMonth, dotYear, word, wordYear] = groups
  if (isoYear) return { year: Number(isoYear), month: Number(isoMonth) }
  if (dotYear) return { year: Number(dotYear), month: Number(dotMonth) }
  const month = word ? monthNumber(word) : null
  return month === null ? null : { month, year: wordYear ? Number(wordYear) : null }
}
const valid = (period: Period | null) => {
  if (!period) return null
  const [from, to] = [period.from, period.to].map((month) => realMonth(Number(month.slice(0, 4)), Number(month.slice(5, 7))))
  return from && to ? period : null
}

/**
 * A period typed in words, at the month `current`: «последние 9 месяцев», «9 мес», «полгода», «2026», «2025–2026»,
 * «этот год», «прошлый год», «май–октябрь 2026», «с ноября 2025 по март 2026», «05.2026–10.2026», «сентябрь 2026».
 * A month without a year is the nearest one not later than `current`; «май — октябрь» without a year ends in the last
 * October. A year is cut at `current`. `null` — not understood; the length is checked later, with the fields.
 */
export function parsePeriodPhrase(text: string, current: string): Period | null {
  const value = text.trim().toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').replace(/(?:\s+|(?<=\d))(?:года|год|гг?)\.?$/, '')
  if (!value) return null
  const currentYear = Number(current.slice(0, 4))
  const currentMonth = Number(current.slice(5, 7))
  const cut = (period: Period): Period | null => (period.from > current ? null : { from: period.from, to: period.to > current ? current : period.to })

  let match = /^(?:за\s+)?(?:последн\S*\s+)?(\d{1,2})\s*мес\S*$/.exec(value)
  if (match) return Number(match[1]) >= 1 ? lastMonths(current, Number(match[1])) : null
  if (/^(?:за\s+)?(?:последн\S*\s+)?полгода$/.test(value)) return lastMonths(current, 6)
  if (/^(?:за\s+)?(?:последн\S*\s+)?месяц$/.test(value)) return lastMonths(current, 1)
  if (/^(?:за\s+)?последн\S*$/.test(value) || value === 'за') return lastMonths(current, 12)
  if (/^(?:за\s+)?(?:этот|текущий|нынешний)(?: год)?$/.test(value)) return { from: `${current.slice(0, 4)}-01`, to: current }
  if (/^(?:за\s+)?прошлый(?: год)?$/.test(value)) return valid({ from: label(currentYear - 1, 1), to: label(currentYear - 1, 12) })
  match = /^(\d{4})(?:\s*[-–—]\s*(\d{4}))?$/.exec(value)
  if (match) {
    const [first, last] = [Number(match[1]), Number(match[2] ?? match[1])]
    return first > last ? null : valid(cut({ from: label(first, 1), to: label(last, 12) }))
  }

  const range = rangePattern.exec(value)
  if (range) {
    const left = spoken(range.slice(1, 7))
    const right = spoken(range.slice(7, 13))
    if (!left || !right) return null
    let rightYear = right.year
    let leftYear = left.year
    if (rightYear === null && leftYear !== null) rightYear = right.month >= left.month ? leftYear : leftYear + 1
    if (rightYear === null) rightYear = right.month <= currentMonth ? currentYear : currentYear - 1
    if (leftYear === null) leftYear = left.month <= right.month ? rightYear : rightYear - 1
    return valid({ from: label(leftYear, left.month), to: label(rightYear, right.month) })
  }
  const single = singlePattern.exec(value)
  if (single) {
    const one = spoken(single.slice(1, 7))
    if (!one) return null
    const year = one.year ?? (one.month <= currentMonth ? currentYear : currentYear - 1)
    return valid({ from: label(year, one.month), to: label(year, one.month) })
  }
  return null
}
