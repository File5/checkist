/**
 * The warm-up of the bar screens («мгновенные экраны», 2026-10-13). Once the first screen is drawn and the person is
 * known, on the first idle moment, the first reads of «Главная» (the current month), «Траты» and «Статистика» — those
 * the person is not on — go to the memory of answers (`api/answer-cache.ts`): a tap on the bar then shows the screen at
 * once. The reads are the very calls of the screens with the very parameters, so their keys match
 * (`warm-up.test.tsx` renders the screens and compares). A handful of requests, once per session; nothing when the
 * device is offline or saves data.
 */
import { useEffect, useRef } from 'react'
import { getDashboard } from '../api/budget'
import { getCountries } from '../api/countries'
import { getIncomeSummary } from '../api/incomes'
import { getReceipts } from '../api/receipts'
import { getRecurringMonth } from '../api/recurring'
import { getSpending } from '../api/stats'
import { getStores } from '../api/stores'
import { pageKey } from '../features/auth/auth-state'
import { receiptParams } from '../features/receipts/state'
import { requestKey, spendingParams } from '../features/stats/spending-state'
import { buildRoute, parseRoute, parseSpendingQuery } from '../navigation'
import type { Route } from '../navigation'
import type { Session } from '../session'
import { menuItems } from './menu-items'

/** Without `requestIdleCallback` (Safari) the warm-up waits this long after the first screen. */
export const WARM_UP_FALLBACK_MS = 1500
/** The longest an idle moment is waited for. */
const WARM_UP_TIMEOUT_MS = 5000

type Read = (signal: AbortSignal) => Promise<unknown>

/** The first reads of a screen of the bar, as its screen makes them; other screens are not warmed. */
export function firstReads(route: Route): Read[] {
  switch (route.kind) {
    case 'dashboard':
      // «Главная» draws the income line and the payments of the month its answer names.
      return [async (signal) => {
        const result = await getDashboard(route.month, { signal })
        if (result.kind !== 'ok') return
        const month = result.data.month
        await Promise.all([getIncomeSummary(month, { signal }), getRecurringMonth(month, { signal })])
      }]
    case 'receipts': {
      const { page, store, product, country, currency, operation, date_from, date_to, q, owner, hidden, page_size, ordering } = route.query
      return [(signal) => getReceipts(receiptParams({
        page, store, product, country, currency, operation, date_from, date_to, q, owner, hidden, page_size, ordering,
      }), { signal })]
    }
    case 'spending': {
      // The screen asks without `other` (the composition of «Прочее» is a second request, only when it is open).
      const requested = parseSpendingQuery(requestKey(route.query)).query
      return [
        (signal) => getSpending(spendingParams(requested), { signal }),
        (signal) => getCountries({}, { signal }),
        (signal) => getStores({ page_size: 200 }, { signal }),
      ]
    }
    default:
      return []
  }
}

/** The addresses of the bar the person may go to next: every one but the screen on view. */
export function warmUpTargets(session: Session, route: Route): Route[] {
  const shown = route.kind === 'not-found' || route.kind === 'invalid-query' ? undefined : buildRoute(route)
  return menuItems(session, route).primary
    .filter((item) => item.to !== shown)
    .map((item) => parseRoute(item.to))
}

/** Every first read of the bar screens the person is not on; failures are left to the screens themselves. The answers
 * of another person never stay: a sign-in, a sign-out or another «Я» forgets the memory, and a read started before is
 * not kept after it. */
export async function warmUp(session: Session, route: Route, signal = new AbortController().signal): Promise<void> {
  if (session.kind !== 'user') return
  const reads = warmUpTargets(session, route).flatMap(firstReads)
  await Promise.all(reads.map((read) => read(signal).catch(() => undefined)))
}

type IdleWindow = { requestIdleCallback?: (callback: () => void, options?: { timeout: number }) => number; cancelIdleCallback?: (id: number) => void }

/** Runs `callback` on the first idle moment of the browser; returns the cancel. */
export function whenIdle(callback: () => void): () => void {
  const idle = window as unknown as IdleWindow
  if (typeof idle.requestIdleCallback === 'function') {
    const id = idle.requestIdleCallback(callback, { timeout: WARM_UP_TIMEOUT_MS })
    return () => idle.cancelIdleCallback?.(id)
  }
  const timer = setTimeout(callback, WARM_UP_FALLBACK_MS)
  return () => clearTimeout(timer)
}

/** A device without network, or one asking to save data, is not loaded with reads the person did not ask for. */
function quiet(): boolean {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection
  return navigator.onLine === false || connection?.saveData === true
}

/** The shell: once per person, after the first screen, on the first idle moment, with the address on view then. */
export function useWarmUp(session: Session, route: Route): void {
  const warmed = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (session.kind !== 'user') return
    const key = pageKey(session)
    if (warmed.current === key) return
    // A newer address before the idle moment starts the wait again with it.
    return whenIdle(() => {
      warmed.current = key
      if (!quiet()) void warmUp(session, route)
    })
  }, [session, route])
}
