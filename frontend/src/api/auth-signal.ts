/** What the transport tells the shell about the session. No React and no imports: `http.ts` depends on it.
 * `unauthenticated` — `401 not_authenticated` in the middle of a session; `forbidden` — `403 permission_denied`.
 */
export type AuthSignal = 'unauthenticated' | 'forbidden'
type Listener = (signal: AuthSignal) => void

const listeners = new Set<Listener>()

export function onAuthSignal(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** A failing listener never breaks the request that reported the signal, nor the other listeners. */
export function reportAuthSignal(signal: AuthSignal): void {
  for (const listener of [...listeners]) {
    try {
      listener(signal)
    } catch {
      // The request result does not depend on the shell.
    }
  }
}
