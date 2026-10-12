/**
 * «Выгрузка» (`/export`): the filters of the screen live in the address, so a filter set can be bookmarked.
 * Pure functions only: parsing the address, building it back, the period presets and the query of `/api/export/`.
 *
 * A wrong value in the address is dropped and the screen opens without it (as on the statistics screens).
 */

export const periods = ['this-month', 'last-month', '3-months', 'year', 'all', 'custom'] as const
export type Period = typeof periods[number]
export const sources = ['photo', 'manual', 'statement'] as const
export type Source = typeof sources[number]
/** Sections a person may switch; `receipts` itself is always exported. */
export const sections = ['lines', 'categories', 'stores', 'limits', 'summary', 'media'] as const
export type Section = typeof sections[number]
export const defaultSections: readonly Section[] = ['lines', 'categories', 'stores', 'limits', 'summary']
/** The server accepts no more than this many values in one list filter. */
export const maxListValues = 50

export const periodLabels: Record<Period, string> = {
  'this-month': 'Этот месяц', 'last-month': 'Прошлый месяц', '3-months': '3 месяца', year: 'Год', all: 'Всё время', custom: 'Свой период',
}
export const sourceLabels: Record<Source, string> = { photo: 'Чеки с фото', manual: 'Вручную', statement: 'Выписки' }
export const sectionLabels: Record<Section, string> = {
  lines: 'Строки чеков', categories: 'Категории', stores: 'Магазины', limits: 'Лимиты', summary: 'Сводка', media: 'Ссылки на фото',
}

export interface ExportQuery {
  /** Absent — «Этот месяц». */
  period?: Exclude<Period, 'this-month'>
  /** Only with `period: 'custom'`. */
  from?: string
  to?: string
  category?: number[]
  source?: Source[]
  owner?: string[]
  store?: number[]
  currency?: string
  /** Absent — the default sections. */
  sections?: Section[]
}

const isoDate = /^\d{4}-\d{2}-\d{2}$/
const validDate = (value: string | null | undefined): string | undefined => {
  if (!value || !isoDate.test(value)) return undefined
  const [year, month, day] = value.split('-').map(Number)
  const parsed = new Date(Date.UTC(year, month - 1, day))
  return parsed.getUTCFullYear() === year && parsed.getUTCMonth() === month - 1 && parsed.getUTCDate() === day ? value : undefined
}

const list = (params: URLSearchParams, name: string): string[] => {
  const values = params.getAll(name).flatMap((value) => value.split(',')).map((value) => value.trim()).filter(Boolean)
  return [...new Set(values)].slice(0, maxListValues)
}
const ids = (params: URLSearchParams, name: string): number[] =>
  list(params, name).filter((value) => /^[1-9]\d{0,15}$/.test(value)).map(Number)
const oneOf = <T extends string>(choices: readonly T[], values: string[]): T[] => choices.filter((choice) => values.includes(choice))

export function parseExportQuery(search: string | URLSearchParams): ExportQuery {
  const params = typeof search === 'string' ? new URLSearchParams(search) : search
  const query: ExportQuery = {}
  const period = params.get('period')
  if (period && period !== 'this-month' && (periods as readonly string[]).includes(period)) query.period = period as ExportQuery['period']
  if (query.period === 'custom') {
    const from = validDate(params.get('from'))
    const to = validDate(params.get('to'))
    if (from) query.from = from
    if (to && !(from && to < from)) query.to = to
  }
  const category = ids(params, 'category')
  if (category.length) query.category = category
  const source = oneOf(sources, list(params, 'source'))
  if (source.length) query.source = source
  const owner = list(params, 'owner').filter((value) => value.length <= 150)
  if (owner.length) query.owner = owner
  const store = ids(params, 'store')
  if (store.length) query.store = store
  const currency = params.get('currency')?.trim().toUpperCase()
  if (currency && /^[A-Z]{3}$/.test(currency)) query.currency = currency
  if (params.has('sections')) {
    const chosen = oneOf(sections, list(params, 'sections'))
    if (!sameSections(chosen, defaultSections)) query.sections = chosen
  }
  return query
}

