import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react'
import { getRecognitionCsrf } from '../../api/local'
import {
  confirmProductClassification, confirmProductClassifications, rejectProductClassification, requestProductClassificationRun,
} from '../../api/product-classifications'
import { createClassificationActions } from './actions'
import type { ActionLifecycle, ActionState, ClassificationApi } from './actions'

const api: ClassificationApi = {
  confirm: (id, input, signal) => confirmProductClassification(id, input, { signal }),
  reject: (id, input, signal) => rejectProductClassification(id, input, { signal }),
  confirmMany: (items, signal) => confirmProductClassifications(items, { signal }),
  requestRun: (signal) => requestProductClassificationRun({ signal }),
  refreshCsrf: (signal) => getRecognitionCsrf({ signal }),
}

export function useClassificationActions(lifecycle: ActionLifecycle) {
  const actions = useMemo(() => createClassificationActions(api, lifecycle), [lifecycle])
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

/** Opening an inline area moves focus into it; closing it without an action returns focus to the button that opened it. */
export function useAreaFocus<T extends HTMLElement>() {
  const root = useRef<T>(null)
  const wanted = useRef<string | undefined>(undefined)
  useEffect(() => {
    const selector = wanted.current
    wanted.current = undefined
    if (selector) root.current?.querySelector<HTMLElement>(selector)?.focus()
  })
  return {
    root,
    opened: useCallback(() => { wanted.current = '[data-class-focus]' }, []),
    closed: useCallback((key: string) => { wanted.current = `[data-class-trigger="${key}"]` }, []),
  }
}
