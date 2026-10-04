import { useSyncExternalStore } from 'react'
import { createNavigation } from './controller'
import type { NavigationTarget, NavigateOptions } from './controller'

let navigation: ReturnType<typeof createNavigation> | undefined

function browserNavigation() {
  // Importing navigation helpers in Node does not require a browser.
  navigation ??= createNavigation({
    getHref: () => window.location.href,
    getState: () => window.history.state,
    pushState: (state, href) => window.history.pushState(state, '', href),
    replaceState: (state, href) => window.history.replaceState(state, '', href),
    listenPopState: (listener) => {
      window.addEventListener('popstate', listener)
      return () => window.removeEventListener('popstate', listener)
    },
  })
  return navigation
}

export function navigate(target: NavigationTarget, options?: NavigateOptions) {
  browserNavigation().navigate(target, options)
}

/** Stable snapshot of route/query and optional return context; also updates on popstate. */
export function useNavigation() {
  const store = browserNavigation()
  return useSyncExternalStore(store.subscribe, store.getSnapshot)
}

export function useRoute() {
  return useNavigation().route
}