function sameSections(a: readonly Section[], b: readonly Section[]) {
  return a.length === b.length && a.every((value) => b.includes(value))
}

/** The address of the screen: `?period=…&category=1,2…`; the defaults are left out. */
export function buildExportQuery(query: ExportQuery): string {
  const params = new URLSearchParams()
  if (query.period) params.set('period', query.period)
  if (query.period === 'custom') {
    if (query.from) params.set('from', query.from)
    if (query.to) params.set('to', query.to)
  }
  if (query.category?.length) params.set('category', query.category.join(','))
  if (query.source?.length) params.set('source', oneOf(sources, query.source).join(','))
  if (query.owner?.length) params.set('owner', query.owner.join(','))
  if (query.store?.length) params.set('store', query.store.join(','))
  if (query.currency) params.set('currency', query.currency)
  if (query.sections && !sameSections(query.sections, defaultSections)) {
    params.set('sections', oneOf(sections, query.sections).join(','))
  }
  const text = params.toString()
  return text ? `?${text}` : ''
}

export function exportHref(query: ExportQuery = {}): string {
  return `/export${buildExportQuery(query)}`
}

const pad = (value: number) => String(value).padStart(2, '0')
const day = (year: number, month: number, date: number) => {
  const value = new Date(Date.UTC(year, month, date))
  return `${value.getUTCFullYear()}-${pad(value.getUTCMonth() + 1)}-${pad(value.getUTCDate())}`
}

/** The local date of the device `ГГГГ-ММ-ДД`. */
export function deviceToday(now = new Date()): string {
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

/** Purchase dates of a period, both inclusive; `{}` — all the time. Calendar months and the calendar year. */
export function periodRange(query: Pick<ExportQuery, 'period' | 'from' | 'to'>, today: string): { from?: string; to?: string } {
  const [year, month] = today.split('-').map(Number)
  const m = month - 1
  switch (query.period ?? 'this-month') {
    case 'this-month': return { from: day(year, m, 1), to: day(year, m + 1, 0) }
    case 'last-month': return { from: day(year, m - 1, 1), to: day(year, m, 0) }
    case '3-months': return { from: day(year, m - 2, 1), to: day(year, m + 1, 0) }
    case 'year': return { from: day(year, 0, 1), to: day(year, 11, 31) }
    case 'all': return {}
    case 'custom': return { ...(query.from && { from: query.from }), ...(query.to && { to: query.to }) }
  }
}

/** The parameters of `/api/export/`; `include` — `receipts` and the chosen sections, or the given list (the preview). */
export function apiParams(query: ExportQuery, today: string, include?: readonly string[]): Record<string, string> {
  const range = periodRange(query, today)
  const params: Record<string, string> = {}
  if (range.from) params.from = range.from
  if (range.to) params.to = range.to
  if (query.category?.length) params.category = query.category.join(',')
  if (query.source?.length) params.source = query.source.join(',')
  if (query.owner?.length) params.owner = query.owner.join(',')
  if (query.store?.length) params.store = query.store.join(',')
  if (query.currency) params.currency = query.currency
  params.include = (include ?? ['receipts', ...oneOf(sections, query.sections ?? [...defaultSections])]).join(',')
  return params
}

/** How many filters differ from their defaults: the count of «Фильтры (N)». */
export function activeFilters(query: ExportQuery): number {
  return [query.period, query.category?.length, query.source?.length, query.owner?.length, query.store?.length, query.currency]
    .filter(Boolean).length
}

/** Adds or removes `value`. */
export function toggled<T>(values: readonly T[] | undefined, value: T): T[] {
  const current = values ?? []
  return current.includes(value) ? current.filter((item) => item !== value) : [...current, value]
}
