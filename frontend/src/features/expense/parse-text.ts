/** «Трата словами»: what the hint above the form shows and how a parse draft fills the form. No network, no React. */
import type { ManualParse, ManualParseDraft } from '../../api/receipts'
import type { Category } from '../../api/types'
import { errorMessage } from '../receipts/state'
import type { Failure } from '../receipts/state'
import { amountText, newLine } from './expense-form'
import type { ExpenseDraft } from './expense-form'

export const PARSE_TEXT_MAX = 500
/** The client stops waiting after this: a long recognition job may hold the worker. */
export const PARSE_WAIT_MS = 150_000

export const parseTexts = {
  label: 'Скажите словами — заполню форму',
  placeholder: 'такси до аэропорта 4500',
  button: 'Заполнить',
  working: 'Разбираю…',
  filled: 'Заполнено по тексту — проверьте и сохраните.',
  repeated: 'Заполнено как в прошлый раз, с сегодняшней датой — проверьте и сохраните.',
  unavailable: 'Разбор текста сейчас недоступен: исполнитель не запущен. Заполните форму вручную.',
  slow: 'Разбор затянулся. Заполните форму вручную или попробуйте позже.',
  failed: 'Не удалось разобрать текст. Заполните форму вручную.',
  timeout: 'Разбор не уложился в срок. Попробуйте ещё раз или заполните форму вручную.',
  lost: 'Исполнитель остановился во время разбора. Попробуйте ещё раз.',
  auth: 'Разбор сейчас недоступен: исполнителю нужен вход в Codex.',
  limit: 'Слишком много запросов на разбор. Дождитесь ответа и повторите.',
  text: `Напишите, на что потрачено и сколько — не длиннее ${PARSE_TEXT_MAX} символов.`,
} as const

export type ParseView =
  | { kind: 'idle' }
  | { kind: 'working' }
  | { kind: 'filled' }
  /** The form was filled from a past spend (a row or a chip under the field). */
  | { kind: 'repeated' }
  | { kind: 'failed'; message: string }

/** The message of a failed request by its code; the server's own text never reaches the screen. */
export function parseErrorMessage(code: string): string {
  switch (code) {
    case 'invalid_output': return parseTexts.failed
    case 'timeout': return parseTexts.timeout
    case 'worker_lost': return parseTexts.lost
    case 'expired': return parseTexts.unavailable
    case 'auth_required': return parseTexts.auth
    default: return parseTexts.failed
  }
}

/** A refused POST or GET in words of the hint. */
export function requestFailureMessage(failure: Failure): string {
  if (failure.reason === 'parse_limit') return parseTexts.limit
  if (failure.reason === 'invalid_parameter') return parseTexts.text
  if (failure.reason === 'csrf_failed') return 'Сессия обновилась. Повторите действие ещё раз.'
  return errorMessage(failure)
}

export const isActive = (parse: ManualParse) => parse.status === 'queued' || parse.status === 'running'

/**
 * What the hint shows for the request as read: still waiting — «Разбираю…»; waiting with no worker at all, or
 * longer than `PARSE_WAIT_MS` — the form is for manual input; `succeeded` — filled; `failed` — the message of its code.
 */
export function parseOutcome(parse: ManualParse, elapsedMs = 0): ParseView {
  if (parse.status === 'succeeded') return { kind: 'filled' }
  if (parse.status === 'failed') return { kind: 'failed', message: parseErrorMessage(parse.error?.code ?? '') }
  if (parse.status === 'queued' && parse.executor.state === 'absent') return { kind: 'failed', message: parseTexts.unavailable }
  if (elapsedMs >= PARSE_WAIT_MS) return { kind: 'failed', message: parseTexts.slow }
  return { kind: 'working' }
}

/** «4500.00» -> «4500», a dot stays: the form takes both. */
const money = (value: string) => amountText(value.includes('.') ? value.padEnd(value.indexOf('.') + 3, '0') : value)

/**
 * The form after a parse: every field is replaced by the draft (the person asked to fill the form by the text),
 * empty values included. A category the form does not offer as a chip is left unchosen.
 */
export function draftFromParse(parsed: ManualParseDraft, chips: Category[]): ExpenseDraft {
  const offered = new Set(chips.map((chip) => chip.id))
  const known = (id: number | null) => id !== null && offered.has(id) ? id : null
  return {
    amount: parsed.lines.length || parsed.total === null ? '' : money(parsed.total),
    currency: parsed.currency,
    category: known(parsed.category),
    date: parsed.purchased_on,
    place: parsed.store_name ?? '',
    note: parsed.note,
    lines: parsed.lines.map((line) => ({ ...newLine(), name: line.name, amount: money(line.amount), category: known(line.category) })),
  }
}
