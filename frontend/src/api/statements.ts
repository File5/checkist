import { invalidIds } from './http.ts'
import { getLocalJson, mutate } from './local.ts'
import { isExecutor } from './recognition-schema.ts'
import type { Executor } from './recognition-types.ts'
import { amount, array, bool, choice, currency, isId, isISODate, isISODateTime, named, nonNegativeInteger, nullable, object, page, text } from './schema.ts'
import type { Guard } from './schema.ts'
import type { CategoryRef, LocalApiResult, Page, PageParams, RequestOptions } from './types.ts'

/** Импорт выписок (`/api/statements/`): черновик личный, правила — общие на семью. */
export type StatementBank = 'kaspi_gold' | 'forte'
/** What the money was: a purchase or payment, a transfer to a person, cash, a move between own accounts or in the family,
 * an incoming (kept for later, never a spend), a refund netted against a purchase of the same day. */
export type StatementRowKind = 'spend' | 'transfer' | 'cash' | 'own_move' | 'income' | 'refund'
/** What the draft does with it: a spend (checked), questionable (highlighted), already entered, skipped, or a
 * contribution to a goal (a transfer to one's own deposit by a rule «→ цель»). */
export type StatementRowState = 'spend' | 'review' | 'duplicate' | 'skipped' | 'goal'
export type StatementRowAi = 'waiting' | 'done' | 'unknown' | 'failed' | 'off'
export type StatementRowSource = 'rule' | 'builtin' | 'mcc' | 'model'

export type StatementSummary = {
  id: number; bank: StatementBank; bank_name: string; date_from: string | null; date_to: string | null
  created_at: string; saved_at: string | null; rows_count: number; saved_count: number
}
export type StatementDuplicate = { id: number; purchased_on: string; total: string; currency: string; store_name: string | null }
export type StatementRow = {
  id: number; date: string
  /** With the sign of the bank: negative — money left the card. */
  amount: string; currency: string; operation: string; details: string; merchant: string; mcc: string | null
  /** Refunds of the same day already taken off; `spend` — what goes into the spend. */
  refund: string; spend: string
  kind: StatementRowKind; state: StatementRowState; reason: string | null
  category: CategoryRef | null; store_name: string | null; source: StatementRowSource | null; ai: StatementRowAi | null
  duplicate_of: StatementDuplicate | null
  /** The spend made of this row; `null` — not saved yet. */
  receipt_id: number | null
  /** The goal of a contribution row (and of a contribution already there, `reason: goal_duplicate`). */
  goal: GoalRef | null
  /** The contribution made of this row; `null` — not saved as one. */
  contribution_id: number | null
}
export type GoalRef = { id: number; name: string }
export type StatementDetail = StatementSummary & {
  /** `waiting` rows wait for the model; `active` — a question is queued or running. */
  ai: { waiting: number; active: boolean; executor: Executor }
  rows: StatementRow[]
}
export type StatementUpload = { reused: boolean; statement: StatementSummary }
/** A spend with its category and place, or a contribution to a goal. */
export type StatementSaveRow = { id: number; category: number; store_name: string } | { id: number; goal: number }
export type StatementSaveResult = { created: number; learned: number; contributed: number; statement: StatementDetail }
export type StatementGoalResult = { applied: number; statement: StatementDetail }

/** `goal` — a transfer to the payee is a contribution to a goal: personal, it applies to one's own statements only. */
export type StatementRuleAction = 'category' | 'skip' | 'own' | 'goal'
export type StatementRule = {
  id: number; pattern: string; action: StatementRuleAction; category: CategoryRef | null; store_name: string | null
  goal: GoalRef | null; origin: 'manual' | 'learned'; updated_at: string
}
export type StatementRuleInput = {
  pattern?: string; action?: StatementRuleAction; category?: number | null; store_name?: string; goal?: number | null
}

