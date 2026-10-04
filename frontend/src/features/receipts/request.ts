import type { LocalApiResult } from '../../api/types'

export type ReceiptRequestState<T> = { kind: 'loading' } | Exclude<LocalApiResult<T>, { kind: 'aborted' }>

/** One lifetime per loader; cancellation and generations also protect against late responses. */
export function createReceiptRequest<T>(load: (signal: AbortSignal) => Promise<LocalApiResult<T>>) {
  let state: ReceiptRequestState<T> = { kind: 'loading' }
  let generation = 0
  let controller: AbortController | undefined
  const listeners = new Set<() => void>()
  const publish = (next: ReceiptRequestState<T>) => {
    state = next
    listeners.forEach((listener) => listener())
  }
  const stop = () => {
    generation++
    controller?.abort()
    controller = undefined
  }
  const start = () => {
    stop()
    const currentGeneration = generation
    const current = new AbortController()
    controller = current
    publish({ kind: 'loading' })
    void (async () => {
      let result: LocalApiResult<T>
      try { result = await load(current.signal) }
      catch { result = { kind: 'error', reason: 'network' } }
      if (generation !== currentGeneration || current.signal.aborted || result.kind === 'aborted') return
      publish(result)
    })()
  }
  return {
    start, stop, getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }
}
