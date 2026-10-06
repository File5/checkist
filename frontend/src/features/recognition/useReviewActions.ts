import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { confirmReceiptImage, getRecognitionCsrf } from '../../api/recognition'
import { createReviewActions, reviewFocusTarget } from './review-actions'
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

/** Applies reviewFocusTarget to the document. The cards are focus owners (data-request-focus-own),
 * so the tracker of the surrounding request block does not move this focus to its heading.
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
    const available = pressed instanceof HTMLElement && pressed.isConnected && !pressed.matches(':disabled')
    const target = reviewFocusTarget(!active || active === document.body ? 'body' : active === pressed ? 'pressed' : 'elsewhere', available)
    if (target === 'pressed' && pressed instanceof HTMLElement) pressed.focus()
    else if (target === 'result') result.current?.focus()
  }, [state])
  return { remember, result }
}
