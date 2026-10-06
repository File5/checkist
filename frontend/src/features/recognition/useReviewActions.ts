import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { confirmReceiptImage, getRecognitionCsrf } from '../../api/recognition'
import { createReviewActions } from './review-actions'
import type { ReviewActionState } from './review-actions'

export function useReviewActions(lifecycle: Parameters<typeof createReviewActions>[2]) {
  const actions = useMemo(() => createReviewActions(
    (imageId, input, signal) => confirmReceiptImage(imageId, input, { signal }),
    (signal) => getRecognitionCsrf({ signal }), lifecycle,
  ), [lifecycle])
  const state = useSyncExternalStore(actions.subscribe, actions.getSnapshot, actions.getServerSnapshot)
  useEffect(() => actions.dispose, [actions])
  return { state, run: actions.run }
}
export type ReviewControl = ReturnType<typeof useReviewActions>

/** The pressed button is disabled during its request and disappears with the form after a success:
 * give focus back to it, or to the result message when it is gone. Same rule as useActionFocus of merges.
 */
export function useReviewFocus<T extends HTMLElement>(state: ReviewActionState) {
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
