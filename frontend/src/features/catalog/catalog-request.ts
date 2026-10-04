import type { ApiResult } from '../../api/types'

export type CatalogRequestState<T> = { kind: 'loading' } | Exclude<ApiResult<T>, { kind: 'aborted' }>

/** A request lifetime belongs to one URL. start() also implements explicit retry. */
export function createCatalogRequest<T>(load: (signal: AbortSignal) => Promise<ApiResult<T>>) {
  let state: CatalogRequestState<T> = { kind: 'loading' }
  let generation = 0
  let controller: AbortController | undefined
  const listeners = new Set<() => void>()
  const publish = (next: CatalogRequestState<T>) => {
    state = next
    listeners.forEach((listener) => listener())
  }
  const stop = () => {
    generation += 1
    controller?.abort()
    controller = undefined
  }
  const start = () => {
    stop()
    const currentGeneration = generation
    const current = new AbortController()
    controller = current
    publish({ kind: 'loading' })
    const run = async () => {
      let result: ApiResult<T>
      try { result = await load(current.signal) }
      catch { result = { kind: 'error', reason: 'network' } }
      if (generation !== currentGeneration || current.signal.aborted || result.kind === 'aborted') return
      publish(result)
    }
    void run()
  }
  return {
    getSnapshot: () => state,
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
    start, stop,
  }
}
