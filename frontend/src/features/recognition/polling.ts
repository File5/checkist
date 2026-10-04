import type { LocalApiFailure, LocalApiResult } from '../../api/types'

export type RequestState<T> =
  | { kind: 'loading' }
  | { kind: 'error'; error: LocalApiFailure }
  | { kind: 'ok'; data: T; refreshError?: LocalApiFailure; refreshing: boolean }

export interface PollEnvironment {
  hidden: () => boolean
  listen: (callback: () => void) => () => void
  later: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>
  clear: (timer: ReturnType<typeof setTimeout>) => void
}
const environment: PollEnvironment = {
  hidden: () => typeof document !== 'undefined' && document.hidden,
  listen: (callback) => {
    if (typeof document === 'undefined') return () => {}
    document.addEventListener('visibilitychange', callback)
    return () => document.removeEventListener('visibilitychange', callback)
  },
  later: (callback, delay) => setTimeout(callback, delay),
  clear: (timer) => clearTimeout(timer),
}

/** One lifetime per route/query. A mutation pauses reads before touching the server. */
export function createPollingRequest<T>(
  load: (signal: AbortSignal) => Promise<LocalApiResult<T>>,
  active: (data: T) => boolean = () => false,
  accept: (previous: T, next: T) => boolean = () => true,
  env: PollEnvironment = environment,
) {
  const initial: RequestState<T> = { kind: 'loading' }
  let state: RequestState<T> = initial
  let snapshot: T | undefined
  let controller: AbortController | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  let unlisten: (() => void) | undefined
  let generation = 0
  let failures = 0
  let running = false
  let paused = false
  let queuedRefresh = false
  const listeners = new Set<() => void>()
  const publish = (next: RequestState<T>) => { state = next; listeners.forEach((listener) => listener()) }
  const clearTimer = () => { if (timer !== undefined) env.clear(timer); timer = undefined }
  const schedule = () => {
    clearTimer()
    if (!running || paused || (snapshot !== undefined && !active(snapshot))) return
    // An initial failure is retried only explicitly; stale active snapshots keep polling.
    if (snapshot === undefined) return
    const delay = failures ? [2000, 4000, 8000, 15000][Math.min(failures - 1, 3)] : 2000
    timer = env.later(refresh, env.hidden() ? Math.max(10000, delay) : delay)
  }
  const refresh = () => {
    if (!running || paused || controller) return
    clearTimer()
    const current = new AbortController()
    controller = current
    const stamp = ++generation
    if (snapshot !== undefined) publish({ kind: 'ok', data: snapshot, refreshing: true, ...(state.kind === 'ok' && { refreshError: state.refreshError }) })
    else publish({ kind: 'loading' })
    void (async () => {
      let result: LocalApiResult<T>
      try { result = await load(current.signal) }
      catch { result = { kind: 'error', reason: 'network' } }
      if (stamp !== generation || current.signal.aborted || !running) return
      controller = undefined
      if (result.kind === 'ok') {
        failures = 0
        if (snapshot === undefined || accept(snapshot, result.data)) snapshot = result.data
        publish({ kind: 'ok', data: snapshot!, refreshing: false })
      } else if (result.kind === 'error') {
        failures++
        publish(snapshot === undefined ? { kind: 'error', error: result } : { kind: 'ok', data: snapshot, refreshing: false, refreshError: result })
      } else if (snapshot !== undefined) publish({ kind: 'ok', data: snapshot, refreshing: false })
      if (queuedRefresh) { queuedRefresh = false; refresh(); return }
      schedule()
    })()
  }
  const pause = () => {
    paused = true
    queuedRefresh = false
    clearTimer()
    generation++
    controller?.abort()
    controller = undefined
    if (state.kind === 'ok') publish({ ...state, refreshing: false })
  }
  return {
    getSnapshot: () => state,
    getServerSnapshot: () => initial,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
    start: () => {
      running = true
      paused = false
      unlisten?.()
      unlisten = env.listen(() => {
        if (snapshot === undefined || !active(snapshot)) return
        if (env.hidden()) schedule(); else refresh()
      })
      refresh()
    },
    refresh, pause,
    resume: (immediate = true) => { paused = false; if (immediate) refresh(); else schedule() },
    queueRefresh: () => { if (controller) queuedRefresh = true; else refresh() },
    setData: (data: T) => {
      if (!running || (snapshot !== undefined && !accept(snapshot, data))) return
      snapshot = data
      failures = 0
      publish({ kind: 'ok', data, refreshing: false })
    },
    dispose: () => { running = false; pause(); unlisten?.(); unlisten = undefined },
  }
}
