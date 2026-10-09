import { useSyncExternalStore } from 'react'

/** The only phone threshold of the project: the same number stands in every `@media (max-width: 540px)`. */
export const PHONE_MAX_WIDTH = 540
export const narrowQuery = `(max-width: ${PHONE_MAX_WIDTH}px)`

export type NarrowEnvironment = {
  /** Whether the window is a phone now. */
  matches: () => boolean
  /** Reports that the answer may have changed (rotation, zoom, resized window). */
  listen: (listener: () => void) => () => void
}

export type NarrowStore = ReturnType<typeof createNarrowStore>

/** Every environment call is guarded: a missing or failing matchMedia means the wide view, never a broken page. */
export function createNarrowStore(environment: NarrowEnvironment) {
  return {
    getSnapshot(): boolean {
      try {
        return environment.matches() === true
      } catch {
        return false
      }
    },
    getServerSnapshot: (): boolean => false,
    subscribe(listener: () => void) {
      try {
        const stop = environment.listen(listener)
        return () => {
          try {
            stop()
          } catch {
            // Nothing to release.
          }
        }
      } catch {
        return () => {}
      }
    },
  }
}

let store: NarrowStore | undefined

function browserNarrow() {
  if (store) return store
  // Nothing here touches the browser until React reads or subscribes: components are also rendered in Node.
  let list: MediaQueryList | undefined
  const query = () => (list ??= window.matchMedia(narrowQuery))
  store = createNarrowStore({
    matches: () => query().matches,
    listen: (listener) => {
      const current = query()
      current.addEventListener('change', listener)
      return () => current.removeEventListener('change', listener)
    },
  })
  return store
}

/** True on a phone (window up to 540 px wide). A server render (renderToStaticMarkup) always sees the wide view. */
export function useNarrow(): boolean {
  const current = browserNarrow()
  return useSyncExternalStore(current.subscribe, current.getSnapshot, current.getServerSnapshot)
}
