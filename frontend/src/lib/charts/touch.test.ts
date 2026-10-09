import { describe, expect, it } from 'vitest'
import { activeLineX, activePieKey, initialLineSelection, lineSelectionReducer, noPieHighlight, pieHighlightReducer } from './selection'
import type { LineSelection, LineSelectionAction, PieHighlight, PieHighlightAction } from './selection'
import { advanceTouchGesture, gestureIntent, idleTouchGesture, pointerToPlotX, stepAvailability, touchGestureReducer, touchSlop } from './touch'
import type { TouchGesture, TouchGestureEffect, TouchGestureEvent } from './touch'

const xs = ['2026-01-01', '2026-02-01', '2026-03-01']
const line = (actions: LineSelectionAction[], state: LineSelection = initialLineSelection()) => actions.reduce(lineSelectionReducer, state)
const pie = (actions: PieHighlightAction[], state: PieHighlight = noPieHighlight) => actions.reduce(pieHighlightReducer, state)
const down = (pointerId: number, x: number, y: number): TouchGestureEvent => ({ type: 'down', pointerId, x, y })
const move = (pointerId: number, x: number, y: number): TouchGestureEvent => ({ type: 'move', pointerId, x, y })
const up = (pointerId: number): TouchGestureEvent => ({ type: 'up', pointerId })
const cancel = (pointerId: number): TouchGestureEvent => ({ type: 'cancel', pointerId })
/** Runs a touch and returns the last state with every effect on the way. */
function run(events: TouchGestureEvent[], state: TouchGesture = idleTouchGesture) {
  const effects: TouchGestureEffect[] = []
  for (const event of events) {
    const step = advanceTouchGesture(state, event)
    state = step.gesture
    effects.push(step.effect)
  }
  return { state, effects }
}

describe('gestureIntent (what a finger that moved by dx, dy is doing)', () => {
  it('waits inside the slop and counts a lifted finger there as a tap', () => {
    expect(touchSlop).toBe(8)
    for (const [dx, dy] of [[0, 0], [8, 0], [0, 8], [-8, -8], [5, -7]]) {
      expect(gestureIntent(dx, dy, 8), `${dx}, ${dy}`).toBe('undecided')
      expect(gestureIntent(dx, dy, 8, true), `${dx}, ${dy}`).toBe('tap')
    }
  })
  it('leads the selection once the horizontal move leaves the slop first', () => {
    expect(gestureIntent(9, 0, 8)).toBe('scrub')
    expect(gestureIntent(-9, 3, 8)).toBe('scrub')
    expect(gestureIntent(12, -12, 8)).toBe('scrub')
    expect(gestureIntent(40, 8, 8, true)).toBe('scrub')
  })
  it('leaves the touch to the page once the vertical move leaves the slop first', () => {
    expect(gestureIntent(0, 9, 8)).toBe('scroll')
    expect(gestureIntent(3, -9, 8)).toBe('scroll')
    expect(gestureIntent(10, 14, 8)).toBe('scroll')
    expect(gestureIntent(-10, -30, 8, true)).toBe('scroll')
  })
  it('takes the slop it is given', () => {
    expect(gestureIntent(9, 0, 16)).toBe('undecided')
    expect(gestureIntent(17, 0, 16)).toBe('scrub')
    expect(gestureIntent(0, 1, 0)).toBe('scroll')
  })
})

