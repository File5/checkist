/** ИИ у семьи (`accounts.ai` на сервере): the words of its two refusals, one place for every screen that asks the model —
 * «Трата словами» (features/expense) and the photo upload (features/recognition). No network, no React. */
import type { LocalApiFailure } from '../api/types'
import { glue, NBSP } from './text'

export const aiTexts = {
  disabled: 'ИИ выключен в вашей семье — включить может главный.',
  quota: 'На сегодня запросы к ИИ закончились.',
} as const

const startOfDay = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()

/** «Снова можно завтра в 05:00»: the moment the quota starts again, in the time of the device; '' without one. */
export function aiResetText(resetsAt: string | undefined, now: Date = new Date()): string {
  const moment = resetsAt === undefined ? Number.NaN : Date.parse(resetsAt)
  if (Number.isNaN(moment)) return ''
  const at = new Date(moment)
  const time = glue('в', at.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }))
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000)
  const day = days <= 0 ? 'сегодня' : days === 1 ? 'завтра' : at.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long' }).replace(/ /g, NBSP)
  return `Снова можно ${day} ${time}.`
}

/** The text of `403 ai_disabled` / `429 ai_quota`; `undefined` for any other failure. */
export function aiRefusalText(failure: Pick<LocalApiFailure, 'reason' | 'resetsAt'>, now: Date = new Date()): string | undefined {
  if (failure.reason === 'ai_disabled') return aiTexts.disabled
  if (failure.reason === 'ai_quota') return [aiTexts.quota, aiResetText(failure.resetsAt, now)].filter(Boolean).join(' ')
  return undefined
}
