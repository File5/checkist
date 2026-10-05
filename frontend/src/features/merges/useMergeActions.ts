import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { getRecognitionCsrf } from '../../api/local'
import { cancelProductMerge, confirmProductMerge, detectProductMerges, excludeProductMerge } from '../../api/product-merges'
import { createMergeActions } from './actions'
import type { ActionState, MergeAction } from './actions'

function send(action: MergeAction, signal: AbortSignal) {
  switch (action.type) {
    case 'detect': return detectProductMerges({ signal })
    case 'confirm': return confirmProductMerge(action.id, action.input, { signal })
    case 'cancel': return cancelProductMerge(action.id, { signal })
    case 'exclude': return excludeProductMerge(action.id, action.input, { signal })
  }
}

export function useMergeActions(lifecycle: Parameters<typeof createMergeActions>[2]) {
  const actions = useMemo(() => createMergeActions(send, (signal) => getRecognitionCsrf({ signal }), lifecycle), [lifecycle])
  const state = useSyncExternalStore(actions.subscribe, actions.getSnapshot, actions.getServerSnapshot)
  useEffect(() => actions.dispose, [actions])
  return { state, run: actions.run }
}

/** A pressed button is disabled during its request: give focus back to it, or to the result message when it is gone. */
export function useActionFocus<T extends HTMLElement>(state: ActionState) {
  const trigger = useRef<Element | null>(null)
  const result = useRef<T>(null)
  const remember = useCallback(() => { trigger.current = document.activeElement }, [])
  useEffect(() => {
    if (state.kind !== 'done' && state.kind !== 'failed') return
    const pressed = trigger.current
    trigger.current = null
    const active = document.activeElement
    // The person moved on while waiting: never take focus from their new place.
    if (active && active !== document.body && active !== pressed) return
    if (pressed instanceof HTMLElement && pressed.isConnected && !pressed.matches(':disabled')) pressed.focus()
    else result.current?.focus()
  }, [state])
  return { remember, result }
}
