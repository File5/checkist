import { useSyncExternalStore } from 'react'
import { getSession, subscribeSession } from './store.ts'
import type { Session } from './store.ts'

export { applyMe, canModerate, getSession, loadSession, permissionDeniedText, subscribeSession } from './store.ts'
export type { Session } from './store.ts'

/** The current session; the component is rendered again when it changes. */
export function useSession(): Session {
  return useSyncExternalStore(subscribeSession, getSession, getSession)
}
