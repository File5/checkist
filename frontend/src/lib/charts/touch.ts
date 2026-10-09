/** Finger gestures of the charts as pure functions (tested in Node) and the one hook the components share. */
import { useEffect } from 'react'
import type { RefObject } from 'react'

/** A finger that moved less than this, in CSS pixels, has not chosen a direction yet. */
export const touchSlop = 8

export type GestureIntent = 'tap' | 'scrub' | 'scroll' | 'undecided'

/**
 * What a finger that moved by (dx, dy) since it went down is doing. The axis that leaves the slop first wins: a
 * horizontal move leads the selection, a vertical one belongs to the page. Inside the slop the finger is undecided
 * while it is down and has tapped once it is lifted.
 */
export function gestureIntent(dx: number, dy: number, slop: number, lifted = false): GestureIntent {
  const horizontal = Math.abs(dx)
  const vertical = Math.abs(dy)
  if (horizontal > slop && horizontal >= vertical) return 'scrub'
  if (vertical > slop) return 'scroll'
  return lifted ? 'tap' : 'undecided'
}

export type TouchGesture =
  | { phase: 'idle' }
  | { phase: 'pending'; pointerId: number; startX: number; startY: number }
  | { phase: 'scrubbing'; pointerId: number }
  /** The page scrolls or a second finger came down: the rest of the touch is not ours. */
  | { phase: 'cancelled'; pointerId: number }
export type TouchGestureEvent =
  | { type: 'down' | 'move'; pointerId: number; x: number; y: number }
  | { type: 'up' | 'cancel'; pointerId: number }
/** `scrub-start` — capture the pointer and select under the finger; `scrub` — select under the finger; `tap` — commit. */
export type TouchGestureEffect = 'scrub-start' | 'scrub' | 'tap' | null

export const idleTouchGesture: TouchGesture = { phase: 'idle' }

/** One step of a touch: the next state and what the chart has to do now. Nothing is selected on `down`. */
export function advanceTouchGesture(
  state: TouchGesture, event: TouchGestureEvent, slop: number = touchSlop,
): { gesture: TouchGesture; effect: TouchGestureEffect } {
  if (event.type === 'down') {
    // A second finger is a pinch, never a selection. The latest finger is the one waited for, so a touch whose
    // end was lost cannot hold the state for ever.
    if (state.phase !== 'idle' && state.pointerId !== event.pointerId) return { gesture: { phase: 'cancelled', pointerId: event.pointerId }, effect: null }
    return { gesture: { phase: 'pending', pointerId: event.pointerId, startX: event.x, startY: event.y }, effect: null }
  }
  if (state.phase === 'idle' || state.pointerId !== event.pointerId) return { gesture: state, effect: null }
  switch (event.type) {
    case 'move': {
      if (state.phase === 'scrubbing') return { gesture: state, effect: 'scrub' }
      if (state.phase === 'cancelled') return { gesture: state, effect: null }
      const intent = gestureIntent(event.x - state.startX, event.y - state.startY, slop)
      if (intent === 'scrub') return { gesture: { phase: 'scrubbing', pointerId: state.pointerId }, effect: 'scrub-start' }
      if (intent === 'scroll') return { gesture: { phase: 'cancelled', pointerId: state.pointerId }, effect: null }
      return { gesture: state, effect: null }
    }
    case 'up': return { gesture: idleTouchGesture, effect: state.phase === 'pending' ? 'tap' : null }
    // The browser took the touch for scrolling or zooming: whatever was selected before stays as it was.
    case 'cancel': return { gesture: idleTouchGesture, effect: null }
  }
}

export function touchGestureReducer(state: TouchGesture, event: TouchGestureEvent): TouchGesture {
  return advanceTouchGesture(state, event).gesture
}

export interface PlotBox { left: number; width: number }

/** Horizontal position of a pointer in the units of the drawing; null while the plot has no width. */
export function pointerToPlotX(clientX: number, box: PlotBox, layoutWidth: number): number | null {
  if (!(box.width > 0)) return null
  return ((clientX - box.left) / box.width) * layoutWidth
}

export interface StepAvailability { previous: boolean; next: boolean; clear: boolean }

/** Which of the buttons under a line chart work: none without a selection, no step past an edge. */
export function stepAvailability(activeX: string | null, xs: readonly string[]): StepAvailability {
  const index = activeX === null ? -1 : xs.indexOf(activeX)
  if (index === -1) return { previous: false, next: false, clear: false }
  return { previous: index > 0, next: index < xs.length - 1, clear: true }
}

/**
 * Calls `onOutside` when a finger taps outside the element while `active`. A lifted finger, not one that went
 * down: a touch that scrolls the page ends with `pointercancel` and leaves the chart alone. `onOutside` must keep
 * its identity between renders.
 */
export function useOutsideTouch(ref: RefObject<Element | null>, active: boolean, onOutside: () => void) {
  useEffect(() => {
    if (!active) return undefined
    const onPointerUp = (event: PointerEvent) => {
      if (event.pointerType !== 'touch') return
      const node = ref.current
      if (node && event.target instanceof Node && node.contains(event.target)) return
      onOutside()
    }
    document.addEventListener('pointerup', onPointerUp)
    return () => document.removeEventListener('pointerup', onPointerUp)
  }, [ref, active, onOutside])
}
