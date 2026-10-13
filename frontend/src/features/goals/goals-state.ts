/** «Цели» without the network and React: the words of progress and forecast, the forms and their bodies. Every number
 * comes from the server (`api/goals.ts`); money is shown only through `lib/money.ts`. */
import type { Capitalization, Contribution, ContributionInput, Goal, GoalDetail, GoalInput, GoalKind, ReconcileInput } from '../../api/goals'
import type { LocalApiFailure } from '../../api/types'
import type { LineChartSeries } from '../../lib/charts'
import { chartNumber } from '../../lib/charts/scale'
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

/** The line under a goal of the list: whose a personal goal is (in a family; the section says «общая»), a deposit and its rate,
 * the deadline. */
export function goalMeta(goal: Goal, household: boolean): string {
  const parts = [
    household && !goal.shared ? goal.owner?.display_name ?? '' : '',
    goal.kind === 'deposit' && goal.rate ? `депозит ${rateText(goal.rate)}` : '',
  ]
  if (goal.reached) parts.push('цель достигнута')
  else if (goal.deadline) parts.push(goal.overdue ? `срок ${dayText(goal.deadline)} прошёл` : `до ${dayText(goal.deadline)}`)
  return parts.filter(Boolean).join(' · ')
}

/** «В среднем откладываете 40 000 ₸ в месяц — до цели ~12 месяцев»; without contributions of three months — none. */
export function paceText(goal: Goal): string | null {
  if (goal.reached) return null
  if (!goal.pace) return goal.contributions_count ? 'За последние три месяца взносов не было — прогноза пока нет.' : null
  const pace = `В среднем откладываете ${formatMoney(goal.pace.per_month, goal.currency)} в месяц`
  const left = goal.pace.months_left
  return left === null ? `${pace}.` : `${pace} — до цели ~${glue(left, monthWord(left))}.`
}

/** «Чтобы успеть к 30 апр. 2027, нужно 68 572 ₸ в месяц» or «Срок 30 апр. 2027 прошёл»; a deposit — with its interest. */
export function deadlineText(goal: Goal): string | null {
  if (!goal.deadline || goal.reached) return null
  if (goal.overdue) return `Срок ${dayText(goal.deadline)} прошёл — осталось ${formatMoney(goal.remaining, goal.currency)}.`
  if (goal.deposit?.by_interest) return `К ${dayText(goal.deadline)} цель будет достигнута процентами — без новых взносов.`
  if (goal.deposit && goal.need_per_month) {
    return `Чтобы к ${dayText(goal.deadline)} было ${formatMoney(goal.amount, goal.currency)}, вносите по ${formatMoney(goal.need_per_month, goal.currency)} в месяц — с процентами.`
  }
  return goal.need_per_month ? `Чтобы успеть к ${dayText(goal.deadline)}, нужно ${formatMoney(goal.need_per_month, goal.currency)} в месяц.` : null
}

/** «12 %», «14,5 %» of a rate «12.00», «14.50». */
export const rateText = (rate: string) => `${rate.replace(/\.?0+$/, '').replace('.', ',')}\u00a0%`

/** «Депозит · 14,5 % годовых · капитализация ежемесячно»; `null` — a saving. */
export function depositTerms(goal: Goal): string | null {
  if (goal.kind !== 'deposit' || goal.rate === null) return null
  return `Депозит · ${rateText(goal.rate)} годовых · ${goal.capitalization === 'monthly' ? 'капитализация ежемесячно' : 'без капитализации'}`
}

/** «+1 485 ₸» — a sign before a positive amount too. */
export const signed = (amount: string, currency: string) => `${amount.startsWith('-') ? '' : '+'}${formatMoney(amount, currency)}`

/** The forecast lines of a deposit: by the deadline at the current pace, and a year without contributions. */
export function depositLines(goal: Goal): string[] {
  const figures = goal.deposit
  if (!figures || goal.reached) return []
  const lines: string[] = []
  if (figures.at_deadline && goal.deadline) {
    lines.push(`При нынешнем темпе к ${dayText(goal.deadline)} будет ${formatMoney(figures.at_deadline.total, goal.currency)}, из них проценты ${formatMoney(figures.at_deadline.interest, goal.currency)}.`)
  }
  if (figures.in_a_year) lines.push(`Если больше не вносить — через год будет ${formatMoney(figures.in_a_year, goal.currency)}.`)
  return lines
}

/** The three lines of the growth chart: the sum on the deposit (solid), its forecast at the current pace (dashed, from the
 * last real month), contributions without interest. Every number is the server's; the client only draws. */
