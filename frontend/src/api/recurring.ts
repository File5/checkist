import { getLocalJson, mutate } from './local.ts'
import { isMonthCode } from './budget-schema.ts'
import { amount, array, bool, choice, currency, isId, isISODate, nonNegativeInteger, nullable, object, text } from './schema.ts'
import type { Check, Guard } from './schema.ts'
import type { CurrencyCode, Decimal, ISODate, LocalApiResult, RequestOptions } from './types.ts'
import { isPerson } from '../lib/people.ts'
import type { Person } from '../lib/people.ts'
import { isPaymentMethod } from '../lib/payment-methods.ts'
import type { PaymentMethodValue } from '../lib/payment-methods.ts'

/** «Регулярные платежи» (`/api/recurring/`): a payment of every month — rent, utilities, internet, a subscription.
 * Whether it is paid in a month is the server's check of the spends on every read; nothing here is stored by the client.
 * `paid` / `skipped` («не было») / `elsewhere` («оплачено иначе») close the month, `due` / `overdue` leave it open,
 * `before` — the month is earlier than the payment, `inactive` — the payment is switched off. */
export const recurringStates = ['paid', 'skipped', 'elsewhere', 'due', 'overdue', 'before', 'inactive'] as const
export type RecurringState = typeof recurringStates[number]
export type RecurringDecisionKind = 'added' | 'skipped' | 'elsewhere'

export type RecurringPayment = {
  id: number
  /** `income` — a regular income («Зарплата»): `category` is a category of incomes, no `store`, `paid` — received
   * (`paid.receipt_id` is `null`). Seen by its author and the head of the family only. */
  kind: 'spend' | 'income'
  name: string
  store: { id: number; name: string } | null
  category: { id: number; name: string }
  currency: CurrencyCode
  /** The expected amount. */
  amount: Decimal
  /** The day of the month; 31 is the last day of a short month. */
  due_day: number
  active: boolean
  created_by: Person | null
}
export type RecurringMonthPayment = RecurringPayment & {
  state: RecurringState
  due_date: ISODate
  /** The spend found for the month (or added by «по средней»); of an income — the income, without a receipt. */
  paid: { receipt_id: number | null; purchased_on: ISODate; total: Decimal } | null
  added: boolean
  /** The average of the payments found in the 12 months up to this one. */
  average: Decimal | null
  last_amount: Decimal | null
  /** The payment before the last one, only when it differs: «было 200 $, стало 225 $». */
  previous_amount: Decimal | null
  /** The six months up to this one, oldest first. */
  history: { month: string; state: RecurringState }[]
  /** «Как и сколько оплатил»: twelve months up to this one; `null` — switched off; missing from an older server. */
  year?: RecurringYear | null
}
/** A month of the history of a payment, newest first: its state and the spend found (or added) with its way of payment. */
export type RecurringYearMonth = {
  month: string; state: RecurringState
  paid: { receipt_id: number | null; purchased_on: ISODate; total: Decimal; payment_method: PaymentMethodValue } | null
}
/** The twelve months and what was paid in them in the currency of the payment, by way of payment, the most first. */
export type RecurringYear = { months: RecurringYearMonth[]; total: Decimal | null; methods: { payment_method: PaymentMethodValue; total: Decimal }[] }
/** «Оплатил»: a spend of `amount` on `purchased_on` with the place and the category of the payment closes `month`. */
export type RecurringPayInput = { month: string; amount: Decimal; payment_method: PaymentMethodValue; purchased_on: ISODate }
/** «За сентябрь оплата не найдена»: from the 1st of a month, about the month before. */
export type RecurringQuestion = {
  payment_id: number; name: string; month: string; due_date: ISODate; currency: CurrencyCode
  /** The average of the found payments, or the expected amount when none was found (`from_history: false`). */
  amount: Decimal; from_history: boolean
}
/** «Похоже на регулярный платёж»: the same place and category with a similar amount three months in a row. */
export type RecurringSuggestion = {
  store_id: number; store_name: string; category_id: number; category_name: string; currency: CurrencyCode
  amount: Decimal; due_day: number; months: number; last_date: ISODate; name: string
}
export type RecurringTotal = { currency: CurrencyCode; payments: number; done: number; left: Decimal | null }
export type RecurringMonth = {
  month: string; previous_month: string; today: ISODate
  payments: RecurringMonthPayment[]; questions: RecurringQuestion[]; suggestions: RecurringSuggestion[]; totals: RecurringTotal[]
}
/** The body of a new payment; `store_name` — the place by its name, empty — none. */
export type RecurringInput = {
  name: string; store_name: string | null; category_id: number; currency: CurrencyCode; amount: Decimal; due_day: number; active?: boolean
  /** Only of a new one: `income` takes a category of incomes. */
  kind?: 'spend' | 'income'
}
export type SuggestionKey = Pick<RecurringSuggestion, 'store_id' | 'category_id' | 'currency'>
export type RecurringDecisionResult = { payment_id: number; month: string; decision: RecurringDecisionKind; receipt_id: number | null }

