import { statsFailureKind } from '../../api/stats'
import type { ReceiptCompare, ReceiptCompareParams, ReceiptSeries, ReceiptSeriesParams } from '../../api/stats'
import type { LocalApiFailure } from '../../api/types'
import { maxStatsStores, parseReceiptsStatsQuery, receiptsStatsHref } from '../../navigation'
import type { ReceiptsStatsInterval, ReceiptsStatsQuery } from '../../navigation'

export const dateFields = ['base_from', 'base_to', 'current_from', 'current_to'] as const
export type DateField = typeof dateFields[number]
export type FilterField = DateField | 'country' | 'currency' | 'store'
export type FilterDraft = Record<Exclude<FilterField, 'store'>, string> & { store: number[] }
export type FilterErrors = Partial<Record<FilterField, string>>
export type StatsFailure = LocalApiFailure

export const filterMessages = {
  required: 'Укажите дату: для сравнения нужны обе границы обоих периодов.',
  order: 'Начало периода должно быть не позже его окончания.',
  overlap: 'Периоды не должны пересекаться: текущий период начинается позже окончания базового.',
  date: 'Укажите дату в формате ГГГГ-ММ-ДД.',
  country: 'Выберите страну из списка или уберите фильтр страны.',
  currency: 'Выберите валюту из списка или уберите фильтр валюты.',
  store: `Выберите существующие магазины, не больше ${maxStatsStores}, или уберите фильтр магазинов.`,
} as const

export function filterDraft(query: ReceiptsStatsQuery): FilterDraft {
  return {
    base_from: query.base_from ?? '', base_to: query.base_to ?? '', current_from: query.current_from ?? '', current_to: query.current_to ?? '',
    country: query.country ?? '', currency: query.currency ?? '', store: [...(query.store ?? [])],
  }
}
export const sameDraft = (a: FilterDraft, b: FilterDraft) => JSON.stringify(a) === JSON.stringify(b)

type Dates = Partial<Record<DateField, string>>
/** What the comparison cannot be built from; the same fields the server names for a missing date and an overlap. */
export function periodProblems(dates: Dates): FilterErrors {
  const errors: FilterErrors = {}
  if (!dateFields.some((field) => dates[field])) return errors
  for (const field of dateFields) if (!dates[field]) errors[field] = filterMessages.required
  for (const [from, to] of [['base_from', 'base_to'], ['current_from', 'current_to']] as const) {
    if (dates[from] && dates[to] && dates[from] > dates[to]) { errors[from] = filterMessages.order; errors[to] = filterMessages.order }
  }
  if (dates.base_to && dates.current_from && !errors.current_from && dates.base_to >= dates.current_from) errors.current_from = filterMessages.overlap
  return errors
}

/** The form's draft as an address query. With errors nothing is applied; the interval of the chart is kept. */
export function applyFilters(query: ReceiptsStatsQuery, draft: FilterDraft): { query: ReceiptsStatsQuery; errors: FilterErrors } {
  const errors = periodProblems(draft)
  const params = new URLSearchParams()
  for (const field of [...dateFields, 'country', 'currency'] as const) if (draft[field]) params.set(field, draft[field])
  if (draft.store.length) params.set('store', draft.store.join(','))
  if (query.interval) params.set('interval', query.interval)
  const parsed = parseReceiptsStatsQuery(params)
  for (const field of parsed.invalidFields) {
    if (field === 'country' || field === 'currency' || field === 'store') errors[field] ??= filterMessages[field]
    else if ((dateFields as readonly string[]).includes(field)) errors[field as DateField] ??= filterMessages.date
  }
  return { query: parsed.query, errors }
}

export type ComparePlan =
  | { kind: 'idle' }
  | { kind: 'invalid'; errors: FilterErrors }
  | { kind: 'request'; params: ReceiptCompareParams }

