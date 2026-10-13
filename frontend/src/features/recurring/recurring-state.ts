import type {
  RecurringDecisionKind, RecurringInput, RecurringMonth, RecurringMonthPayment, RecurringPayment, RecurringQuestion, RecurringState,
  RecurringSuggestion,
} from '../../api/recurring'
import type { LocalApiFailure } from '../../api/types'
import { formatMoney } from '../../lib/money'
import { glue } from '../../lib/text'
import { dayAndMonth, plural } from '../dashboard/dashboard-state'

/** The words of the screens of regular payments; the server's messages never reach the screen. */

const nominative = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']

/** «за сентябрь» (the year only when it is not the year of `today`). */
export function forMonth(month: string, today: string): string {
  const name = nominative[Number(month.slice(5, 7)) - 1]
  return glue('за', month.slice(0, 4) === today.slice(0, 4) ? name : glue(name, month.slice(0, 4)))
}

/** «Нашёл 3 регулярных платежа». */
export function foundText(count: number): string {
  return glue('Нашёл', String(count), plural(count, 'регулярный платёж', 'регулярных платежа', 'регулярных платежей'))
}

/** «2 платежа». */
export function paymentsText(count: number): string {
  return glue(String(count), plural(count, 'платёж', 'платежа', 'платежей'))
}

const daysBetween = (from: string, to: string) => Math.round((Date.UTC(+to.slice(0, 4), +to.slice(5, 7) - 1, +to.slice(8, 10))
  - Date.UTC(+from.slice(0, 4), +from.slice(5, 7) - 1, +from.slice(8, 10))) / 86_400_000)

/** What a payment is in its month, in a few words: «оплачен 5 октября», «до 25 октября», «просрочен с 5 октября». */
export function stateText(row: Pick<RecurringMonthPayment, 'state' | 'due_date' | 'paid' | 'added'>, today: string): string {
  switch (row.state) {
    case 'paid':
      if (row.added) return 'добавлен по средней'
      return row.paid ? glue('оплачен', dayAndMonth(row.paid.purchased_on)) : 'оплачен'
    case 'skipped': return 'не было'
    case 'elsewhere': return 'оплачено иначе'
    case 'due': {
      const days = daysBetween(today, row.due_date)
      if (days === 0) return 'срок сегодня'
      if (days === 1) return 'срок завтра'
      return glue('до', dayAndMonth(row.due_date))
    }
    case 'overdue': return glue('просрочен с', dayAndMonth(row.due_date))
    case 'before': return 'ещё не начался'
    case 'inactive': return 'выключен'
  }
}

/** «было 200 $, стало 225 $» when the last payment differs from the one before it. */
export function changeText(row: Pick<RecurringMonthPayment, 'last_amount' | 'previous_amount' | 'currency'>): string | null {
  if (!row.previous_amount || !row.last_amount) return null
  return `было ${formatMoney(row.previous_amount, row.currency)}, стало ${formatMoney(row.last_amount, row.currency)}`
}

/** The mark of a month in the six-month strip; the word is for the screen reader and the tooltip. */
export const historyWords: Record<RecurringState, string> = {
  paid: 'оплачен', skipped: 'не было', elsewhere: 'оплачено иначе', due: 'ещё не срок', overdue: 'не оплачен',
  before: 'ещё не было платежа', inactive: 'выключен',
}

/** The payments of the month that count: on, and already started. */
export function counted(data: RecurringMonth): RecurringMonthPayment[] {
  return data.payments.filter((row) => row.state !== 'before' && row.state !== 'inactive')
}
export const isOpen = (row: RecurringMonthPayment) => row.state === 'due' || row.state === 'overdue'

/** «каждый месяц около 5-го · 6 месяцев подряд». */
export function suggestionMeta(item: RecurringSuggestion): string {
  return [glue('около', `${item.due_day}-го`), glue(String(item.months), plural(item.months, 'месяц', 'месяца', 'месяцев'), 'подряд')].join(' · ')
}

