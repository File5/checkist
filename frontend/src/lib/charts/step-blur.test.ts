import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { activeLineX, initialLineSelection, lineBlurAction, lineSelectionReducer } from './selection'
import type { LineFocusDestination, LineSelection, LineSelectionAction } from './selection'
import { stepAvailability } from './touch'

const xs = ['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01']
const line = (actions: LineSelectionAction[], state: LineSelection = initialLineSelection()) => actions.reduce(lineSelectionReducer, state)
const key = (command: 'previous' | 'next' | 'clear'): LineSelectionAction => ({ type: 'key', command, xs })
/** What the chart does when the plot or a button under it loses the focus to `destination`. */
function blur(state: LineSelection, destination: LineFocusDestination) {
  const action = lineBlurAction(destination)
  return action === null ? state : lineSelectionReducer(state, action)
}
/** A press of «Предыдущий интервал» / «Следующий интервал». */
const step = (command: 'previous' | 'next'): LineSelectionAction => ({ type: 'step', command, xs })
const tap = (x: string) => line([{ type: 'touch-commit', x }])

describe('a blur and the selection of a line chart', () => {
  it('names the action by where the focus went', () => {
    expect(lineBlurAction('controls')).toBeNull()
    expect(lineBlurAction('outside')).toEqual({ type: 'blur' })
    expect(lineBlurAction('chart')).toEqual({ type: 'focus-lost' })
    expect(lineBlurAction('unknown')).toEqual({ type: 'focus-lost' })
  })

  // Safari on an iPhone: a tapped button takes no focus, the plot loses it with no `relatedTarget`.
  it('keeps what a finger selected when the blur names no destination, and the buttons go on stepping', () => {
    const tapped = tap(xs[1])
    expect(tapped).toMatchObject({ activeX: xs[1], source: 'touch' })
    const blurred = blur(tapped, 'unknown')
    expect(blurred).toBe(tapped)
    expect(stepAvailability(activeLineX(blurred, xs), xs)).toEqual({ previous: true, next: true, clear: true })

    const forward = line([step('next')], blurred)
    expect(forward).toMatchObject({ activeX: xs[2], source: 'touch' })
    expect(stepAvailability(activeLineX(forward, xs), xs)).toEqual({ previous: true, next: true, clear: true })
    const back = line([step('previous'), step('previous')], forward)
    expect(back.activeX).toBe(xs[0])
    expect(stepAvailability(activeLineX(back, xs), xs)).toEqual({ previous: false, next: true, clear: true })
  })
  it('keeps it through a blur before every press, as each tap of a button sends one', () => {
    let state = tap(xs[0])
    for (const expected of [xs[1], xs[2], xs[3]]) {
      state = blur(state, 'unknown')
      expect(stepAvailability(activeLineX(state, xs), xs).next).toBe(true)
      state = lineSelectionReducer(state, step('next'))
      expect(state.activeX).toBe(expected)
    }
    expect(stepAvailability(activeLineX(state, xs), xs)).toEqual({ previous: true, next: false, clear: true })
  })
  it('keeps a selection led by a finger the same way', () => {
    const scrubbed = line([{ type: 'pointer', x: xs[2], touch: true }])
    expect(blur(scrubbed, 'unknown')).toBe(scrubbed)
    expect(blur(scrubbed, 'chart')).toBe(scrubbed)
  })
  it('lets «Снять выделение» work after such a blur', () => {
    const blurred = blur(tap(xs[1]), 'unknown')
    expect(stepAvailability(activeLineX(blurred, xs), xs).clear).toBe(true)
    const cleared = line([{ type: 'dismiss' }], blurred)
    expect(cleared).toEqual(initialLineSelection())
    expect(stepAvailability(activeLineX(cleared, xs), xs)).toEqual({ previous: false, next: false, clear: false })
  })
  it('still ends the selection of a finger by a tap outside the chart and by the focus leaving the chart', () => {
    const blurred = blur(tap(xs[1]), 'unknown')
    // `useOutsideTouch` dispatches `dismiss`.
    expect(line([{ type: 'dismiss' }], blurred).activeX).toBeNull()
    expect(blur(tap(xs[1]), 'outside').activeX).toBeNull()
  })
  it('keeps the selection while the focus moves between the plot and its buttons', () => {
    const tapped = tap(xs[1])
    expect(blur(tapped, 'controls')).toBe(tapped)
    const typed = line([key('next')])
    expect(blur(typed, 'controls')).toBe(typed)
  })
  it('drops a keyboard selection on any blur that leaves the plot and its buttons, as before', () => {
    for (const destination of ['unknown', 'chart', 'outside'] as const) {
      expect(blur(line([key('next')]), destination), destination).toEqual(initialLineSelection())
      // An arrow key after a tap takes the selection over.
      expect(blur(line([key('next')], tap(xs[1])), destination).activeX, destination).toBeNull()
    }
  })
  it('steps by a button as an arrow key does and leaves a keyboard selection to the keyboard', () => {
    expect(line([step('next')])).toMatchObject({ activeX: xs[0], source: 'touch' })
    expect(line([step('previous')])).toMatchObject({ activeX: xs[3], source: 'touch' })
    expect(line([step('next')], line([key('next')]))).toMatchObject({ activeX: xs[1], source: 'keyboard' })
    expect(line([step('next')], line([{ type: 'pointer', x: xs[1] }]))).toMatchObject({ activeX: xs[2], source: 'touch' })
    expect(line([step('next')], tap(xs[3])).activeX).toBe(xs[3])
    expect(lineSelectionReducer(initialLineSelection(), { type: 'step', command: 'next', xs: [] })).toEqual(initialLineSelection())
  })
  it('leaves a mouse selection and an empty one alone, as before', () => {
    const hovered = line([{ type: 'pointer', x: xs[0] }])
    const idle = initialLineSelection()
    for (const destination of ['unknown', 'chart', 'outside'] as const) {
      expect(blur(hovered, destination), destination).toBe(hovered)
      expect(blur(idle, destination), destination).toBe(idle)
    }
  })
  it('keeps the hidden series whatever the blur does', () => {
    const state = line([{ type: 'toggle', key: 'b' }, { type: 'touch-commit', x: xs[1] }])
    expect(blur(state, 'outside')).toEqual({ activeX: null, source: null, hidden: ['b'] })
  })
})

describe('LineChart wiring of the blur (source text)', () => {
  const source = readFileSync(new URL('./LineChart.tsx', import.meta.url), 'utf8')

  it('decides through lineBlurAction and dispatches no blur of its own', () => {
    expect(source).toContain('lineBlurAction(destination)')
    expect(source).not.toMatch(/dispatch\(\{ type: 'blur' \}\)/)
    expect(source).toContain("{ type: 'step', command, xs: layout.xs }")
  })
  it('does not let a pressed step button take the focus from the plot', () => {
    expect(source).toMatch(/className="ck-line-steps" onBlur=\{onBlur\} onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/)
  })
})
