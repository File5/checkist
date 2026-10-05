import { useEffect, useMemo, useSyncExternalStore } from 'react'
import { cancelJob, getRecognitionCsrf, retryJob } from '../../api/recognition'
import { createJobActions } from './actions'

export function useJobActions(lifecycle: Parameters<typeof createJobActions>[2]) {
  const actions = useMemo(() => createJobActions(
    (id, action, signal) => (action === 'cancel' ? cancelJob : retryJob)(id, { signal }),
    (signal) => getRecognitionCsrf({ signal }), lifecycle,
  ), [lifecycle])
  const state = useSyncExternalStore(actions.subscribe, actions.getSnapshot, actions.getServerSnapshot)
  useEffect(() => actions.dispose, [actions])
  return { state, run: actions.run }
}