/** The form of a payment: what a person types, as text. */
export type RecurringDraft = {
  name: string
  store_name: string
  category_id: number | null
  currency: string
  amount: string
  due_day: string
  active: boolean
}

export function draftOf(payment: RecurringPayment | null, currency: string): RecurringDraft {
  if (!payment) return { name: '', store_name: '', category_id: null, currency, amount: '', due_day: '', active: true }
  return {
    name: payment.name, store_name: payment.store?.name ?? '', category_id: payment.category.id, currency: payment.currency,
    amount: payment.amount.replace(/\.00$/, ''), due_day: String(payment.due_day), active: payment.active,
  }
}

/** «6 700,50» → «6700.50»; `null` — not an amount above zero with at most two decimals. */
export function amountValue(input: string): string | null {
  // `\s` takes the no-break space of a pasted «6 700» too.
  const text = input.replace(/\s/g, '').replace(',', '.')
  if (!/^\d{1,12}(\.\d{1,2})?$/.test(text) || !/[1-9]/.test(text)) return null
  return text
}

export type DraftErrors = Partial<Record<'name' | 'category_id' | 'currency' | 'amount' | 'due_day', string>>

export function draftErrors(draft: RecurringDraft): DraftErrors {
  const errors: DraftErrors = {}
  if (!draft.name.trim()) errors.name = 'Назовите платёж.'
  if (draft.category_id === null) errors.category_id = 'Выберите категорию.'
  if (!/^[A-Za-z]{3}$/.test(draft.currency.trim())) errors.currency = 'Код валюты — три буквы.'
  if (amountValue(draft.amount) === null) errors.amount = 'Сумма больше нуля.'
  const day = Number(draft.due_day)
  if (!/^\d{1,2}$/.test(draft.due_day.trim()) || day < 1 || day > 31) errors.due_day = 'Число от 1 до 31.'
  return errors
}

/** The body of the form; call after `draftErrors` came back empty. */
export function draftBody(draft: RecurringDraft): RecurringInput {
  return {
    name: draft.name.trim(), store_name: draft.store_name.trim() || null, category_id: draft.category_id as number,
    currency: draft.currency.trim().toUpperCase(), amount: amountValue(draft.amount) as string,
    due_day: Number(draft.due_day), active: draft.active,
  }
}

/** A line under an answer: what happened, and the spend it made. */
export type Notice = { text: string; receiptId?: number | null }

/** «Добавил трату «Интернет» за сентябрь — 6 700 ₸.» / «„Интернет“ за сентябрь: отметил, что платежа не было.» */
export function decisionNotice(question: RecurringQuestion, decision: RecurringDecisionKind, receiptId: number | null, today: string): Notice {
  const month = forMonth(question.month, today)
  if (decision === 'added') return { text: `Добавил трату «${question.name}» ${month} — ${formatMoney(question.amount, question.currency)}.`, receiptId }
  return { text: `«${question.name}» ${month}: ${decision === 'skipped' ? 'отметил, что платежа не было' : 'отметил, что оплачено иначе'}.` }
}

/** Local texts of a refusal; 409 — the month was answered or paid meanwhile, the list is read again. */
export function recurringFailure(failure: Pick<LocalApiFailure, 'reason' | 'status' | 'fields'>): string {
  if (failure.status === 409) return 'Этот месяц уже отмечен — обновили список.'
  switch (failure.reason) {
    case 'not_found': return 'Платёж не найден — возможно, его уже удалили. Обновили список.'
    case 'invalid_parameter': return 'Проверьте поля формы.'
    case 'timeout': return 'Сервер не ответил вовремя. Повторите попытку.'
    case 'network': return 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.'
    case 'csrf_failed': return 'Сессия устарела. Повторите действие.'
    case 'database_unavailable': return 'Данные временно недоступны. Повторите попытку позже.'
    default: return 'Не получилось. Повторите попытку.'
  }
}
