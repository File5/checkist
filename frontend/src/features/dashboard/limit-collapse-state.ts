import type { DashboardCategory, DashboardSubCategory } from '../../api/budget-types'
import { cents, formatNumber } from './dashboard-state'

/**
 * Sub-categories of a «Лимиты» row on «Главная» are folded by default: only top-level rows show, each with its own
 * «6 подкатегорий» button. What a person opened or closed is kept per category id in this browser only.
 */
export const EXPANDED_STORAGE_KEY = 'checkist.dashboard.expanded'

/** A person's choices: category id → opened (`true`) or closed (`false`). Without a choice a row follows `isExpanded`. */
export type ExpandedChoices = Record<string, boolean>

type Row = DashboardCategory | DashboardSubCategory
type Store = Pick<Storage, 'getItem' | 'setItem'>

function browserStorage(): Store | undefined {
  try {
    return typeof window === 'undefined' ? undefined : window.localStorage
  } catch {
    return undefined
  }
}

/** The saved choices; empty when storage is missing, blocked or holds something else. */
export function readExpanded(storage: Store | undefined = browserStorage()): ExpandedChoices {
  try {
    const raw = storage?.getItem(EXPANDED_STORAGE_KEY)
    if (!raw) return {}
    const parsed: unknown = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {}
    return Object.fromEntries(Object.entries(parsed).filter(([key, value]) => /^\d+$/.test(key) && typeof value === 'boolean'))
  } catch {
    return {}
  }
}

/** Saves the choices; a full or blocked storage only loses the convenience. */
export function writeExpanded(choices: ExpandedChoices, storage: Store | undefined = browserStorage()): void {
  try {
    storage?.setItem(EXPANDED_STORAGE_KEY, JSON.stringify(choices))
  } catch {
    // Per-viewer convenience: the screen works the same without it.
  }
}

/** The choices after a person opened or closed one row. */
export function withChoice(choices: ExpandedChoices, categoryId: number, open: boolean): ExpandedChoices {
  return { ...choices, [String(categoryId)]: open }
}

export function rowChildren(row: Row): DashboardSubCategory[] {
  return row.children ?? []
}

function isOver(row: Row): boolean {
  return row.limit !== null && cents(row.limit) > 0n && cents(row.spent) > cents(row.limit)
}

/** Some sub-category below the row (any level) has spent more than its own limit. */
export function hasOverspendBelow(row: Row): boolean {
  return rowChildren(row).some((child) => isOver(child) || hasOverspendBelow(child))
}

/** Whether the sub-categories of a row are shown: the person's choice, otherwise only when one of them is overspent. */
export function isExpanded(row: Row, choices: ExpandedChoices): boolean {
  const choice = row.category_id === null ? undefined : choices[String(row.category_id)]
  return choice ?? hasOverspendBelow(row)
}

/** The longest hint that still fits one line of the folded row at 360 px (13 px text, about 7 px a character). */
export const HINT_MAX_CHARS = 34

/** «Аренда 220 000 / 220 000» for the folded row: the direct sub-categories with their own limit, when they fit one
 * line; `null` — only the count is shown. */
export function collapsedHint(row: Row, maxChars = HINT_MAX_CHARS): string | null {
  const parts = rowChildren(row).flatMap((child) => child.limit === null ? []
    : [`${child.name} ${formatNumber(child.spent)} / ${formatNumber(child.limit)}`])
  if (!parts.length) return null
  const hint = parts.join(' · ')
  return [...hint].length <= maxChars ? hint : null
}

/** The id of the folded list of a row, unique across the currency cards. */
export function subListId(currency: string, categoryId: number): string {
  return `dash-sub-${currency}-${categoryId}`
}
