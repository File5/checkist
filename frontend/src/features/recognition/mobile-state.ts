import { useState } from 'react'
import type { JobsQuery } from '../../navigation'
import { problemsAt, rowField } from './review-state'
import type { ReviewLine, ReviewState } from './review-state'

/** Pure rules of the phone view of recognition (docs/frontend.md, «Мобильный дизайн: распознавание и каталог»). */

/** A disclosure that a reason opens: it opens with the reason and stays open after the reason is gone, so a field
 * that the person is fixing never folds away under the finger. Closed again only by the person. */
export function stickyOpen(open: boolean, forced: boolean): boolean {
  return open || forced
}

/** State of such a disclosure: `open` for `<details open>`, `toggle` for its onToggle. */
export function useStickyOpen(forced: boolean) {
  const [open, setOpen] = useState(forced)
  const next = stickyOpen(open, forced)
  if (next !== open) setOpen(next)
  return { open: next, toggle: (value: boolean) => setOpen(value) }
}

/** Label of the button that folds the pinned crop of a phone. */
export const cropToggleLabel = (shown: boolean) => shown ? 'Скрыть фото' : 'Показать фото'

/** Active filters of the jobs list: the number on «Фильтры (N)». */
export function jobsFilterCount(query: Pick<JobsQuery, 'status' | 'photo' | 'needs_review'>): number {
  return [query.status, query.photo, query.needs_review].filter((value) => value !== undefined).length
}

/** Fields of a line folded under «Подробнее» on a phone: everything but the name, the type and the amount. */
export const lineDetailFields = ['parent_position', 'quantity', 'unit', 'unit_price', 'tax_rate', 'tax_rate.kind', 'tax_rate.rate', 'tax_code'] as const

/** «Подробнее» of a line opens by itself while a field inside it has a problem. */
export function lineDetailsForced(state: ReviewState, key: number): boolean {
  const id = rowField('lines', key)
  return problemsAt(state, ...lineDetailFields.map((field) => `${id}.${field}`)).length > 0
}

/** DOM id of the card of one line: the target of the links of the summary. */
export const lineCardId = (imageId: number, key: number) => `review-${imageId}-line-${key}`

export type LineIssue = { key: number; index: number; title: string; problems: string[] }

/** Lines of the form that have a problem now (their own or of any of their fields), in the order of the form. */
export function lineIssues(state: ReviewState): LineIssue[] {
  return state.lines.flatMap((line: ReviewLine, index) => {
    const prefix = rowField('lines', line.key)
    const problems = Object.entries(state.problems)
      .filter(([id]) => id === prefix || id.startsWith(`${prefix}.`))
      .flatMap(([, texts]) => texts)
    return problems.length === 0 ? [] : [{ key: line.key, index, title: `Строка ${index + 1}${line.name.trim() ? `: ${line.name.trim()}` : ''}`, problems: [...new Set(problems)] }]
  })
}

/** The amount of a line card as written, or a dash; never parsed into a JS number. */
export function lineAmountText(line: Pick<ReviewLine, 'amount'>): string {
  return line.amount.trim() || '—'
}
