import { invalidIds } from './http.ts'
import { getLocalJson, mutate } from './local.ts'
import { amount, array, bool, currency, isId, isISODate, nonNegativeInteger, nullable, object, text } from './schema.ts'
import type { Check, Guard } from './schema.ts'
import type { CurrencyCode, Decimal, ISODate, LocalApiResult, RequestOptions } from './types.ts'
import { isPerson } from '../lib/people.ts'
import type { Person } from '../lib/people.ts'

/** «Цели» (`/api/goals/`): a shared goal of the family (everyone sees and edits it) or a personal one (its owner and the
 * head of the family). Everything below is counted by the server in the goal's currency: a contribution in another
 * currency goes by the rate of its day, one without a rate is `excluded`. */
export type Goal = {
  id: number; name: string; amount: Decimal; currency: CurrencyCode; deadline: ISODate | null
  shared: boolean
  /** The owner of a personal goal; `null` for a shared one. */
  owner: Person | null
  created_by: Person | null
  saved: Decimal
  /** Whole per cent, may pass 100. */
  percent: number
  remaining: Decimal; reached: boolean
  excluded: { currency: CurrencyCode; amount: Decimal }[]
  contributions_count: number
  /** The average of the last three months; `null` — nothing put aside in them, no forecast. */
  pace: { per_month: Decimal; months_left: number | null } | null
  /** «Чтобы успеть, нужно N в месяц»: only with a deadline ahead and something still to save. */
  need_per_month: Decimal | null
  /** The deadline has passed and the goal is not reached. */
  overdue: boolean
}
export type Contribution = { id: number; amount: Decimal; currency: CurrencyCode; date: ISODate; user: Person | null; note: string }
export type GoalDetail = Goal & { contributions: Contribution[]; people: Person[] }
export type GoalList = { today: ISODate; base_currency: CurrencyCode; household: boolean; results: Goal[] }
export type GoalInput = { name?: string; amount?: Decimal; currency?: CurrencyCode; deadline?: ISODate | null; shared?: boolean }
export type ContributionInput = { amount?: Decimal; date?: ISODate; user?: string; currency?: CurrencyCode; note?: string }

const percent: Check = (value) => Number.isSafeInteger(value) && (value as number) >= 0
const goalShape = {
  id: isId, name: text, amount, currency, deadline: nullable(isISODate), shared: bool, owner: nullable(isPerson),
  created_by: nullable(isPerson), saved: amount, percent, remaining: amount, reached: bool,
  excluded: array(object<Goal['excluded'][number]>({ currency, amount })), contributions_count: nonNegativeInteger,
  pace: nullable(object<NonNullable<Goal['pace']>>({ per_month: amount, months_left: nullable(nonNegativeInteger) })),
  need_per_month: nullable(amount), overdue: bool,
}
export const isGoal: Guard<Goal> = object<Goal>(goalShape)
const isContribution = object<Contribution>({ id: isId, amount, currency, date: isISODate, user: nullable(isPerson), note: text })
export const isGoalDetail: Guard<GoalDetail> = object<GoalDetail>({ ...goalShape, contributions: array(isContribution), people: array(isPerson) })
const isGoalList = object<GoalList>({ today: isISODate, base_currency: currency, household: bool, results: array(isGoal) })
const isEmpty = (value: unknown): value is null => value === null

const send = <T>(path: string, body: unknown, guard: Guard<T>, options: RequestOptions, method: 'POST' | 'PATCH' | 'DELETE' = 'POST') =>
  mutate(path, body === undefined ? '' : JSON.stringify(body), guard, options, false, undefined, { method })

/** Shared goals first, then personal ones. */
export function getGoals(options: RequestOptions = {}): Promise<LocalApiResult<GoalList>> {
  return getLocalJson('goals/', {}, isGoalList, options)
}
export async function getGoal(id: number, options: RequestOptions = {}): Promise<LocalApiResult<GoalDetail>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`goals/${id}/`, {}, isGoalDetail, options)
}
/** Without `currency` the goal takes the base currency of the family; `shared` — only with a family. */
export function createGoal(input: GoalInput, options: RequestOptions = {}): Promise<LocalApiResult<GoalDetail>> {
  return send('goals/', input, isGoalDetail, options)
}
export async function updateGoal(id: number, input: GoalInput, options: RequestOptions = {}): Promise<LocalApiResult<GoalDetail>> {
  return invalidIds({ id }, options.signal) ?? send(`goals/${id}/`, input, isGoalDetail, options, 'PATCH')
}
/** The goal goes with its contributions. */
export async function deleteGoal(id: number, options: RequestOptions = {}): Promise<LocalApiResult<null>> {
  return invalidIds({ id }, options.signal) ?? send(`goals/${id}/`, undefined, isEmpty, options, 'DELETE')
}
/** A contribution; without `date` — today, without `user` — the one who adds it. The answer is the whole goal. */
export async function addContribution(goalId: number, input: ContributionInput, options: RequestOptions = {}): Promise<LocalApiResult<GoalDetail>> {
  return invalidIds({ goalId }, options.signal) ?? send(`goals/${goalId}/contributions/`, input, isGoalDetail, options)
}
export async function updateContribution(goalId: number, id: number, input: ContributionInput, options: RequestOptions = {}): Promise<LocalApiResult<GoalDetail>> {
  return invalidIds({ goalId, id }, options.signal) ?? send(`goals/${goalId}/contributions/${id}/`, input, isGoalDetail, options, 'PATCH')
}
export async function deleteContribution(goalId: number, id: number, options: RequestOptions = {}): Promise<LocalApiResult<GoalDetail>> {
  return invalidIds({ goalId, id }, options.signal) ?? send(`goals/${goalId}/contributions/${id}/`, undefined, isGoalDetail, options, 'DELETE')
}