const scope = ({ country, currency, store }: ReceiptsStatsQuery) => ({
  ...(country && { country }), ...(currency && { currency }), ...(store?.length && { store }),
})
/** No dates — nothing to compare yet; incomplete or overlapping periods are refused before a request. */
export function comparePlan(query: ReceiptsStatsQuery): ComparePlan {
  const errors = periodProblems(query)
  if (Object.keys(errors).length) return { kind: 'invalid', errors }
  const { base_from, base_to, current_from, current_to } = query
  if (!base_from || !base_to || !current_from || !current_to) return { kind: 'idle' }
  return { kind: 'request', params: { base_from, base_to, current_from, current_to, ...scope(query) } }
}
/** The chart spans from the start of the base period to the end of the current one; without dates — all receipts. */
export function seriesParams(query: ReceiptsStatsQuery): ReceiptSeriesParams {
  const date_from = query.base_from ?? query.current_from
  const date_to = query.current_to ?? query.base_to
  return { ...(date_from && { date_from }), ...(date_to && { date_to }), ...scope(query), interval: query.interval ?? 'month' }
}

export type CompareState =
  | { kind: 'idle' } | { kind: 'invalid'; errors: FilterErrors } | { kind: 'loading' }
  | { kind: 'ok'; data: ReceiptCompare } | StatsFailure
export type SeriesState = { kind: 'loading' } | { kind: 'ok'; data: ReceiptSeries } | StatsFailure

/** Problems of the applied address: local refusals plus the fields the server rejected in either block. */
export function appliedErrors(query: ReceiptsStatsQuery, failures: readonly ({ kind: string } | undefined)[]): FilterErrors {
  const errors: FilterErrors = { ...periodProblems(query) }
  for (const failure of failures as readonly (StatsFailure | undefined)[]) {
    if (failure?.kind !== 'error' || failure.reason !== 'invalid_parameter') continue
    for (const name of failure.fields ?? []) {
      // The series request names its bounds `date_from` / `date_to`.
      const field = name === 'date_from' ? (query.base_from ? 'base_from' : 'current_from')
        : name === 'date_to' ? (query.current_to ? 'current_to' : 'base_to') : name
      if (field === 'country' || field === 'currency' || field === 'store') errors[field] ??= filterMessages[field]
      else if ((dateFields as readonly string[]).includes(field)) {
        // A missing date and an overlap are refused before the request; this is the same wording for the server's refusal.
        errors[field as DateField] ??= !query[field as DateField] ? filterMessages.required
          : field === 'current_from' && name === field ? filterMessages.overlap : filterMessages.date
      }
    }
  }
  return errors
}
/** An applied problem marks a field only until the person edits that field. */
export function formErrors(draft: FilterDraft, applied: FilterDraft, submitted: FilterErrors, fromAddress: FilterErrors): FilterErrors {
  const errors: FilterErrors = { ...submitted }
  for (const field of Object.keys(fromAddress) as FilterField[]) {
    if (String(draft[field]) === String(applied[field])) errors[field] ??= fromAddress[field]
  }
  return errors
}

export const hasPeriods = (query: ReceiptsStatsQuery) => dateFields.some((field) => query[field])
export const hasScope = (query: ReceiptsStatsQuery) => Boolean(query.country || query.currency || query.store?.length)
/** Same periods without country, currency and stores. */
export const withoutScope = ({ base_from, base_to, current_from, current_to, interval }: ReceiptsStatsQuery): ReceiptsStatsQuery => ({
  ...(base_from && { base_from }), ...(base_to && { base_to }), ...(current_from && { current_from }), ...(current_to && { current_to }),
  ...(interval && { interval }),
})

