/** «Разбор месяца» and «Вопрос о тратах»: the words of the screens and what a request shows. No network, no React. */
import type { Ask, InsightStatus, Review, ReviewFigures } from '../../api/insights'
import type { Decimal, LocalApiFailure } from '../../api/types'
import { aiRefusalText } from '../../lib/ai'
import { formatMoney } from '../../lib/money'
import { NBSP } from '../../lib/text'
import { cents, dashboardErrorMessage, deviceMonth, shiftMonth } from '../dashboard/dashboard-state'

export const QUESTION_MAX = 300
/** The client stops waiting after this: a long recognition job may hold the worker. */
export const WAIT_MS = 180_000

export const insightTexts = {
  working: 'Думаю над разбором — обычно меньше минуты…',
  refreshing: 'Обновляю разбор…',
  thinking: 'Думаю…',
  empty: 'В этом месяце трат нет — разбирать нечего.',
  unavailable: 'Исполнитель ИИ не запущен — разбор появится, когда он заработает.',
  slow: 'Ответ затянулся. Попробуйте позже.',
  failed: 'Не удалось составить ответ. Попробуйте ещё раз.',
  timeout: 'Ответ не уложился в срок. Попробуйте ещё раз.',
  lost: 'Исполнитель остановился во время ответа. Попробуйте ещё раз.',
  expired: 'Ответ не дождался исполнителя. Попробуйте позже.',
  auth: 'ИИ сейчас недоступен: исполнителю нужен вход в Codex.',
  limit: 'Слишком много вопросов подряд. Дождитесь ответа и спросите снова.',
  question: `Напишите вопрос о тратах — не длиннее ${QUESTION_MAX} символов.`,
  unverified: 'Этих чисел нет в цифрах месяца — сверяйтесь с цифрами сервера:',
} as const

/** The message of a failed request by its code; the server's own text never reaches the screen. */
export function insightErrorMessage(code: string): string {
  switch (code) {
    case 'invalid_output': return insightTexts.failed
    case 'timeout': return insightTexts.timeout
    case 'worker_lost': return insightTexts.lost
    case 'expired': return insightTexts.expired
    case 'auth_required': return insightTexts.auth
    default: return insightTexts.failed
  }
}

/** A refused POST or GET in words of the screen: the family's AI refusals first (`lib/ai.ts`). */
export function requestFailureMessage(failure: Pick<LocalApiFailure, 'reason' | 'resetsAt'>, now?: Date): string {
  const ai = aiRefusalText(failure, now)
  if (ai) return ai
  if (failure.reason === 'parse_limit') return insightTexts.limit
  if (failure.reason === 'invalid_parameter') return insightTexts.question
  if (failure.reason === 'csrf_failed') return 'Сессия обновилась. Повторите действие ещё раз.'
  return dashboardErrorMessage(failure)
}

export const isActive = (row: { status: InsightStatus }) => row.status === 'queued' || row.status === 'running'

export type Outcome = { kind: 'working' } | { kind: 'done' } | { kind: 'failed'; message: string }

/** What a request shows as read: waiting; waiting with no worker at all or longer than `WAIT_MS` — a message;
 * `succeeded` — done; `failed` — the message of its code. */
export function outcome(row: Review | Ask, elapsedMs = 0): Outcome {
  if (row.status === 'succeeded') return { kind: 'done' }
  if (row.status === 'failed') return { kind: 'failed', message: insightErrorMessage(row.error?.code ?? '') }
  if (row.status === 'queued' && row.executor.state === 'absent') return { kind: 'failed', message: insightTexts.unavailable }
  if (elapsedMs >= WAIT_MS) return { kind: 'failed', message: insightTexts.slow }
  return { kind: 'working' }
}

/** The month a review opens by default: the one before the month of the device. */
export function defaultReviewMonth(now: Date = new Date()): string {
  return shiftMonth(deviceMonth(now), -1)
}

/** The model's words as plain text: a number keeps its groups and its currency sign on one line («45 301 ₸»). */
export function modelText(text: string): string {
  return text.replace(/(\d) (?=\d{3}(?!\d))/g, `$1${NBSP}`).replace(/(\d) (?=[₸$€₽£¥₺%]|[A-Z]{3}\b)/g, `$1${NBSP}`)
}

export type Delta = { tone: 'more' | 'less' | 'same'; text: string }

/** «▲ 73 893 ₸» / «▼ 5 714 ₸» / «=»: a change of the money of the month, rounded up like every amount. */
export function delta(change: Decimal | null, currency: string): Delta | null {
  if (change === null) return null
  const value = cents(change)
  if (value === 0n) return { tone: 'same', text: '=' }
  const magnitude = formatMoney(change.replace(/^-/, ''), currency)
  return value > 0n ? { tone: 'more', text: `▲${NBSP}${magnitude}` } : { tone: 'less', text: `▼${NBSP}${magnitude}` }
}

/** The month has nothing to review: no spends and no category. */
export function monthIsEmpty(figures: ReviewFigures): boolean {
  return cents(figures.spent) === 0n && figures.categories.length === 0
}