const state = choice(...recurringStates)
const dueDay: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 1 && (value as number) <= 31
const named = object<{ id: number; name: string }>({ id: isId, name: text })
const paymentShape = {
  id: isId, kind: choice('spend', 'income'), name: text, store: nullable(named), category: named, currency, amount, due_day: dueDay, active: bool,
  created_by: nullable(isPerson),
}
export const isRecurringPayment = object<RecurringPayment>(paymentShape)
const paidShape = { receipt_id: nullable(isId), purchased_on: isISODate, total: amount }
const isYear = object<RecurringYear>({
  months: array(object<RecurringYearMonth>({ month: isMonthCode, state,
    paid: nullable(object<NonNullable<RecurringYearMonth['paid']>>({ ...paidShape, payment_method: isPaymentMethod })) })),
  total: nullable(amount), methods: array(object<RecurringYear['methods'][number]>({ payment_method: isPaymentMethod, total: amount })),
})
const monthPaymentShape = object<Omit<RecurringMonthPayment, 'year'>>({
  ...paymentShape, state, due_date: isISODate,
  paid: nullable(object<NonNullable<RecurringMonthPayment['paid']>>(paidShape)),
  added: bool, average: nullable(amount), last_amount: nullable(amount), previous_amount: nullable(amount),
  history: array(object<RecurringMonthPayment['history'][number]>({ month: isMonthCode, state })),
})
const isMonthPayment: Guard<RecurringMonthPayment> = (value): value is RecurringMonthPayment => monthPaymentShape(value)
  && (!Object.hasOwn(value, 'year') || nullable(isYear)((value as Record<string, unknown>).year))
const isQuestion = object<RecurringQuestion>({
  payment_id: isId, name: text, month: isMonthCode, due_date: isISODate, currency, amount, from_history: bool,
})
const isSuggestion = object<RecurringSuggestion>({
  store_id: isId, store_name: text, category_id: isId, category_name: text, currency, amount, due_day: dueDay,
  months: nonNegativeInteger, last_date: isISODate, name: text,
})
export const isRecurringMonth: Guard<RecurringMonth> = object<RecurringMonth>({
  month: isMonthCode, previous_month: isMonthCode, today: isISODate, payments: array(isMonthPayment),
  questions: array(isQuestion), suggestions: array(isSuggestion),
  totals: array(object<RecurringTotal>({ currency, payments: nonNegativeInteger, done: nonNegativeInteger, left: nullable(amount) })),
})
const isDecision = object<RecurringDecisionResult>({
  payment_id: isId, month: isMonthCode, decision: choice('added', 'skipped', 'elsewhere'), receipt_id: nullable(isId),
})
const isKey = object<SuggestionKey>({ store_id: isId, category_id: isId, currency })
const isEmpty = (value: unknown): value is null => value === null

const send = <T>(path: string, body: unknown, guard: Guard<T>, options: RequestOptions, method: 'POST' | 'PATCH' | 'DELETE' = 'POST') =>
  mutate(path, body === undefined ? '' : JSON.stringify(body), guard, options, false, undefined, { method })

/** The payments of the family (or one's own) in a month; without `month` — the server's current one. */
export async function getRecurringMonth(month?: string, options: RequestOptions = {}): Promise<LocalApiResult<RecurringMonth>> {
  if (options.signal?.aborted) return { kind: 'aborted' }
  if (month !== undefined && !isMonthCode(month)) return { kind: 'error', reason: 'invalid_parameter', fields: ['month'] }
  return getLocalJson('recurring/', { month }, isRecurringMonth, options)
}
export function createRecurring(input: RecurringInput, options: RequestOptions = {}): Promise<LocalApiResult<RecurringPayment>> {
  return send('recurring/', input, isRecurringPayment, options)
}
export function updateRecurring(id: number, input: Partial<RecurringInput>, options: RequestOptions = {}): Promise<LocalApiResult<RecurringPayment>> {
  return send(`recurring/${id}/`, input, isRecurringPayment, options, 'PATCH')
}
export function deleteRecurring(id: number, options: RequestOptions = {}): Promise<LocalApiResult<null>> {
  return send(`recurring/${id}/`, undefined, isEmpty, options, 'DELETE')
}
/** The answer about a past month: `added` makes a spend of the average on the due day, the others only close the month.
 * A second answer about the same month is refused with 409 (the month is paid or already answered). */
export function decideRecurring(id: number, month: string, decision: RecurringDecisionKind, options: RequestOptions = {}): Promise<LocalApiResult<RecurringDecisionResult>> {
  return send(`recurring/${id}/decision/`, { month, decision }, isDecision, options)
}
/** «Оплатил»: the spend and the answer `added` for the month; 409 when the month is already paid or answered. */
export function payRecurring(id: number, input: RecurringPayInput, options: RequestOptions = {}): Promise<LocalApiResult<RecurringDecisionResult>> {
  return send(`recurring/${id}/pay/`, input, isDecision, options)
}
/** A payment from a suggestion in one tap; 404 when the suggestion is gone (already taken, history changed). */
export function acceptSuggestion(key: SuggestionKey, options: RequestOptions = {}): Promise<LocalApiResult<RecurringPayment>> {
  return send('recurring/suggestions/accept/', key, isRecurringPayment, options)
}
/** Never suggest it again. */
export function dismissSuggestion(key: SuggestionKey, options: RequestOptions = {}): Promise<LocalApiResult<SuggestionKey>> {
  return send('recurring/suggestions/dismiss/', key, isKey, options)
}