/** Today's calendar date of the browser, for the presets only. */
export function localToday(now = new Date()): string {
  return `${String(now.getFullYear()).padStart(4, '0')}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`
}
export interface PeriodPreset { key: string; label: string; dates: Record<DateField, string> }
const fullYear = (year: number) => [`${year}-01-01`, `${year}-12-31`] as const
/** Ready pairs of periods; «этот год» ends today, so its months are not over yet. */
export function periodPresets(today: string): PeriodPreset[] {
  const year = Number(today.slice(0, 4))
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || year < 2) return []
  const pair = (key: string, label: string, base: number, current: readonly [string, string]): PeriodPreset => ({
    key, label, dates: { base_from: fullYear(base)[0], base_to: fullYear(base)[1], current_from: current[0], current_to: current[1] },
  })
  const thisYear = [`${year}-01-01`, today] as const
  return [
    ...(year - 1 > 2020 ? [pair('2020-now', `2020 против этого года (${year})`, 2020, thisYear)] : []),
    pair('last-now', `Прошлый год против этого (${year - 1} и ${year})`, year - 1, thisYear),
    pair('full-years', `${year - 2} против ${year - 1} (два полных года)`, year - 2, fullYear(year - 1)),
  ]
}
export const presetHref = (query: ReceiptsStatsQuery, preset: PeriodPreset) => receiptsStatsHref({ ...query, ...preset.dates })
export const isActivePreset = (query: ReceiptsStatsQuery, preset: PeriodPreset) => dateFields.every((field) => query[field] === preset.dates[field])

const intervalLabels: Record<ReceiptsStatsInterval, string> = { week: 'Неделя', month: 'Месяц', quarter: 'Квартал', year: 'Год' }
const intervalOrder: ReceiptsStatsInterval[] = ['week', 'month', 'quarter', 'year']
/** Month, quarter and year; a week is offered only when the address already asks for it. */
export function intervalChoices(current: ReceiptsStatsInterval): { interval: ReceiptsStatsInterval; label: string; active: boolean }[] {
  return intervalOrder.filter((interval) => interval !== 'week' || current === 'week')
    .map((interval) => ({ interval, label: intervalLabels[interval], active: interval === current }))
}
/** Coarser intervals to offer after `range_too_large`. */
export function coarserIntervals(current: ReceiptsStatsInterval): { interval: ReceiptsStatsInterval; label: string }[] {
  return intervalOrder.slice(intervalOrder.indexOf(current) + 1).map((interval) => ({ interval, label: intervalLabels[interval] }))
}
export const intervalHref = (query: ReceiptsStatsQuery, interval: ReceiptsStatsInterval) => receiptsStatsHref({ ...query, interval })

/** Local wording only: the server's message never reaches the screen. */
export function failureMessage(failure: StatsFailure): string {
  switch (statsFailureKind(failure)) {
    case 'invalid_parameter': return 'Сервер не принял параметры запроса. Исправьте отмеченные поля в форме выше или сбросьте фильтры.'
    case 'range_too_large': return 'Слишком много интервалов для одного графика: уменьшите период или укрупните интервал.'
    case 'permission_denied': return 'Статистика чеков доступна только в локальном режиме сервера, сейчас он выключен. Включите его в настройках сервера (DEBUG и ALLOW_LOCAL_RECOGNITION_API=1) и откройте приложение на этом же компьютере; без этого повтор не поможет.'
    case 'not_found': return 'Сервер не знает такого адреса статистики. Возможно, серверная часть старее клиента.'
    case 'invalid_response': return 'Сервер вернул неожиданный ответ. Повторите попытку.'
    case 'unavailable': switch (failure.reason) {
      case 'network': return 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.'
      case 'timeout': return 'Сервер не ответил вовремя. Повторите попытку.'
      case 'database_unavailable': return 'Данные чеков временно недоступны. Повторите попытку позже.'
      default: return 'Не удалось загрузить данные из-за ошибки сервера. Повторите попытку позже.'
    }
  }
}
/** A repeat of the same request can help; wrong parameters and a too large range need another request. */
export function canRetry(failure: StatsFailure): boolean {
  const kind = statsFailureKind(failure)
  return kind !== 'invalid_parameter' && kind !== 'range_too_large'
}
