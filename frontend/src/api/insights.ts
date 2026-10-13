import { getLocalJson, mutate } from './local.ts'
import { isMonthCode } from './budget-schema.ts'
import { isExecutor } from './recognition-schema.ts'
import { amount, array, choice, currency, isId, isISODateTime, nonNegativeInteger, nullable, object, text } from './schema.ts'
import type { Check, Guard } from './schema.ts'
import type { Executor } from './recognition-types.ts'
import type { CurrencyCode, Decimal, ISODateTime, LocalApiResult, RequestOptions } from './types.ts'

/** ИИ о тратах (`/api/insights/`): the month review and answers to questions. The model is asked by the worker; a
 * request waits in a queue (`queued` → `running` → `succeeded` | `failed`) and the client polls it. The numbers of a
 * review (`figures`) are the server's own — the summary the model got — and are shown next to the model's words. */
export type InsightStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type ReviewAnswer = { summary: string; changes: string | null; limits: string | null; advice: string[] }
export type AskAnswer = { answer: string }

/** Numbers of one figure line: the month, the one before and the average of the earlier months (null — none). */
export type Figure = {
  spent: Decimal; previous: Decimal; average: Decimal | null; change_previous: Decimal; change_average: Decimal | null
}
export type ReviewFigures = Figure & {
  month: string
  currency: CurrencyCode
  categories: (Figure & { id: number; name: string })[]
  limit_total: Decimal | null
  limited_spent: Decimal | null
  limits: { category: string; limit: Decimal; spent: Decimal; over: Decimal | null }[]
  places: { name: string; spent: Decimal; count: number }[]
  /** Spends in another currency without a rate: left out of every number above. */
  without_rate: { currency: CurrencyCode; receipts: number; total: Decimal }[]
}
type InsightBase = {
  id: number; month: string; question: string; status: InsightStatus
  /** Numbers of the text that are not among the figures of the summary, as written: shown as not checked. */
  unverified: string[]
  /** Only with `failed`; the message is a fixed server text, the client shows its own by `code`. */
  error: { code: string; message: string } | null
  created_at: ISODateTime; finished_at: ISODateTime | null; executor: Executor
}
export type Review = InsightBase & { kind: 'review'; answer: ReviewAnswer | null; figures: ReviewFigures }
export type Ask = InsightBase & { kind: 'ask'; answer: AskAnswer | null }
export type ReviewMonth = { month: string; figures: ReviewFigures; review: Review | null; pending: Review | null }

const figureShape = { spent: amount, previous: amount, average: nullable(amount), change_previous: amount, change_average: nullable(amount) }
const isFigures = object<ReviewFigures>({
  ...figureShape, month: isMonthCode, currency,
  categories: array(object<ReviewFigures['categories'][number]>({ ...figureShape, id: isId, name: text })),
  limit_total: nullable(amount), limited_spent: nullable(amount),
  limits: array(object<ReviewFigures['limits'][number]>({ category: text, limit: amount, spent: amount, over: nullable(amount) })),
  places: array(object<ReviewFigures['places'][number]>({ name: text, spent: amount, count: nonNegativeInteger })),
  without_rate: array(object<ReviewFigures['without_rate'][number]>({ currency, receipts: nonNegativeInteger, total: amount })),
})
const baseShape = {
  id: isId, month: isMonthCode, question: text, status: choice('queued', 'running', 'succeeded', 'failed'),
  unverified: array(text), error: nullable(object<{ code: string; message: string }>({ code: text, message: text })),
  created_at: isISODateTime, finished_at: nullable(isISODateTime), executor: isExecutor,
}
const isReviewAnswer = object<ReviewAnswer>({ summary: text, changes: nullable(text), limits: nullable(text), advice: array(text) })
/** An answer comes only with `succeeded`, an error only with `failed`. */
const settled = <T extends InsightBase & { answer: unknown }>(shape: Guard<T>): Guard<T> => (value): value is T => shape(value)
  && (value.answer !== null) === (value.status === 'succeeded') && (value.error !== null) === (value.status === 'failed')
export const isReview = settled(object<Review>({ ...baseShape, kind: choice('review'), answer: nullable(isReviewAnswer), figures: isFigures }))
export const isAsk = settled(object<Ask>({ ...baseShape, kind: choice('ask'), answer: nullable(object<AskAnswer>({ answer: text })) }))
const isReviewMonth = object<ReviewMonth>({ month: isMonthCode, figures: isFigures, review: nullable(isReview as Check), pending: nullable(isReview as Check) })
const isAsks = object<{ results: Ask[] }>({ results: array(isAsk as Check) })

const post = <T>(path: string, body: unknown, guard: Guard<T>, options: RequestOptions) =>
  mutate(path, JSON.stringify(body), guard, options)

/** The figures of a month and its review; without `month` — the month before the current one. */
export async function getReview(month?: string, options: RequestOptions = {}): Promise<LocalApiResult<ReviewMonth>> {
  if (options.signal?.aborted) return { kind: 'aborted' }
  if (month !== undefined && !isMonthCode(month)) return { kind: 'error', reason: 'invalid_parameter', fields: ['month'] }
  return getLocalJson('insights/review/', { month }, isReviewMonth, options)
}
/** A new review of the month into the queue; an unfinished one of the same month comes back instead. */
export function requestReview(month: string, options: RequestOptions = {}): Promise<LocalApiResult<Review>> {
  return post('insights/review/', { month }, isReview, options)
}
export function getReviewRequest(id: number, options: RequestOptions = {}): Promise<LocalApiResult<Review>> {
  return getLocalJson(`insights/${id}/`, {}, isReview, options)
}
/** The person's latest questions, newest first; nobody else sees them. */
export function getAsks(options: RequestOptions = {}): Promise<LocalApiResult<{ results: Ask[] }>> {
  return getLocalJson('insights/ask/', {}, isAsks, options)
}
export function askQuestion(question: string, options: RequestOptions = {}): Promise<LocalApiResult<Ask>> {
  return post('insights/ask/', { question }, isAsk, options)
}
export function getAsk(id: number, options: RequestOptions = {}): Promise<LocalApiResult<Ask>> {
  return getLocalJson(`insights/${id}/`, {}, isAsk, options)
}
