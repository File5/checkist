import { parseHistoryQuery } from '../../navigation/routes'
import type { HistoryQuery } from '../../navigation/routes'
import type { ApiFailure, ApiResult, PriceFilters, PriceParams, PriceSummaryParams, ProductDetail, Store, StoreBrief, StoreParams } from '../../api/types'

export type FilterField = 'store' | 'country' | 'currency' | 'date_from' | 'date_to'
export type FilterDraft = Record<FilterField, string>
export type FieldErrors = Partial<Record<FilterField, string>>
export type RequestState<T> = { kind: 'loading' } | Exclude<ApiResult<T>, { kind: 'aborted' }>

export const fieldMessages: Record<FilterField, string> = {
  store: 'Выберите доступный магазин или уберите фильтр магазина.',
  country: 'Выберите доступную страну или уберите фильтр страны.',
  currency: 'Выберите доступную валюту или уберите фильтр валюты.',
  date_from: 'Укажите дату в формате ГГГГ-ММ-ДД, не позже даты окончания.',
  date_to: 'Укажите дату в формате ГГГГ-ММ-ДД, не раньше даты начала.',
}

export function filterDraft(query: HistoryQuery): FilterDraft {
  return { store: query.store === undefined ? '' : String(query.store), country: query.country ?? '',
    currency: query.currency ?? '', date_from: query.date_from ?? '', date_to: query.date_to ?? '' }
}

export function validateFilters(draft: FilterDraft): { query: HistoryQuery; errors: FieldErrors } {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(draft)) if (value) params.set(key, value)
  const parsed = parseHistoryQuery(params)
  const errors: FieldErrors = {}
  for (const field of parsed.invalidFields) {
    if (Object.hasOwn(fieldMessages, field)) errors[field as FilterField] = fieldMessages[field as FilterField]
  }
  if (draft.date_from && draft.date_to && draft.date_from > draft.date_to) {
    errors.date_from = fieldMessages.date_from
    errors.date_to = fieldMessages.date_to
  }
  return { query: { ...parsed.query, page: 1 }, errors }
}

export function priceFilters(query: HistoryQuery): PriceFilters {
  return { ...(query.store !== undefined && { store: query.store }), ...(query.country && { country: query.country }),
    ...(query.currency && { currency: query.currency }), ...(query.date_from && { date_from: query.date_from }),
    ...(query.date_to && { date_to: query.date_to }) }
}

export function historyParams(query: HistoryQuery): PriceParams {
  return { ...priceFilters(query), ordering: '-observed_at', page: query.page, page_size: 50 }
}

export function summaryParams(query: HistoryQuery): PriceSummaryParams {
  return { ...priceFilters(query), group_by: 'store', price: 'paid', interval: 'none' }
}

export function storeParams(country: string, q: string, page: number): StoreParams {
  return { ...(country && { country }), ...(q && { q }), page, page_size: 50 }
}

export function hasFilters(query: HistoryQuery): boolean {
  return Object.keys(priceFilters(query)).length > 0
}

export function filterOptions(product: ProductDetail) {
  return { countries: [...new Set(product.prices.map((price) => price.country))].sort(),
    currencies: [...new Set(product.prices.map((price) => price.currency))].sort() }
}

export function serverFieldErrors(failures: ApiFailure[], draft: FilterDraft, applied: FilterDraft): FieldErrors {
  const errors: FieldErrors = {}
  for (const failure of failures) {
    if (failure.status !== 400) continue
    for (const field of failure.fields ?? []) {
      if (Object.hasOwn(fieldMessages, field) && draft[field as FilterField] === applied[field as FilterField]) {
        errors[field as FilterField] = fieldMessages[field as FilterField]
      }
    }
  }
  return errors
}

export function errorMessage(failure: ApiFailure): string {
  switch (failure.reason) {
    case 'network': return 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.'
    case 'timeout': return 'Сервер не ответил за 15 секунд. Повторите попытку.'
    case 'invalid_parameter': case 'invalid_request': return 'Исправьте отмеченные фильтры или сбросьте их и примените снова.'
    case 'range_too_large': return 'Уменьшите период в фильтрах и примените его снова.'
    case 'page_out_of_range': return 'Такой страницы истории нет. Перейдите на первую страницу.'
    case 'not_found': return 'Данные не найдены. Вернитесь в каталог.'
    case 'invalid_response': return 'Ответ сервера имеет неожиданный формат. Повторите попытку позже.'
    case 'server': return 'Не удалось загрузить данные из-за ошибки сервера. Повторите попытку позже.'
  }
}

export function mergeStores(initial: Store[], additional: Store[]): Store[] {
  const stores = new Map(initial.map((store) => [store.id, store]))
  for (const store of additional) stores.set(store.id, store)
  return [...stores.values()]
}

export function storeLabel(store: StoreBrief & Partial<Store>): string {
  return [store.name.trim() || 'Не указано', store.address?.trim(), store.city.trim(), store.country].filter(Boolean).join(' · ')
}

/** One independent request block. Abort and generation both protect against late completions. */
export function createRequest<T>(load: (signal: AbortSignal) => Promise<ApiResult<T>>) {
  let state: RequestState<T> = { kind: 'loading' }
  const initial = state
  let generation = 0
  let controller: AbortController | undefined
  const listeners = new Set<() => void>()
  const publish = (next: RequestState<T>) => { state = next; listeners.forEach((listener) => listener()) }
  const run = () => {
    controller?.abort()
    const current = new AbortController()
    controller = current
    const requestGeneration = ++generation
    publish({ kind: 'loading' })
    const accept = (result: ApiResult<T>) => {
      if (!current.signal.aborted && requestGeneration === generation && result.kind !== 'aborted') publish(result)
    }
    void Promise.resolve().then(() => current.signal.aborted ? { kind: 'aborted' as const } : load(current.signal))
      .then(accept, () => accept({ kind: 'error', reason: 'network' }))
  }
  return { run, getSnapshot: () => state, getServerSnapshot: () => initial,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    dispose: () => { ++generation; controller?.abort() } }
}
