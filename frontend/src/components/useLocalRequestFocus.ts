import { useLayoutEffect, useRef } from 'react'
import { createLocalRequestFocus, insideLocalBlock } from './local-request-focus'
import type { LocalRequestPhase } from './local-request-focus'

/** Keep the ref's block and its data-request-focus-target mounted across all states. */
export function useLocalRequestFocus<T extends HTMLElement = HTMLElement>(state: { kind: LocalRequestPhase }) {
  const block = useRef<T>(null)
  const tracker = useRef<ReturnType<typeof createLocalRequestFocus<Element>>>(undefined)
  useLayoutEffect(() => {
    const scope = block.current
    if (!scope) return
    const local = createLocalRequestFocus<Element>({
      active: () => document.activeElement ?? document.body,
      inside: (element) => insideLocalBlock<Element>(scope, element),
      body: (element) => element === document.body,
      available: (element) => element.isConnected && !element.matches(':disabled'),
      isRetry: (element) => element.hasAttribute('data-request-retry'),
      result: () => scope.querySelector('[data-request-focus-target]') ?? scope,
      retry: () => scope.querySelector('[data-request-retry]') ?? undefined,
      focus: (element) => { if (element instanceof HTMLElement) element.focus() },
    })
    tracker.current = local
    const track = () => local.focusChanged(document.activeElement ?? document.body)
    document.addEventListener('focusin', track)
    track()
    return () => {
      document.removeEventListener('focusin', track)
      local.invalidate()
      tracker.current = undefined
    }
  }, [])
  // Every commit also catches a focused reset/remove button disappearing without a request.
  // No completion callback owns focus: stale/aborted results cannot reach this effect.
  useLayoutEffect(() => { tracker.current?.update(state) })
  return block
}