describe('touch gesture reducer (idle → pending → scrubbing | cancelled)', () => {
  it('selects nothing when the finger goes down', () => {
    expect(run([down(1, 100, 50)])).toEqual({ state: { phase: 'pending', pointerId: 1, startX: 100, startY: 50 }, effects: [null] })
  })
  it('commits a tap when the finger lifts without having moved away', () => {
    expect(run([down(1, 100, 50), move(1, 104, 53), up(1)])).toEqual({ state: idleTouchGesture, effects: [null, null, 'tap'] })
  })
  it('starts leading on a horizontal move past 8px and goes on with every further move, any direction', () => {
    const { state, effects } = run([down(1, 100, 50), move(1, 108, 50), move(1, 109, 51), move(1, 140, 90), move(1, 60, 10)])
    expect(effects).toEqual([null, null, 'scrub-start', 'scrub', 'scrub'])
    expect(state).toEqual({ phase: 'scrubbing', pointerId: 1 })
    // Lifting after leading keeps what the finger led to: no tap, no release.
    expect(run([up(1)], state)).toEqual({ state: idleTouchGesture, effects: [null] })
  })
  it('gives a vertical move to the page and ignores the rest of that touch', () => {
    const { state, effects } = run([down(1, 100, 50), move(1, 102, 60), move(1, 160, 62), up(1)])
    expect(effects).toEqual([null, null, null, null])
    expect(state).toEqual(idleTouchGesture)
    expect(touchGestureReducer({ phase: 'pending', pointerId: 1, startX: 100, startY: 50 }, move(1, 102, 60))).toEqual({ phase: 'cancelled', pointerId: 1 })
  })
  it('changes nothing on pointercancel, before or while leading', () => {
    expect(run([down(1, 100, 50), cancel(1)])).toEqual({ state: idleTouchGesture, effects: [null, null] })
    expect(run([down(1, 100, 50), move(1, 120, 50), cancel(1)]).effects).toEqual([null, 'scrub-start', null])
    expect(run([down(1, 100, 50), move(1, 120, 50), cancel(1)]).state).toEqual(idleTouchGesture)
  })
  it('has no press-and-hold: a finger that rests and lifts is the same tap', () => {
    expect(run([down(1, 100, 50), move(1, 100, 50), move(1, 101, 50), up(1)]).effects).toEqual([null, null, null, 'tap'])
  })
  it('treats a second finger as a pinch: neither finger taps or leads', () => {
    const pinch = run([down(1, 100, 50), down(2, 200, 50)])
    expect(pinch.state).toEqual({ phase: 'cancelled', pointerId: 2 })
    expect(run([move(1, 150, 50), move(2, 260, 50), up(1), up(2)], pinch.state)).toEqual({ state: idleTouchGesture, effects: [null, null, null, null] })
    expect(run([down(1, 100, 50), move(1, 130, 50), down(2, 200, 50), move(1, 160, 50)]).effects).toEqual([null, 'scrub-start', null, null])
  })
  it('ignores moves and lifts of a pointer it is not following', () => {
    const pending = run([down(1, 100, 50)]).state
    expect(advanceTouchGesture(pending, move(7, 300, 50))).toEqual({ gesture: pending, effect: null })
    expect(advanceTouchGesture(pending, up(7))).toEqual({ gesture: pending, effect: null })
    expect(advanceTouchGesture(idleTouchGesture, move(1, 300, 50))).toEqual({ gesture: idleTouchGesture, effect: null })
    expect(advanceTouchGesture(idleTouchGesture, up(1))).toEqual({ gesture: idleTouchGesture, effect: null })
    // The same pointer going down again starts over.
    expect(advanceTouchGesture(pending, down(1, 10, 10)).gesture).toEqual({ phase: 'pending', pointerId: 1, startX: 10, startY: 10 })
  })
  it('takes the slop it is given', () => {
    const pending = run([down(1, 100, 50)]).state
    expect(advanceTouchGesture(pending, move(1, 112, 50), 16).effect).toBeNull()
    expect(advanceTouchGesture(pending, move(1, 112, 50)).effect).toBe('scrub-start')
  })
})

describe('line selection by a finger (touch-commit, dismiss)', () => {
  const key = (command: 'previous' | 'next'): LineSelectionAction => ({ type: 'key', command, xs })

  it('selects the tapped interval and keeps it after the finger leaves', () => {
    const tapped = line([{ type: 'touch-commit', x: xs[1] }])
    expect(tapped).toMatchObject({ activeX: xs[1], source: 'touch' })
    expect(lineSelectionReducer(tapped, { type: 'pointer-leave' })).toBe(tapped)
    expect(line([{ type: 'touch-commit', x: xs[2] }], tapped)).toMatchObject({ activeX: xs[2], source: 'touch' })
  })
  it('releases the interval tapped a second time, whoever selected it', () => {
    expect(line([{ type: 'touch-commit', x: xs[1] }, { type: 'touch-commit', x: xs[1] }])).toEqual(initialLineSelection())
    expect(line([key('next'), { type: 'touch-commit', x: xs[0] }]).activeX).toBeNull()
    expect(line([{ type: 'pointer', x: xs[2], touch: true }, { type: 'touch-commit', x: xs[2] }]).activeX).toBeNull()
    // The third tap selects again.
    expect(line([{ type: 'touch-commit', x: xs[1] }, { type: 'touch-commit', x: xs[1] }, { type: 'touch-commit', x: xs[1] }]).activeX).toBe(xs[1])
  })
  it('ignores a tap that hit no interval', () => {
    const tapped = line([{ type: 'touch-commit', x: xs[1] }])
    expect(lineSelectionReducer(tapped, { type: 'touch-commit', x: null })).toBe(tapped)
    const idle = initialLineSelection()
    expect(lineSelectionReducer(idle, { type: 'touch-commit', x: null })).toBe(idle)
  })
  it('follows the finger while it leads and keeps the last interval', () => {
    const led = line([{ type: 'pointer', x: xs[0], touch: true }, { type: 'pointer', x: xs[1], touch: true }, { type: 'pointer', x: xs[2], touch: true }, { type: 'pointer-leave' }])
    expect(led).toMatchObject({ activeX: xs[2], source: 'touch' })
  })
  it('drops any selection on dismiss and keeps the hidden series', () => {
    for (const action of [{ type: 'touch-commit', x: xs[1] }, key('next'), { type: 'pointer', x: xs[1] }] as LineSelectionAction[]) {
      const state = line([{ type: 'toggle', key: 'aldi' }, action, { type: 'dismiss' }])
      expect(state).toEqual(initialLineSelection(['aldi']))
    }
    const idle = initialLineSelection()
    expect(lineSelectionReducer(idle, { type: 'dismiss' })).toBe(idle)
  })
  it('steps from a tapped interval with the buttons, which act as the arrow keys', () => {
    const stepped = line([{ type: 'touch-commit', x: xs[0] }, key('next')])
    expect(stepped).toMatchObject({ activeX: xs[1], source: 'keyboard' })
    expect(activeLineX(stepped, xs)).toBe(xs[1])
  })
})

