export type LocalRequestPhase = 'loading' | 'error' | 'ok'
type FocusTarget = 'result' | 'retry'

/** A retained input/control wins over restoration, even inside the same block. */
export function chooseLocalFocusTarget({ generation, currentGeneration, phase, retry, location, onResult, activeAvailable, retryAvailable }: {
  generation: number; currentGeneration: number; phase: LocalRequestPhase; retry: boolean
  location: 'block' | 'body' | 'elsewhere'; onResult: boolean; activeAvailable: boolean; retryAvailable: boolean
}): FocusTarget | undefined {
  if (generation !== currentGeneration || location === 'elsewhere') return
  if (location === 'block' && !onResult && activeAvailable) return
  return phase === 'error' && retry && retryAvailable ? 'retry' : 'result'
}

export interface LocalFocusEnvironment<T> {
  active: () => T
  inside: (element: T) => boolean
  body: (element: T) => boolean
  available: (element: T) => boolean
  isRetry: (element: T) => boolean
  result: () => T
  retry: () => T | undefined
  focus: (element: T) => void
}

/** Receives committed request snapshots only; the request owner guards late/aborted replies. */
export function createLocalRequestFocus<T>(environment: LocalFocusEnvironment<T>) {
  let previous: { kind: LocalRequestPhase } | undefined
  let lastLocal: T | undefined
  let generation = 0
  let pending: { generation: number; retry: boolean } | undefined

  const focusChanged = (element: T) => {
    if (environment.inside(element)) lastLocal = element
    else if (!environment.body(element)) {
      lastLocal = undefined
      pending = undefined
    }
  }
  const invalidate = () => { ++generation; pending = undefined; lastLocal = undefined }
  const update = (state: { kind: LocalRequestPhase }) => {
    const changed = previous !== undefined && previous !== state
    previous = state
    const active = environment.active()
    const location = environment.inside(active) ? 'block' : environment.body(active) ? 'body' : 'elsewhere'
    const lostLocal = lastLocal !== undefined && !environment.available(lastLocal)
    if (changed && state.kind === 'loading') {
      ++generation
      pending = lastLocal !== undefined && (location === 'block' || (location === 'body' && lostLocal))
        ? { generation, retry: environment.isRetry(lastLocal) } : undefined
    }
    // Also covers disappearing local actions which change only a filter draft.
    if (!pending && lostLocal && location !== 'elsewhere' && lastLocal !== undefined) {
      pending = { generation: ++generation, retry: environment.isRetry(lastLocal) }
    }
    if (!pending) return
    const result = environment.result()
    const retry = environment.retry()
    const target = chooseLocalFocusTarget({ ...pending, currentGeneration: generation, phase: state.kind,
      location, onResult: active === result, activeAvailable: environment.available(active),
      retryAvailable: retry !== undefined && environment.available(retry) })
    const element = target === 'retry' ? retry : target === 'result' ? result : undefined
    if (element !== undefined && element !== active) environment.focus(element)
    if (state.kind !== 'loading') pending = undefined
  }
  return { focusChanged, update, invalidate }
}
