/** Requests of the API on their way (feature/split-skeletons, 2026-10-13): the thin bar at the top of the window
 * (components/NetworkBar.tsx) and the warm-up of the screens (screens.ts) read it.
 *
 * `sendJson` of api/http.ts calls `begin()` before its fetch and `end()` when it settles; a `keepalive` request (a
 * delete sent while the page closes) is not counted: nobody waits for it on the screen. Plain module state, no React:
 * a listener hears the new count after every change.
 */
type Listener = (count: number) => void

let count = 0
const listeners = new Set<Listener>()

function emit() {
  for (const listener of [...listeners]) listener(count)
}

export function begin(): void {
  count += 1
  emit()
}

/** Never below zero: an `end()` without its `begin()` changes nothing. */
export function end(): void {
  if (count === 0) return
  count -= 1
  emit()
}

export function inFlightCount(): number {
  return count
}

/** The listener hears every change of the count; the returned function stops it. */
export function subscribe(listener: Listener): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}
