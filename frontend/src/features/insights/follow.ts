/** Follow one request of the model until it settles: poll it like «Трата словами», bounded by `WAIT_MS`. */
import type { Ask, Review } from '../../api/insights'
import type { LocalApiResult } from '../../api/types'
import { createPollingRequest } from '../recognition/polling'
import { insightTexts, isActive, outcome, requestFailureMessage, WAIT_MS } from './insights-state'

/** `done` gets the settled row, `fail` the words of a failure; the result stops following (on leaving the screen). */
export function follow<T extends Review | Ask>(
  first: T, load: (id: number, signal: AbortSignal) => Promise<LocalApiResult<T>>,
  done: (row: T) => void, fail: (message: string) => void,
): () => void {
  const started = Date.now()
  let stop = () => {}
  const settle = (row: T) => {
    const next = outcome(row, Date.now() - started)
    if (next.kind === 'working') return false
    stop()
    if (next.kind === 'done') done(row)
    else fail(next.message)
    return true
  }
  if (settle(first)) return stop
  const request = createPollingRequest((signal) => load(first.id, signal), isActive)
  const unsubscribe = request.subscribe(() => {
    const state = request.getSnapshot()
    if (state.kind === 'ok') settle(state.data)
    else if (state.kind === 'error') { stop(); fail(requestFailureMessage(state.error)) }
  })
  // The worker may stay busy with a photo: the wait is bounded on the client too.
  const deadline = setTimeout(() => { stop(); fail(insightTexts.slow) }, WAIT_MS)
  stop = () => { clearTimeout(deadline); unsubscribe(); request.dispose(); stop = () => {} }
  request.start()
  return () => stop()
}
