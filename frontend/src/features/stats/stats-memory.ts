/**
 * What «Статистика» remembers on this device: the last tab and the last address of every tab, under one key of
 * `localStorage`. The state of a screen still lives in its address: the memory only says where the menu and the tabs
 * lead. A shown statistics address always wins over the memory, and without storage (a private window, blocked site
 * data) everything leads to the bare tabs, as before.
 */
import { buildRoute, parseRoute } from '../../navigation'
import type { NavigableRoute, Route } from '../../navigation'

export const statsTabs = [
  { kind: 'spending', path: '/stats', label: 'Траты' },
  { kind: 'receipts-stats', path: '/stats/receipts', label: 'Средний чек' },
  { kind: 'trends', path: '/stats/trends', label: 'Динамика' },
  { kind: 'stats-incomes', path: '/stats/incomes', label: 'Доходы' },
] as const
export type StatsTab = typeof statsTabs[number]['kind']
export type StatsRoute = Extract<NavigableRoute, { kind: StatsTab }>
export const STATS_MEMORY_KEY = 'checkist.stats'

type Memory = { tab?: unknown; hrefs?: unknown }
const isTab = (kind: unknown): kind is StatsTab => statsTabs.some((tab) => tab.kind === kind)
export const isStatsRoute = (route: Route | undefined): route is StatsRoute => isTab(route?.kind)

function read(): { tab?: StatsTab; hrefs: Record<string, unknown> } {
  try {
    const memory = JSON.parse(window.localStorage.getItem(STATS_MEMORY_KEY) ?? 'null') as Memory | null
    const hrefs = memory?.hrefs
    return { tab: isTab(memory?.tab) ? memory.tab : undefined, hrefs: hrefs !== null && typeof hrefs === 'object' ? hrefs as Record<string, unknown> : {} }
  } catch {
    return { hrefs: {} }
  }
}

/** Keeps the address of a statistics route as the last one of its tab; any other route changes nothing. */
export function rememberStats(route: Route) {
  if (!isStatsRoute(route)) return
  const memory = { tab: route.kind, hrefs: { ...read().hrefs, [route.kind]: buildRoute(route) } }
  try {
    window.localStorage.setItem(STATS_MEMORY_KEY, JSON.stringify(memory))
  } catch { /* No storage: the tabs lead to their bare addresses. */ }
}

/** Where a tab leads: the shown address for the shown tab, the remembered one for another, else its bare path. */
export function statsTabHref(tab: StatsTab, route?: Route): string {
  if (isStatsRoute(route) && route.kind === tab) return buildRoute(route)
  const stored = read().hrefs[tab]
  // A stored address is read like a typed one: another screen or a broken address leads to the bare tab.
  const parsed = typeof stored === 'string' && stored.startsWith('/stats') ? parseRoute(stored) : undefined
  return isStatsRoute(parsed) && parsed.kind === tab ? buildRoute(parsed) : statsTabs.find((item) => item.kind === tab)!.path
}

/** «Статистика» of the menu: the shown statistics address, otherwise the last tab as it was left. */
export function statsMenuHref(route: Route): string {
  return isStatsRoute(route) ? buildRoute(route) : statsTabHref(read().tab ?? 'spending')
}
