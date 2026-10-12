import type { BudgetLimit } from '../../api/budget-types'
import type { Category, LocalApiFailure } from '../../api/types'

/** Limits belong to top-level categories only: children are rolled up into them. */
export function topLevelCategories(categories: Category[]): Category[] {
  return categories.filter((category) => category.parent_id === null && category.depth === 0)
}

export const limitMessages = {
  empty: 'Введите сумму лимита.',
  format: 'Сумма — число, например 120000 или 1500,50.',
  places: 'Не больше двух знаков после запятой.',
  zero: 'Лимит должен быть больше нуля.',
  large: 'Слишком большая сумма.',
  currency: 'Валюта — три латинские буквы, например KZT.',
} as const

/** What a person typed into a limit: «120 000», «1500,5» → `120000.00`, `1500.50`. */
export function parseLimitAmount(input: string): { amount: string } | { error: string } {
  const value = input.replace(/[\s\u00a0\u202f]/g, '').replace(',', '.')
  if (!value) return { error: limitMessages.empty }
  if (/^\d+\.\d{3,}$/.test(value)) return { error: limitMessages.places }
  const match = /^(\d+)(?:\.(\d{0,2}))?$/.exec(value)
  if (!match) return { error: limitMessages.format }
  const whole = match[1].replace(/^0+(?=\d)/, '')
  if (whole.length > 12) return { error: limitMessages.large }
  const fraction = (match[2] ?? '').padEnd(2, '0')
  if (/^0+$/.test(whole + fraction)) return { error: limitMessages.zero }
  return { amount: `${whole}.${fraction}` }
}

/** A currency code typed by a person: three Latin letters, any case. */
export function parseCurrency(input: string): { currency: string } | { error: string } {
  const value = input.trim().toUpperCase()
  return /^[A-Z]{3}$/.test(value) ? { currency: value } : { error: limitMessages.currency }
}

/** The value of a limit as a person reads and types it: `120000.00` → «120000», `1500.50` → «1500,50». */
export function amountInput(amount: string): string {
  return amount.replace(/\.00$/, '').replace('.', ',')
}

/** The currencies of the screen: the one of the form defaults first, then those that already have limits, then added ones. */
export function limitCurrencies(defaultCurrency: string, limits: BudgetLimit[], added: string[] = []): string[] {
  const others = [...new Set(limits.map((limit) => limit.currency))].filter((code) => code !== defaultCurrency).sort()
  return [...new Set([defaultCurrency, ...others, ...added])]
}

export function limitFor(limits: BudgetLimit[], categoryId: number, currency: string): BudgetLimit | undefined {
  return limits.find((limit) => limit.category_id === categoryId && limit.currency === currency)
}

export type RowAction =
  | { kind: 'none' }
  | { kind: 'invalid'; error: string }
  | { kind: 'create'; amount: string }
  | { kind: 'update'; id: number; amount: string }

/** What «Сохранить» does for a row: nothing when unchanged, a new limit or a change of the existing one. */
export function rowAction(draft: string | undefined, limit: BudgetLimit | undefined): RowAction {
  if (draft === undefined) return { kind: 'none' }
  const parsed = parseLimitAmount(draft)
  if ('error' in parsed) return { kind: 'invalid', error: parsed.error }
  if (!limit) return { kind: 'create', amount: parsed.amount }
  return parsed.amount === limit.amount ? { kind: 'none' } : { kind: 'update', id: limit.id, amount: parsed.amount }
}

/** The list after the server answered with a saved limit. */
export function withLimit(limits: BudgetLimit[], saved: BudgetLimit): BudgetLimit[] {
  const others = limits.filter((limit) => limit.id !== saved.id
    && !(limit.category_id === saved.category_id && limit.currency === saved.currency))
  return [...others, saved]
}

export function withoutLimit(limits: BudgetLimit[], id: number): BudgetLimit[] {
  return limits.filter((limit) => limit.id !== id)
}

/** Local texts of a refused save or delete; field names only, never server messages. */
export function limitFailureMessage(failure: Pick<LocalApiFailure, 'reason' | 'fields'>): string {
  switch (failure.reason) {
    case 'invalid_parameter': case 'invalid_request': {
      const fields = failure.fields ?? []
      if (fields.includes('amount')) return 'Сервер не принял сумму: нужна сумма больше нуля.'
      if (fields.includes('category_id') || fields.includes('category')) return 'Для этой категории лимит не задаётся: выберите категорию верхнего уровня.'
      if (fields.includes('currency')) return 'Сервер не принял валюту.'
      if (fields.includes('non_field_errors') || fields.includes('__all__')) return 'Лимит для этой категории и валюты уже есть. Обновите страницу.'
      return 'Сервер не принял лимит. Проверьте сумму и повторите.'
    }
    case 'not_found': return 'Этого лимита уже нет. Обновите страницу.'
    case 'csrf_failed': return 'Сессия устарела. Повторите попытку.'
    case 'permission_denied': return 'Нет права менять лимиты.'
    case 'timeout': return 'Сервер не ответил вовремя. Повторите попытку.'
    case 'network': return 'Не удалось связаться с сервером. Проверьте соединение.'
    case 'database_unavailable': return 'Данные временно недоступны. Повторите попытку позже.'
    default: return 'Не удалось сохранить лимит. Повторите попытку.'
  }
}
