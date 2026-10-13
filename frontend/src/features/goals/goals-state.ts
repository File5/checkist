/** «Цели» without the network and React: the words of progress and forecast, the forms and their bodies. Every number
 * comes from the server (`api/goals.ts`); money is shown only through `lib/money.ts`. */
import type { Contribution, ContributionInput, Goal, GoalInput } from '../../api/goals'
import type { LocalApiFailure } from '../../api/types'
import { formatMoney, formatMoneyNumber } from '../../lib/money'
import { glue } from '../../lib/text'

const plural = (count: number, one: string, few: string, many: string) => {
  const tens = count % 100
  const units = count % 10
  if (tens >= 11 && tens <= 14) return many
  return units === 1 ? one : units >= 2 && units <= 4 ? few : many
}
export const monthWord = (count: number) => plural(count, 'месяц', 'месяца', 'месяцев')

/** The width of the bar: the per cent, at most the whole bar. */
export const barShare = (goal: Pick<Goal, 'percent'>) => Math.min(100, goal.percent)

/** «12 окт. 2026» of a calendar date, without a timezone shift. */
export function dayText(value: string, year = true): string {
  const [y, m, d] = value.split('-').map(Number)
  if (!y || !m || !d) return value
  return new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'short', ...(year && { year: 'numeric' }), timeZone: 'UTC' })
    .format(Date.UTC(y, m - 1, d)).replace(/\s*г\.$/, '')
}

/** «252 000 из 600 000 ₸». */
export const savedOf = (goal: Goal) => `${formatMoneyNumber(goal.saved)} из ${formatMoney(goal.amount, goal.currency)}`

/** Whose the goal is: «Общая» or «Личная · Лиза». */
export function kindText(goal: Goal): string {
  return goal.shared ? 'Общая' : ['Личная', goal.owner?.display_name].filter(Boolean).join(' · ')
}

/** The line under a goal of the list: whose it is, the deadline. */
export function goalMeta(goal: Goal): string {
  const parts = [kindText(goal)]
  if (goal.reached) parts.push('цель достигнута')
  else if (goal.deadline) parts.push(goal.overdue ? `срок ${dayText(goal.deadline)} прошёл` : `до ${dayText(goal.deadline)}`)
  return parts.join(' · ')
}

/** «В среднем откладываете 40 000 ₸ в месяц — до цели ~12 месяцев»; without contributions of three months — none. */
export function paceText(goal: Goal): string | null {
  if (goal.reached) return null
  if (!goal.pace) return goal.contributions_count ? 'За последние три месяца взносов не было — прогноза пока нет.' : null
  const pace = `В среднем откладываете ${formatMoney(goal.pace.per_month, goal.currency)} в месяц`
  const left = goal.pace.months_left
  return left === null ? `${pace}.` : `${pace} — до цели ~${glue(left, monthWord(left))}.`
}

/** «Чтобы успеть к 30 апр. 2027, нужно 68 572 ₸ в месяц» or «Срок 30 апр. 2027 прошёл». */
export function deadlineText(goal: Goal): string | null {
  if (!goal.deadline || goal.reached) return null
  if (goal.overdue) return `Срок ${dayText(goal.deadline)} прошёл — осталось ${formatMoney(goal.remaining, goal.currency)}.`
  return goal.need_per_month ? `Чтобы успеть к ${dayText(goal.deadline)}, нужно ${formatMoney(goal.need_per_month, goal.currency)} в месяц.` : null
}

/** «Без курса: 10 000 ₸ — в «накоплено» не входит». */
export function excludedText(goal: Goal): string | null {
  if (!goal.excluded.length) return null
  return `Без курса на день взноса: ${goal.excluded.map((item) => formatMoney(item.amount, item.currency)).join(', ')} — в «накоплено» не входит.`
}

/** The line under a contribution: the day, who, and where it came from. */
export function contributionMeta(item: Contribution): string {
  return [dayText(item.date), item.user?.display_name, item.note].filter(Boolean).join(' · ')
}

/** A money field as typed: «600 000», «1200,50» → "600000", "1200.50"; `null` — not a positive amount. */
export function moneyValue(text: string): string | null {
  const value = text.replace(/\s/g, '').replace(',', '.')
  return /^\d{1,12}(?:\.\d{1,2})?$/.test(value) && Number(value) > 0 ? value : null
}

export type GoalDraft = { name: string; amount: string; currency: string; deadline: string; shared: boolean }
export type GoalErrors = Partial<Record<'name' | 'amount' | 'currency', string>>

export const goalDraftOf = (goal: Goal | null, currency: string, shared: boolean): GoalDraft => goal
  ? { name: goal.name, amount: goal.amount.replace(/\.00$/, ''), currency: goal.currency, deadline: goal.deadline ?? '', shared: goal.shared }
  : { name: '', amount: '', currency, deadline: '', shared }

export function goalErrors(draft: GoalDraft): GoalErrors {
  const errors: GoalErrors = {}
  if (!draft.name.trim()) errors.name = 'Назовите цель.'
  if (moneyValue(draft.amount) === null) errors.amount = 'Сумма больше нуля.'
  if (!/^[A-Za-z]{3}$/.test(draft.currency.trim())) errors.currency = 'Код валюты — три буквы.'
  return errors
}

/** The body of a new goal (`shared` only with a family) or of a change. */
export const goalBody = (draft: GoalDraft, household: boolean): GoalInput => ({
  name: draft.name.trim(), amount: moneyValue(draft.amount) ?? '', currency: draft.currency.trim().toUpperCase(),
  deadline: draft.deadline || null, ...(household && { shared: draft.shared }),
})

export type ContributionDraft = { amount: string; date: string; user: string }

export const contributionDraftOf = (item: Contribution | null, today: string, user: string): ContributionDraft => item
  ? { amount: item.amount.replace(/\.00$/, ''), date: item.date, user: item.user?.username ?? user }
  : { amount: '', date: today, user }

export const contributionBody = (draft: ContributionDraft): ContributionInput => ({
  amount: moneyValue(draft.amount) ?? '', date: draft.date, ...(draft.user && { user: draft.user }),
})

/** A refusal of the goals API in words of the screen. */
export function goalFailure(failure: Pick<LocalApiFailure, 'reason'>): string {
  switch (failure.reason) {
    case 'not_found': return 'Цель не найдена — возможно, её уже удалили.'
    case 'invalid_parameter': return 'Проверьте поля формы.'
    case 'timeout': return 'Сервер не ответил вовремя. Повторите попытку.'
    case 'network': return 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.'
    case 'csrf_failed': return 'Сессия устарела. Повторите действие.'
    case 'database_unavailable': return 'Данные временно недоступны. Повторите попытку позже.'
    default: return 'Не получилось. Повторите попытку.'
  }
}