describe('stepAvailability (buttons under the line chart)', () => {
  it('switches every button off without a selection, without intervals and for an interval that is gone', () => {
    const none = { previous: false, next: false, clear: false }
    expect(stepAvailability(null, xs)).toEqual(none)
    expect(stepAvailability(null, [])).toEqual(none)
    expect(stepAvailability(xs[0], [])).toEqual(none)
    expect(stepAvailability('2025-06-01', xs)).toEqual(none)
  })
  it('switches a step off at its edge', () => {
    expect(stepAvailability(xs[0], xs)).toEqual({ previous: false, next: true, clear: true })
    expect(stepAvailability(xs[1], xs)).toEqual({ previous: true, next: true, clear: true })
    expect(stepAvailability(xs[2], xs)).toEqual({ previous: true, next: false, clear: true })
    expect(stepAvailability(xs[0], [xs[0]])).toEqual({ previous: false, next: false, clear: true })
  })
})

describe('pointerToPlotX', () => {
  it('maps a pointer to the units of the drawing, whatever the plot is scaled to', () => {
    expect(pointerToPlotX(110, { left: 10, width: 200 }, 640)).toBe(320)
    expect(pointerToPlotX(10, { left: 10, width: 200 }, 640)).toBe(0)
    expect(pointerToPlotX(210, { left: 10, width: 200 }, 640)).toBe(640)
    expect(pointerToPlotX(160, { left: 0, width: 320 }, 320)).toBe(160)
  })
  it('goes past the edges with a captured finger and gives nothing for a plot without width', () => {
    expect(pointerToPlotX(-40, { left: 10, width: 200 }, 640)).toBe(-160)
    expect(pointerToPlotX(310, { left: 10, width: 200 }, 640)).toBe(960)
    expect(pointerToPlotX(50, { left: 10, width: 0 }, 640)).toBeNull()
    expect(pointerToPlotX(50, { left: 10, width: Number.NaN }, 640)).toBeNull()
  })
})

describe('pie highlight pinned by a tap', () => {
  const keys = ['milk', 'bread', 'other']

  it('pins on a tap, moves to another tapped key and releases on the second tap', () => {
    const pinned = pie([{ type: 'pin', key: 'milk' }])
    expect(pinned.pinned).toBe('milk')
    expect(activePieKey(pinned, keys)).toBe('milk')
    expect(activePieKey(pie([{ type: 'pin', key: 'bread' }], pinned), keys)).toBe('bread')
    expect(pie([{ type: 'pin', key: 'milk' }], pinned)).toEqual(noPieHighlight)
  })
  it('ranks the pointer first, then the pin, then the focus', () => {
    const state = pie([{ type: 'focus', key: 'other' }, { type: 'pin', key: 'bread' }, { type: 'enter', key: 'milk' }])
    expect(activePieKey(state, keys)).toBe('milk')
    const left = pie([{ type: 'leave', key: 'milk' }], state)
    expect(activePieKey(left, keys)).toBe('bread')
    expect(activePieKey(pie([{ type: 'unpin' }], left), keys)).toBe('other')
  })
  it('releases on a tap outside and keeps the same object when nothing was pinned', () => {
    expect(pie([{ type: 'pin', key: 'milk' }, { type: 'unpin' }])).toEqual(noPieHighlight)
    expect(pieHighlightReducer(noPieHighlight, { type: 'unpin' })).toBe(noPieHighlight)
    const legacy: PieHighlight = { hovered: null, focused: 'milk' }
    expect(pieHighlightReducer(legacy, { type: 'unpin' })).toBe(legacy)
  })
  it('takes the focus the first tap left on the sector away with the second tap, and no other focus', () => {
    const tapped = pie([{ type: 'focus', key: 'milk' }, { type: 'pin', key: 'milk' }])
    expect(activePieKey(pie([{ type: 'pin', key: 'milk' }], tapped), keys)).toBeNull()
    const elsewhere = pie([{ type: 'focus', key: 'bread' }, { type: 'pin', key: 'milk' }, { type: 'pin', key: 'milk' }])
    expect(elsewhere).toEqual({ hovered: null, focused: 'bread', pinned: null })
  })
  it('forgets a pinned key that left the data', () => {
    expect(activePieKey(pie([{ type: 'pin', key: 'gone' }]), keys)).toBeNull()
    expect(activePieKey({ hovered: null, focused: 'bread', pinned: 'gone' }, keys)).toBe('bread')
  })
})
