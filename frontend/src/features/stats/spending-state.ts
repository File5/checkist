import { statsFailureKind } from '../../api/stats'
import type { Spending, SpendingItem, SpendingParams } from '../../api/stats'
import type { LocalApiResult } from '../../api/types'
import { buildSpendingQuery, maxStatsStores, parseSpendingQuery, spendingHref } from '../../navigation/routes'
import type { SpendingGroupBy, SpendingQuery } from '../../navigation/routes'
import { getSession, permissionDeniedText } from '../../session'

export type SpendingFailure = Extract<LocalApiResult<never>, { kind: 'error' }>
export type SpendingRequestState = { kind: 'loading' } | { kind: 'ok'; data: Spending } | SpendingFailure

// ---- Period presets -------------------------------------------------------------------------------------------

export const presets = ['this-month', 'last-month', 'this-year', 'last-year', 'all'] as const
export type Preset = typeof presets[number]
export const presetLabels: Record<Preset, string> = {
  'this-month': 'Этот месяц', 'last-month': 'Прошлый месяц', 'this-year': 'Этот год', 'last-year': 'Прошлый год', all: 'Всё время',
}
export type Period = { date_from?: string; date_to?: string }

const iso = (year: number, month: number, day: number) =>
  `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
function monthDays(year: number, month: number): number {
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  return [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1]
}

/** The calendar date of the browser: periods of the API are calendar dates too, so no time zone is converted. */
export function localToday(now: Date = new Date()): string {
  return iso(now.getFullYear(), now.getMonth() + 1, now.getDate())
}

/** Whole calendar months and years, both bounds inclusive; «всё время» has no bounds. */
export function presetPeriod(preset: Preset, today: string): Period {
  const year = Number(today.slice(0, 4))
  const month = Number(today.slice(5, 7))
  switch (preset) {
    case 'this-month': return { date_from: iso(year, month, 1), date_to: iso(year, month, monthDays(year, month)) }
    case 'last-month': {
      const [y, m] = month === 1 ? [year - 1, 12] : [year, month - 1]
      return { date_from: iso(y, m, 1), date_to: iso(y, m, monthDays(y, m)) }
    }
    case 'this-year': return { date_from: iso(year, 1, 1), date_to: iso(year, 12, 31) }
    case 'last-year': return { date_from: iso(year - 1, 1, 1), date_to: iso(year - 1, 12, 31) }
    case 'all': return {}
  }
}

export function activePreset(query: Period, today: string): Preset | undefined {
  return presets.find((preset) => {
    const period = presetPeriod(preset, today)
    return period.date_from === query.date_from && period.date_to === query.date_to
  })
}

/** A preset changes only the period: the other filters, the place in the drill-down and an open «Прочее» stay. */
export function presetHref(query: SpendingQuery, preset: Preset, today: string): string {
  return spendingHref({ ...query, date_from: undefined, date_to: undefined, ...presetPeriod(preset, today) })
}

// ---- Filters --------------------------------------------------------------------------------------------------

export type TextField = 'date_from' | 'date_to' | 'country' | 'currency'
export type FilterField = TextField | 'store'
export const filterFields: readonly FilterField[] = ['date_from', 'date_to', 'country', 'currency', 'store']
export type FilterDraft = Record<TextField, string> & { store: number[] }
export type FilterErrors = Partial<Record<FilterField, string>>

export const filterMessages: Record<FilterField, string> = {
  date_from: 'Укажите корректную дату начала, не позже даты окончания.',
  date_to: 'Укажите корректную дату окончания, не раньше даты начала.',
  country: 'Выберите страну из списка или уберите фильтр страны.',
  currency: 'Выберите валюту из списка или уберите фильтр валюты.',
  store: `Выберите существующие магазины, не больше ${maxStatsStores}, или уберите фильтр магазинов.`,
}

export function filterDraft(query: SpendingQuery): FilterDraft {
  return { date_from: query.date_from ?? '', date_to: query.date_to ?? '', country: query.country ?? '',
    currency: query.currency ?? '', store: [...(query.store ?? [])] }
}
const emptyDraft: FilterDraft = { date_from: '', date_to: '', country: '', currency: '', store: [] }

export function sameDraft(a: FilterDraft, b: FilterDraft): boolean {
  return filterFields.every((field) => String(a[field]) === String(b[field]))
}

/** Where the screen is in the drill-down and whether «Прочее» is open; applying or resetting filters never moves it. */
function drill(query: SpendingQuery): Pick<SpendingQuery, 'group_by' | 'category' | 'generic' | 'other'> {
  return { ...(query.group_by && { group_by: query.group_by }), ...(query.category && { category: query.category }),
    ...(query.generic && { generic: query.generic }), ...(query.other && { other: query.other }) }
}
/** Another level is another list: it opens with «Прочее» closed. */
function scope(query: SpendingQuery): SpendingQuery {
  return { ...query, group_by: undefined, category: undefined, generic: undefined, other: undefined }
}

/** The draft becomes an address through the route's own parser, so the form and a pasted link obey the same rules. */
export function applyFilters(query: SpendingQuery, draft: FilterDraft): { query: SpendingQuery; errors: FilterErrors } {
  const params = new URLSearchParams()
  for (const field of ['date_from', 'date_to', 'country', 'currency'] as const) if (draft[field].trim()) params.set(field, draft[field])
  if (draft.store.length) params.set('store', draft.store.join(','))
  const parsed = parseSpendingQuery(params)
  const errors: FilterErrors = {}
  for (const field of parsed.invalidFields) {
    if (Object.hasOwn(filterMessages, field)) errors[field as FilterField] = filterMessages[field as FilterField]
  }
  // The parser reports a reversed period on its first bound only; both inputs are wrong for the person.
  if (draft.date_from && draft.date_to && draft.date_from > draft.date_to) {
    errors.date_from = filterMessages.date_from
    errors.date_to = filterMessages.date_to
  }
  return { query: { ...parsed.query, ...drill(query) }, errors }
}

export type FormState = { source: string; draft: FilterDraft; errors: FilterErrors }
export type FormAction =
  | { type: 'sync'; query: SpendingQuery }
  | { type: 'set'; field: TextField; value: string }
  | { type: 'toggle-store'; id: number }
  | { type: 'clear-stores' }
  | { type: 'reset' }
  | { type: 'invalid'; errors: FilterErrors }

export function initForm(query: SpendingQuery): FormState {
  return { source: requestKey(query), draft: filterDraft(query), errors: {} }
}

/** Edits live in the draft until «Применить»; a new address (Back, a preset, a drill-down) replaces the draft. */
export function formReducer(state: FormState, action: FormAction): FormState {
  const without = (field: FilterField) => {
    const errors = { ...state.errors }
    delete errors[field]
    return errors
  }
  switch (action.type) {
    case 'sync': return requestKey(action.query) === state.source ? state : initForm(action.query)
    case 'set': {
      // A date error always names the pair of bounds, so editing either bound clears both.
      const errors = without(action.field)
      if (action.field === 'date_from') delete errors.date_to
      if (action.field === 'date_to') delete errors.date_from
      return { ...state, draft: { ...state.draft, [action.field]: action.value }, errors }
    }
    case 'toggle-store': {
      const selected = state.draft.store.includes(action.id)
      if (!selected && state.draft.store.length >= maxStatsStores) return state
      const store = selected ? state.draft.store.filter((id) => id !== action.id) : [...state.draft.store, action.id].sort((a, b) => a - b)
      return { ...state, draft: { ...state.draft, store }, errors: without('store') }
    }
    case 'clear-stores': return { ...state, draft: { ...state.draft, store: [] }, errors: without('store') }
    case 'reset': return { ...state, draft: emptyDraft, errors: {} }
    case 'invalid': return { ...state, errors: action.errors }
  }
}

/** Server refusals of the applied filters; a field the person has already edited is not marked again. */
export function serverFieldErrors(failure: SpendingFailure | undefined, draft: FilterDraft, applied: FilterDraft): FilterErrors {
  const errors: FilterErrors = {}
  if (failure?.reason !== 'invalid_parameter') return errors
  for (const field of failure.fields ?? []) {
    if (Object.hasOwn(filterMessages, field) && String(draft[field as FilterField]) === String(applied[field as FilterField])) {
      errors[field as FilterField] = filterMessages[field as FilterField]
    }
  }
  return errors
}

/** True when the refusal names something the form cannot fix: the drill-down part of the address or nothing at all. */
export function needsAddressReset(failure: SpendingFailure): boolean {
  if (failure.reason !== 'invalid_parameter') return false
  const fields = failure.fields ?? []
  return fields.length === 0 || fields.some((field) => !Object.hasOwn(filterMessages, field))
}

export function hasScopeFilters(query: SpendingQuery): boolean {
  return Boolean(query.date_from || query.date_to || query.country || query.currency || query.store?.length)
}
export function hasFilters(query: SpendingQuery): boolean {
  return hasScopeFilters(query) || Boolean(query.category || query.generic)
}
/** Drops the filters and the drill-down, keeps the chosen breakdown. */
export function resetHref(query: SpendingQuery): string {
  return spendingHref(query.group_by ? { group_by: query.group_by } : {})
}
/** Drops only the filters of the form. */
export function resetFiltersHref(query: SpendingQuery): string {
  return spendingHref(drill(query))
}

/** Regular items asked for the composition of «Прочее»: the most the server accepts. */
export const spendingTailLimit = 500

/** `other` is a state of the screen, not a parameter of the API. */
export function spendingParams(query: SpendingQuery): SpendingParams {
  const params: SpendingQuery = { ...query }
  delete params.other
  return params
}
/** The same request with the long list: its items after the first ones are the composition of «Прочее». */
export function spendingTailParams(query: SpendingQuery): SpendingParams {
  return { ...spendingParams(query), limit: spendingTailLimit }
}
/**
 * Whether the long answer is asked. Only for a shown answer with «Прочее» in at least one block and an address that
 * says `other=open`; once it came for this very answer (`loadedFor`), hiding and showing does not ask again.
 */
export function needsTail(query: SpendingQuery, data: Spending | undefined, loadedFor?: Spending): boolean {
  return data !== undefined && data.currencies.some((block) => block.other !== null) && (query.other === 'open' || loadedFor === data)
}
/** The address without `other`: showing or hiding the composition is the same request and the same form. */
export function requestKey(query: SpendingQuery): string {
  return buildSpendingQuery({ ...query, other: undefined })
}
/** Shows or hides the composition of «Прочее»; nothing else in the address changes. */
export function otherHref(query: SpendingQuery, open: boolean): string {
  return spendingHref({ ...query, other: open ? 'open' : undefined })
}

// ---- Breakdown and drill-down -----------------------------------------------------------------------------------

export const groupingLabels: Record<SpendingGroupBy, string> = {
  category: 'Категории', generic: 'Обобщённые продукты', product: 'Товары', store: 'Магазины',
}
export const groupingCaptions: Record<SpendingGroupBy, string> = {
  category: 'по категориям', generic: 'по обобщённым продуктам', product: 'по товарам', store: 'по магазинам',
}
export const grouping = (query: SpendingQuery): SpendingGroupBy => query.group_by ?? 'category'

/**
 * One generic product split by categories or by generic products is a single sector, so that filter is dropped there.
 * Another breakdown is another list: «Прочее» is closed in it.
 */
export function groupingHref(query: SpendingQuery, group_by: SpendingGroupBy): string {
  const { generic, ...rest } = query
  return spendingHref({ ...rest, other: undefined, group_by, ...(generic && group_by !== 'category' && group_by !== 'generic' && { generic }) })
}

/** Category → its subcategories; products lying directly in it → generic products → products → the product card. */
export function itemHref(query: SpendingQuery, item: Pick<SpendingItem, 'kind' | 'id' | 'direct'>): string | undefined {
  if (item.id === null) return undefined
  switch (item.kind) {
    case 'category': return spendingHref({ ...scope(query), category: item.id, ...(item.direct && { group_by: 'generic' as const }) })
    case 'generic': return spendingHref({ ...scope(query), ...(query.category && { category: query.category }), generic: item.id, group_by: 'product' })
    case 'product': return `/catalog/products/${item.id}`
    default: return undefined
  }
}

export type Crumb = { label: string; href?: string }

/**
 * The way back: the root, the categories of `parent.path` and the levels below them. Empty at the root.
 * `parent` belongs to the answer shown (it may be absent while it loads or after a refusal).
 */
export function breadcrumbs(query: SpendingQuery, parent: Spending['parent'] | undefined, genericName?: string): Crumb[] {
  if (!query.category && !query.generic) return []
  const base = scope(query)
  const by = grouping(query)
  const crumbs: Crumb[] = [{ label: 'Все траты', href: spendingHref(base) }]
  if (query.category) {
    const path = parent?.id === query.category ? parent.path : [{ id: query.category, name: `Категория №${query.category}` }]
    for (const category of path) crumbs.push({ label: category.name, href: spendingHref({ ...base, category: category.id }) })
  }
  if (query.generic) {
    if (query.category) crumbs.push({ label: groupingLabels.generic, href: spendingHref({ ...base, category: query.category, group_by: 'generic' }) })
    crumbs.push({ label: genericName?.trim() || `Обобщённый продукт №${query.generic}`,
      href: spendingHref({ ...base, ...(query.category && { category: query.category }), generic: query.generic, group_by: 'product' }) })
    if (by !== 'product') crumbs.push({ label: groupingLabels[by] })
  } else if (by !== 'category') crumbs.push({ label: groupingLabels[by] })
  // The last crumb is the place itself, not a link to it.
  delete crumbs[crumbs.length - 1].href
  return crumbs
}

/** One level up: the previous crumb. */
export function upHref(crumbs: readonly Crumb[]): string | undefined {
  return crumbs.at(-2)?.href
}

// ---- What the result block shows ---------------------------------------------------------------------------------

export type Shown = { query: SpendingQuery; data: Spending }

/**
 * While new filters load, the previous answer stays on screen (marked busy) so the page does not jump;
 * its links are built from the query it was loaded for.
 */
export function shownResult(state: SpendingRequestState, query: SpendingQuery, last: Shown | undefined): (Shown & { stale: boolean }) | undefined {
  if (state.kind === 'ok') return { query, data: state.data, stale: false }
  if (state.kind === 'loading' && last) return { ...last, stale: true }
  return undefined
}

export type FailureView = { message: string; retry: boolean }

/** With accounts a refused access is a missing right, not a switched off local mode. */
const accountsSession = () => { const session = getSession(); return session.kind === 'user' && session.mode === 'accounts' }
/** Local texts only: a server message never reaches the screen. Nothing is retried automatically. */
export function failureView(failure: SpendingFailure): FailureView {
  switch (statsFailureKind(failure)) {
    case 'permission_denied': return { retry: false,
      message: accountsSession() ? permissionDeniedText(getSession()) : 'Локальный режим выключен: статистика трат недоступна. Она открывается только на сервере, запущенном локально с DEBUG и ALLOW_LOCAL_RECOGNITION_API=1. После включения режима обновите страницу.' }
    case 'invalid_parameter': return { retry: false,
      message: 'Сервер не принял параметры. Исправьте отмеченные фильтры или сбросьте их.' }
    case 'range_too_large': return { retry: false, message: 'Слишком большой период. Уменьшите его в фильтрах.' }
    case 'unavailable': return { retry: true, message: failure.reason === 'timeout'
      ? 'Сервер не ответил за 15 секунд. Повторите попытку.'
      : failure.reason === 'network' ? 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.'
        : 'Данные статистики временно недоступны. Повторите попытку позже.' }
    default: return { retry: true, message: 'Сервер вернул неожиданный ответ. Повторите попытку.' }
  }
}

export function periodText(period: { date_from: string | null; date_to: string | null }): string {
  const date = (value: string) => `${value.slice(8, 10)}.${value.slice(5, 7)}.${value.slice(0, 4)}`
  if (period.date_from && period.date_to) return `Период: ${date(period.date_from)} — ${date(period.date_to)}, обе даты включительно.`
  if (period.date_from) return `Период: с ${date(period.date_from)} включительно.`
  if (period.date_to) return `Период: по ${date(period.date_to)} включительно.`
  return 'Период: всё время.'
}
