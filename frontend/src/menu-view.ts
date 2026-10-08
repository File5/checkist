import { useLayoutEffect, useRef } from 'react'
import type { RefObject } from 'react'
import { pageKey } from './features/auth/auth-state'
import type { ShellView } from './features/auth/auth-state'
import type { Route } from './navigation'
import type { Session } from './session'

/** What the header menu consists of and which item is the current one.
 * The address alone does not tell it: while «Я» is being read the menu has one item, and the sign-in
 * has no menu at all — the sections appear later, on the very same address.
 */
export function menuKey(view: ShellView, session: Session, route: Route): string {
  if (view === 'login') return 'no-menu'
  const name = session.kind === 'user' ? session.user.username : ''
  return `${pageKey(session)}:${name}:${route.kind}`
}

export type MenuMetrics = {
  /** The left edge of the current item, counted from the start of the row. */
  itemStart: number
  itemWidth: number
  /** The visible width of the menu and the width of its whole row. */
  viewWidth: number
  rowWidth: number
}

/** Where to scroll the row so that the current item stands in the middle; nothing when the row fits. */
export function menuScrollLeft({ itemStart, itemWidth, viewWidth, rowWidth }: MenuMetrics): number | undefined {
  if (rowWidth <= viewWidth) return undefined
  return Math.max(0, Math.min(rowWidth - viewWidth, itemStart - (viewWidth - itemWidth) / 2))
}

/** On a narrow window the menu is one row scrolled sideways: keep the current item in view.
 * Returns the ref for the menu. Runs again whenever `key` changes, so pass everything the items of the menu depend on.
 */
export function useCurrentItemInView(key: string): RefObject<HTMLElement | null> {
  const menu = useRef<HTMLElement>(null)
  useLayoutEffect(() => {
    const row = menu.current
    const current = row?.querySelector<HTMLElement>('[aria-current]')
    if (!row || !current) return
    const left = menuScrollLeft({
      itemStart: current.getBoundingClientRect().left - row.getBoundingClientRect().left + row.scrollLeft,
      itemWidth: current.offsetWidth, viewWidth: row.clientWidth, rowWidth: row.scrollWidth,
    })
    if (left !== undefined) row.scrollLeft = left
  }, [key])
  return menu
}