const categoryRef = object<CategoryRef>({ id: isId, name: text, path: array(named) })
const goalRef = object<GoalRef>({ id: isId, name: text })
const isSummary = object<StatementSummary>({
  id: isId, bank: choice('kaspi_gold', 'forte'), bank_name: text, date_from: nullable(isISODate), date_to: nullable(isISODate),
  created_at: isISODateTime, saved_at: nullable(isISODateTime), rows_count: nonNegativeInteger, saved_count: nonNegativeInteger,
})
const isRow = object<StatementRow>({
  id: isId, date: isISODate, amount, currency, operation: text, details: text, merchant: text, mcc: nullable(text),
  refund: amount, spend: amount,
  kind: choice('spend', 'transfer', 'cash', 'own_move', 'income', 'refund'), state: choice('spend', 'review', 'duplicate', 'skipped', 'goal'),
  reason: nullable(text), category: nullable(categoryRef), store_name: nullable(text),
  source: nullable(choice('rule', 'builtin', 'mcc', 'model')), ai: nullable(choice('waiting', 'done', 'unknown', 'failed', 'off')),
  duplicate_of: nullable(object<StatementDuplicate>({ id: isId, purchased_on: isISODate, total: amount, currency, store_name: nullable(text) })),
  receipt_id: nullable(isId), goal: nullable(goalRef), contribution_id: nullable(isId),
})
const isDetailPart = object<Pick<StatementDetail, 'ai' | 'rows'>>({
  ai: object<StatementDetail['ai']>({ waiting: nonNegativeInteger, active: bool, executor: isExecutor }), rows: array(isRow),
})
export const isStatementDetail: Guard<StatementDetail> = (value): value is StatementDetail => isSummary(value) && isDetailPart(value)
const isUpload = object<StatementUpload>({ reused: bool, statement: isSummary })
const isSaveResult = object<StatementSaveResult>({
  created: nonNegativeInteger, learned: nonNegativeInteger, contributed: nonNegativeInteger, statement: isStatementDetail,
})
const isGoalResult = object<StatementGoalResult>({ applied: nonNegativeInteger, statement: isStatementDetail })
const isRule = object<StatementRule>({
  id: isId, pattern: text, action: choice('category', 'skip', 'own', 'goal'), category: nullable(categoryRef), store_name: nullable(text),
  goal: nullable(goalRef), origin: choice('manual', 'learned'), updated_at: isISODateTime,
})
const isRules = object<{ results: StatementRule[] }>({ results: array(isRule) })
const isEmpty = (value: unknown): value is null => value === null

/** A PDF of Kaspi Gold or ForteBank: `201` a new draft, `200` with `reused` — the same file was imported before. */
export function uploadStatement(file: File, options: RequestOptions = {}): Promise<LocalApiResult<StatementUpload>> {
  const body = new FormData()
  body.append('file', file)
  return mutate('statements/', body, isUpload, options, true)
}
export function getStatements(params: PageParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Page<StatementSummary>>> {
  return getLocalJson('statements/', params, page(isSummary), options)
}
export async function getStatement(id: number, options: RequestOptions = {}): Promise<LocalApiResult<StatementDetail>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`statements/${id}/`, {}, isStatementDetail, options)
}
/** Spends of the checked rows; a row saved before is skipped. Never replayed implicitly. */
export async function saveStatement(id: number, rows: StatementSaveRow[], options: RequestOptions = {}): Promise<LocalApiResult<StatementSaveResult>> {
  return invalidIds({ id }, options.signal) ?? mutate(`statements/${id}/save/`, JSON.stringify({ rows }), isSaveResult, options)
}
/** «Это взнос в цель»: a personal rule «payee → goal» from the row and the transfers of the draft that follow it. */
export async function assignStatementGoal(id: number, row: number, goal: number, options: RequestOptions = {}): Promise<LocalApiResult<StatementGoalResult>> {
  return invalidIds({ id, row, goal }, options.signal) ?? mutate(`statements/${id}/goal/`, JSON.stringify({ row, goal }), isGoalResult, options)
}
/** The draft goes; the spends saved from it stay. */
export async function deleteStatement(id: number, options: RequestOptions = {}): Promise<LocalApiResult<null>> {
  return invalidIds({ id }, options.signal) ?? mutate(`statements/${id}/`, '', isEmpty, options, false, undefined, { method: 'DELETE' })
}

export function getStatementRules(options: RequestOptions = {}): Promise<LocalApiResult<{ results: StatementRule[] }>> {
  return getLocalJson('statements/rules/', {}, isRules, options)
}
export function createStatementRule(input: StatementRuleInput, options: RequestOptions = {}): Promise<LocalApiResult<StatementRule>> {
  return mutate('statements/rules/', JSON.stringify(input), isRule, options)
}
export async function updateStatementRule(id: number, input: StatementRuleInput, options: RequestOptions = {}): Promise<LocalApiResult<StatementRule>> {
  return invalidIds({ id }, options.signal) ?? mutate(`statements/rules/${id}/`, JSON.stringify(input), isRule, options, false, undefined, { method: 'PATCH' })
}
export async function deleteStatementRule(id: number, options: RequestOptions = {}): Promise<LocalApiResult<null>> {
  return invalidIds({ id }, options.signal) ?? mutate(`statements/rules/${id}/`, '', isEmpty, options, false, undefined, { method: 'DELETE' })
}
