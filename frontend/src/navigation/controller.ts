import { buildRoute, parseRoute } from './routes'
import type { NavigableRoute, Route } from './routes'

/** Small History API port; unit tests provide an in-memory implementation. */
export interface NavigationEnvironment {
  getHref(): string
  getState(): unknown
  pushState(state: unknown, href: string): void
  replaceState(state: unknown, href: string): void
  listenPopState(listener: () => void): () => void
}

export interface NavigationSnapshot {
  href: string
  route: Route
  /** Known list context; absent for direct entry to a detail. */
  returnTo?: string
}

export interface NavigateOptions {
  replace?: boolean
}

export type NavigationTarget = string | NavigableRoute

function listContext(value: unknown, origin: string, detail: Route): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value, origin)
    if (url.origin !== origin) return undefined
    const route = parseRoute(url)
    const compatible = detail.kind === 'product' ? route.kind === 'catalog' || route.kind === 'category'
      : detail.kind === 'receipt' ? route.kind === 'receipts' : detail.kind === 'job' && route.kind === 'jobs'
    return compatible && route.kind !== 'not-found' && route.kind !== 'invalid-query' ? buildRoute(route) : undefined
  } catch {
    return undefined
  }
}

export function createNavigation(environment: NavigationEnvironment) {
  const listeners = new Set<() => void>()
  let unlisten: (() => void) | undefined

  const read = (): NavigationSnapshot => {
    const url = new URL(environment.getHref())
    const state = environment.getState()
    const route = parseRoute(url)
    const returnTo = state !== null && typeof state === 'object' && 'checkistReturnTo' in state
      ? listContext(state.checkistReturnTo, url.origin, route) : undefined
    return { href: `${url.pathname}${url.search}${url.hash}`, route, ...(returnTo && { returnTo }) }
  }
  let snapshot = read()
  const refresh = () => {
    const next = read()
    if (next.href === snapshot.href && next.returnTo === snapshot.returnTo) return
    snapshot = next
    listeners.forEach((listener) => listener())
  }

  return {
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) {
      // Refresh after an unsubscribed interval (including StrictMode's cleanup).
      if (listeners.size === 0) {
        unlisten = environment.listenPopState(refresh)
        refresh()
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) {
          unlisten?.()
          unlisten = undefined
        }
      }
    },
    navigate(target: NavigationTarget, options: NavigateOptions = {}) {
      const current = new URL(environment.getHref())
      const url = new URL(typeof target === 'string' ? target : buildRoute(target), current)
      if (url.origin !== current.origin || !['http:', 'https:'].includes(url.protocol)) {
        throw new TypeError('Navigation must stay on this origin')
      }
      const href = `${url.pathname}${url.search}${url.hash}`
      if (href === snapshot.href) return
      const route = parseRoute(url)
      const returnTo = listContext(current.href, current.origin, route)
        ?? listContext(snapshot.returnTo, current.origin, route)
      const state = returnTo ? { checkistReturnTo: returnTo } : null
      if (options.replace) environment.replaceState(state, href)
      else environment.pushState(state, href)
      // pushState/replaceState do not fire popstate.
      refresh()
    },
  }
}
