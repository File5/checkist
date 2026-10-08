import type { LocalApiResult } from '../../api/types'
import type { ReceiptParams } from '../../api/receipts'
import { buildReceiptsQuery, parseReceiptsQuery } from '../../navigation'
import type { ReceiptsQuery } from '../../navigation'
import { formatAmount, formatPrice } from '../../lib/format'
import { getSession, permissionDeniedText } from '../../session'

export const unknown = 'Не распознано'
export const recognizedText = (value: string | null | undefined) => value?.trim() || unknown
export const recognizedValue = (value: string) => value === '—' ? unknown : value
export const money = (value: string | null, currency?: string) => recognizedValue(formatAmount(value, currency ?? '').trim())
export const price = (value: string | null, currency?: string) => recognizedValue(formatPrice(value, currency ?? '').trim())

export type FilterField = 'q' | 'date_from' | 'date_to' | 'operation' | 'ordering'
export type FilterDraft = Record<FilterField, string>
export type FilterErrors = Partial<Record<FilterField, string>>
export type Failure = Extract<LocalApiResult<never>, { kind: 'error' }>

export const filterMessages: Record<FilterField, string> = {
  q: 'Введите от 2 до 100 символов без управляющих символов.',
  date_from: 'Укажите корректную дату начала, не позже даты окончания.',
  date_to: 'Укажите корректную дату окончания.',
  operation: 'Выберите продажу, возврат или все операции.',
  ordering: 'Выберите порядок по дате покупки.',
}

export function filterDraft(query: ReceiptsQuery): FilterDraft {
  return { q: query.q ?? '', date_from: query.date_from ?? '', date_to: query.date_to ?? '',
    operation: query.operation ?? '', ordering: query.ordering ?? '-purchased_at' }
}

export function applyFilters(query: ReceiptsQuery, draft: FilterDraft): { query: ReceiptsQuery; errors: FilterErrors } {
  // Preserve filters supplied by product/store links; editing visible fields resets only the page.
  const params = new URLSearchParams(buildReceiptsQuery(query))
  for (const field of Object.keys(draft) as FilterField[]) params.set(field, draft[field])
  params.set('page', '1')
  const parsed = parseReceiptsQuery(params)
  const errors: FilterErrors = {}
  // URLSearchParams replaces lone surrogates; validate the draft before that coercion.
  if (/[\ud800-\udfff]/u.test(draft.q)) errors.q = filterMessages.q
  for (const field of parsed.invalidFields) {
    if (field in filterMessages) errors[field as FilterField] = filterMessages[field as FilterField]
  }
  return { query: parsed.query, errors }
}

export function receiptParams(query: ReceiptsQuery): ReceiptParams {
  return { ...query, ordering: query.ordering ?? '-purchased_at' }
}

export function hasFilters(query: ReceiptsQuery): boolean {
  return Boolean(query.q || query.date_from || query.date_to || query.operation || query.store || query.product || query.country || query.currency)
}

/** With accounts a refused access is a missing right, not a switched off local mode. */
const accountsSession = () => { const session = getSession(); return session.kind === 'user' && session.mode === 'accounts' }
export function errorMessage(failure: Failure): string {
  switch (failure.reason) {
    case 'permission_denied': return accountsSession() ? permissionDeniedText(getSession())
      : 'Просмотр чеков доступен только в локальном режиме. Проверьте настройки доступа сервера.'
    case 'not_found': return 'Чек не найден. Возможно, он был удалён.'
    case 'page_out_of_range': return 'Этой страницы больше нет. Перейдите на первую страницу.'
    case 'invalid_parameter': case 'invalid_request': return 'Не удалось применить параметры. Исправьте или сбросьте фильтры.'
    case 'timeout': return 'Сервер не ответил вовремя. Повторите попытку.'
    case 'network': return 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.'
    case 'database_unavailable': return 'Данные чеков временно недоступны. Повторите попытку позже.'
    case 'storage_unavailable': return 'Изображения временно недоступны. Повторите попытку позже.'
    case 'invalid_response': return 'Сервер вернул неожиданный ответ. Повторите попытку.'
    default: return 'Не удалось загрузить данные. Повторите попытку.'
  }
}
