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
  /** Known catalog context; absent for a direct entry to a product. */
  returnTo?: string
}

export interface NavigateOptions {
  replace?: boolean
}

export type NavigationTarget = string | NavigableRoute

function catalogContext(value: unknown, origin: string): string | undefined {
  if (typeof value !== 'string') return undefined
  try {
    const url = new URL(value, origin)
    if (url.origin !== origin) return undefined
    const route = parseRoute(url)
    return route.kind === 'catalog' || route.kind === 'category' ? buildRoute(route) : undefined
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
    const returnTo = state !== null && typeof state === 'object' && 'checkistReturnTo' in state
      ? catalogContext(state.checkistReturnTo, url.origin) : undefined
    return { href: `${url.pathname}${url.search}${url.hash}`, route: parseRoute(url), ...(returnTo && { returnTo }) }
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
      const previousRoute = parseRoute(current)
      const returnTo = route.kind === 'product'
        ? previousRoute.kind === 'catalog' || previousRoute.kind === 'category'
          ? buildRoute(previousRoute) : catalogContext(snapshot.returnTo, current.origin)
        : undefined
      const state = returnTo ? { checkistReturnTo: returnTo } : null
      if (options.replace) environment.replaceState(state, href)
      else environment.pushState(state, href)
      // pushState/replaceState do not fire popstate.
      refresh()
    },
  }
}
