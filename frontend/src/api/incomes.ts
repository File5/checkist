import { invalidIds } from './http.ts'
import { getLocalJson, mutate } from './local.ts'
import { isMonthCode } from './budget-schema.ts'
import { omitEmpty } from './stats.ts'
import { amount, array, bool, choice, currency, isId, isISODate, nonNegativeInteger, nullable, object, text } from './schema.ts'
import type { Guard } from './schema.ts'
import type { TrendsParams } from './trends-types.ts'
import type { CurrencyCode, Decimal, ISODate, LocalApiResult, RequestOptions } from './types.ts'

/** «Доходы» (`/api/incomes/`): money the family received, typed in by a person (statements never add incomes).
 * A record is seen by its author and the head of the family; the others see only the family's total of a month. */
export type IncomeCategory = { id: number; name: string; built_in: boolean }
export type Income = {
  id: number; received_on: ISODate; amount: Decimal; currency: CurrencyCode; category: { id: number; name: string }
  note: string; owner: string; owner_name: string
  /** In the base currency of the family at the rate of its day; `null` — no rate. */
  base_amount: Decimal | null
}
export type IncomeMonth = {
  month: string; base_currency: CurrencyCode
  /** Every income of the family in the month, in the base currency; `null` — none yet. */
  family_total: Decimal | null
  results: Income[]
}
/** The body of a new or a changed income; without `currency` — the default of spends, without `received_on` — today. */
export type IncomeInput = { amount: Decimal; currency?: CurrencyCode; category: number; received_on?: ISODate; note?: string }
/** One month in the base currency: `income` and `saved` are `null` while no income of the month is entered. */
export type IncomeFigures = { income: Decimal | null; spent: Decimal; saved: Decimal | null; saved_percent: Decimal | null }
export type IncomeSummary = IncomeFigures & { month: string; base_currency: CurrencyCode; excluded: { currency: CurrencyCode; total: Decimal }[] }
export type IncomeTrends = {
  months: number; month_from: string; month_to: string; base_currency: CurrencyCode
  excluded: { currency: CurrencyCode; total: Decimal }[]
  items: (IncomeFigures & { month: string })[]
}

/** «Статистика → Доходы» of a window: the family's figures, and income by category of the records the person may see —
 * `family`: every record of the family (the head, a person without a family); `own`: one's own records (a member). */
export type IncomeStats = IncomeFigures & {
  months: number; month_from: string; month_to: string; base_currency: CurrencyCode
  categories_scope: 'family' | 'own'
  categories: { id: number; name: string; total: Decimal }[]
  excluded: { currency: CurrencyCode; total: Decimal }[]
}

const named = object<{ id: number; name: string }>({ id: isId, name: text })
export const isIncome = object<Income>({
  id: isId, received_on: isISODate, amount, currency, category: named, note: text, owner: text, owner_name: text,
  base_amount: nullable(amount),
})
const isCategory = object<IncomeCategory>({ id: isId, name: text, built_in: bool })
const isMonth = object<IncomeMonth>({ month: isMonthCode, base_currency: currency, family_total: nullable(amount), results: array(isIncome) })
// A percentage comes with two decimals, like an amount.
const figures = { income: nullable(amount), spent: amount, saved: nullable(amount), saved_percent: nullable(amount) }
const excluded = array(object<{ currency: CurrencyCode; total: Decimal }>({ currency, total: amount }))
const isSummary = object<IncomeSummary>({ month: isMonthCode, base_currency: currency, excluded, ...figures })
const isTrends = object<IncomeTrends>({
  months: nonNegativeInteger, month_from: isMonthCode, month_to: isMonthCode, base_currency: currency, excluded,
  items: array(object<IncomeTrends['items'][number]>({ month: isMonthCode, ...figures })),
})
const isStats = object<IncomeStats>({
  months: nonNegativeInteger, month_from: isMonthCode, month_to: isMonthCode, base_currency: currency, excluded, ...figures,
  categories_scope: choice('family', 'own'),
  categories: array(object<IncomeStats['categories'][number]>({ id: isId, name: text, total: amount })),
})
const isEmpty = (value: unknown): value is null => value === null
const isCategories = object<{ results: IncomeCategory[] }>({ results: array(isCategory) })

const send = <T>(path: string, body: unknown, guard: Guard<T>, options: RequestOptions, method: 'POST' | 'PATCH' | 'DELETE' = 'POST') =>
  mutate(path, body === undefined ? '' : JSON.stringify(body), guard, options, false, undefined, { method })

/** The records of a month the person may see and the family's total; without `month` — the server's current one. */
export function getIncomes(month?: string, options: RequestOptions = {}): Promise<LocalApiResult<IncomeMonth>> {
  return getLocalJson('incomes/', omitEmpty({ month }), isMonth, options)
}
export async function getIncome(id: number, options: RequestOptions = {}): Promise<LocalApiResult<Income>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`incomes/${id}/`, {}, isIncome, options)
}
export function createIncome(input: IncomeInput, options: RequestOptions = {}): Promise<LocalApiResult<Income>> {
  return send('incomes/', input, isIncome, options)
}
export async function updateIncome(id: number, input: Partial<IncomeInput>, options: RequestOptions = {}): Promise<LocalApiResult<Income>> {
  return invalidIds({ id }, options.signal) ?? send(`incomes/${id}/`, input, isIncome, options, 'PATCH')
}
export async function deleteIncome(id: number, options: RequestOptions = {}): Promise<LocalApiResult<null>> {
  return invalidIds({ id }, options.signal) ?? send(`incomes/${id}/`, undefined, isEmpty, options, 'DELETE')
}
/** The built-in list first (Зарплата · Подработка · …), then the family's own. */
export async function getIncomeCategories(options: RequestOptions = {}): Promise<LocalApiResult<IncomeCategory[]>> {
  const result = await getLocalJson('incomes/categories/', {}, isCategories, options)
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.results } : result
}
/** A category of the family; the same name in any case is the one already there. */
export function createIncomeCategory(name: string, options: RequestOptions = {}): Promise<LocalApiResult<IncomeCategory>> {
  return send('incomes/categories/', { name }, isCategory, options)
}
/** «Доход · Потрачено · Отложено» of a month of «Главная». */
export function getIncomeSummary(month?: string, options: RequestOptions = {}): Promise<LocalApiResult<IncomeSummary>> {
  return getLocalJson('incomes/summary/', omitEmpty({ month }), isSummary, options)
}
/** «Динамика»: income and saved of every month of the window (the window as of the other blocks). */
export async function getIncomeTrends(params: TrendsParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<IncomeTrends>> {
  const { months, month, from, to } = params
  return invalidIds({ months }, options.signal) ?? getLocalJson('stats/trends/incomes/', omitEmpty({ months, month, from, to }), isTrends, options)
}

/** «Статистика → Доходы»: the figures of the window and income by category (the window as of «Динамика»). */
export async function getIncomeStats(params: TrendsParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<IncomeStats>> {
  const { months, from, to } = params
  return invalidIds({ months }, options.signal) ?? getLocalJson('stats/incomes/', omitEmpty({ months, from, to }), isStats, options)
}

/** Another screen added an income: «Главная» reads its line again. */
export const INCOME_CHANGED = 'checkist:income-changed'
export function announceIncome() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(INCOME_CHANGED))
}