export function growthSeries(goal: GoalDetail): LineChartSeries[] {
  const points = goal.series ?? []
  const point = (key: 'total' | 'deposits') => (item: (typeof points)[number]) => {
    const value = chartNumber(item[key])
    return value === null ? [] : [{ x: `${item.month}-01`, value, valueText: formatMoney(item[key], goal.currency) }]
  }
  const real = points.filter((item) => !item.forecast)
  const ahead = points.filter((item) => item.forecast)
  return [
    { key: 'total', label: 'На депозите', slot: 0, points: real.flatMap(point('total')) },
    ...(ahead.length ? [{ key: 'forecast', label: 'Прогноз', slot: 1, points: [...real.slice(-1), ...ahead].flatMap(point('total')) }] : []),
    { key: 'deposits', label: 'Внесено', slot: 2, points: points.flatMap(point('deposits')) },
  ]
}

/** «Без курса: 10 000 ₸ — в «накоплено» не входит». */
export function excludedText(goal: Goal): string | null {
  if (!goal.excluded.length) return null
  return `Без курса на день взноса: ${goal.excluded.map((item) => formatMoney(item.amount, item.currency)).join(', ')} — в «накоплено» не входит.`
}

/** The title of a history row: «+50 000 ₸», a reconciliation — «Сверка с банком: +115 ₸». */
export const contributionTitle = (item: Contribution) => item.kind === 'interest'
  ? `Сверка с банком: ${signed(item.amount, item.currency)}` : `+${formatMoney(item.amount, item.currency)}`

/** The line under a contribution: the day, who, and where it came from. */
export function contributionMeta(item: Contribution): string {
  return [dayText(item.date), item.user?.display_name, item.note].filter(Boolean).join(' · ')
}

/** A money field as typed: «600 000», «1200,50» → "600000", "1200.50"; `null` — not a positive amount. */
export function moneyValue(text: string): string | null {
  const value = text.replace(/\s/g, '').replace(',', '.')
  return /^\d{1,12}(?:\.\d{1,2})?$/.test(value) && Number(value) > 0 ? value : null
}

export type GoalDraft = {
  name: string; amount: string; currency: string; deadline: string; shared: boolean
  kind: GoalKind; rate: string; capitalization: Capitalization
}
export type GoalErrors = Partial<Record<'name' | 'amount' | 'currency' | 'rate', string>>

/** A rate as typed: «14,5» → "14.5"; `null` — not 0–100 with at most two decimals. */
export function rateValue(text: string): string | null {
  const value = text.replace(/\s|%/g, '').replace(',', '.')
  return /^\d{1,3}(?:\.\d{1,2})?$/.test(value) && Number(value) <= 100 ? value : null
}

export const goalDraftOf = (goal: Goal | null, currency: string, shared: boolean): GoalDraft => goal
  ? {
    name: goal.name, amount: goal.amount.replace(/\.00$/, ''), currency: goal.currency, deadline: goal.deadline ?? '', shared: goal.shared,
    kind: goal.kind, rate: goal.rate ? goal.rate.replace(/\.?0+$/, '').replace('.', ',') : '', capitalization: goal.capitalization,
  }
  : { name: '', amount: '', currency, deadline: '', shared, kind: 'saving', rate: '', capitalization: 'monthly' }

export function goalErrors(draft: GoalDraft): GoalErrors {
  const errors: GoalErrors = {}
  if (!draft.name.trim()) errors.name = 'Назовите цель.'
  if (moneyValue(draft.amount) === null) errors.amount = 'Сумма больше нуля.'
  if (!/^[A-Za-z]{3}$/.test(draft.currency.trim())) errors.currency = 'Код валюты — три буквы.'
  if (draft.kind === 'deposit' && rateValue(draft.rate) === null) errors.rate = 'Ставка — от 0 до 100 % годовых.'
  return errors
}

/** The body of a new goal (`shared` only with a family) or of a change. */
export const goalBody = (draft: GoalDraft, household: boolean): GoalInput => ({
  name: draft.name.trim(), amount: moneyValue(draft.amount) ?? '', currency: draft.currency.trim().toUpperCase(),
  deadline: draft.deadline || null, ...(household && { shared: draft.shared }), kind: draft.kind,
  ...(draft.kind === 'deposit' && { rate: rateValue(draft.rate) ?? '', capitalization: draft.capitalization }),
})

export type ReconcileDraft = { balance: string; date: string }
export const reconcileBody = (draft: ReconcileDraft): ReconcileInput => ({ balance: moneyValue(draft.balance) ?? '', date: draft.date })

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
