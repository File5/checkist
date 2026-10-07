import { describe, expect, it } from 'vitest'
import {
  activeLineX, activePieKey, initialLineSelection, lineKeyCommand, lineReadout, lineSelectionReducer, lineTooltipAnchor,
  noPieHighlight, pieHighlightReducer, stepLineSelection,
} from './selection'
import type { LineSelection, LineSelectionAction, PieHighlight, PieHighlightAction } from './selection'

const pie = (actions: PieHighlightAction[], state: PieHighlight = noPieHighlight) => actions.reduce(pieHighlightReducer, state)
const line = (actions: LineSelectionAction[], state: LineSelection = initialLineSelection()) => actions.reduce(lineSelectionReducer, state)
const xs = ['2026-01-01', '2026-02-01', '2026-03-01']

describe('pie highlight (sector and legend row share one state)', () => {
  const keys = ['milk', 'bread', 'other']

  it('highlights on pointer and on focus, the pointer first', () => {
    expect(activePieKey(noPieHighlight, keys)).toBeNull()
    expect(activePieKey(pie([{ type: 'enter', key: 'milk' }]), keys)).toBe('milk')
    expect(activePieKey(pie([{ type: 'focus', key: 'bread' }]), keys)).toBe('bread')
    const both = pie([{ type: 'focus', key: 'bread' }, { type: 'enter', key: 'milk' }])
    expect(activePieKey(both, keys)).toBe('milk')
    expect(activePieKey(pie([{ type: 'leave', key: 'milk' }], both), keys)).toBe('bread')
    expect(pie([{ type: 'leave', key: 'milk' }, { type: 'blur', key: 'bread' }], both)).toEqual(noPieHighlight)
  })
  it('ignores a late leave or blur of an element that is no longer current', () => {
    const moved = pie([{ type: 'enter', key: 'milk' }, { type: 'enter', key: 'bread' }, { type: 'leave', key: 'milk' }])
    expect(moved.hovered).toBe('bread')
    const refocused = pie([{ type: 'focus', key: 'milk' }, { type: 'focus', key: 'bread' }, { type: 'blur', key: 'milk' }])
    expect(refocused.focused).toBe('bread')
  })
  it('keeps the same object when nothing changes and forgets keys that left the data', () => {
    const state = pie([{ type: 'enter', key: 'milk' }])
    expect(pieHighlightReducer(state, { type: 'enter', key: 'milk' })).toBe(state)
    expect(pieHighlightReducer(state, { type: 'blur', key: 'milk' })).toBe(state)
    expect(activePieKey(state, ['bread'])).toBeNull()
    expect(activePieKey({ hovered: 'gone', focused: 'bread' }, ['bread'])).toBe('bread')
  })
})

describe('line keyboard', () => {
  it('maps only its own keys', () => {
    expect(['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].map(lineKeyCommand)).toEqual(['previous', 'next', 'first', 'last', 'clear'])
    for (const key of ['ArrowUp', 'ArrowDown', 'Tab', 'Enter', ' ', 'a', 'PageDown']) expect(lineKeyCommand(key)).toBeNull()
  })
  it('steps through intervals and stops at the edges', () => {
    expect(stepLineSelection(null, 'next', xs)).toBe(xs[0])
    expect(stepLineSelection(null, 'previous', xs)).toBe(xs[2])
    expect(stepLineSelection(xs[0], 'next', xs)).toBe(xs[1])
    expect(stepLineSelection(xs[2], 'next', xs)).toBe(xs[2])
    expect(stepLineSelection(xs[1], 'previous', xs)).toBe(xs[0])
    expect(stepLineSelection(xs[0], 'previous', xs)).toBe(xs[0])
    expect(stepLineSelection(xs[1], 'first', xs)).toBe(xs[0])
    expect(stepLineSelection(xs[1], 'last', xs)).toBe(xs[2])
    expect(stepLineSelection(xs[1], 'clear', xs)).toBeNull()
  })
  it('restarts from an edge when the selected interval is gone and does nothing without intervals', () => {
    expect(stepLineSelection('2025-06-01', 'next', xs)).toBe(xs[0])
    expect(stepLineSelection('2025-06-01', 'previous', xs)).toBe(xs[2])
    for (const command of ['next', 'previous', 'first', 'last', 'clear'] as const) expect(stepLineSelection(xs[0], command, [])).toBeNull()
  })
})

describe('line selection reducer', () => {
  const key = (command: 'previous' | 'next' | 'first' | 'last' | 'clear'): LineSelectionAction => ({ type: 'key', command, xs })

  it('walks with the arrows, jumps with Home/End and clears with Escape', () => {
    expect(line([key('next'), key('next')])).toMatchObject({ activeX: xs[1], source: 'keyboard' })
    expect(line([key('last'), key('previous')]).activeX).toBe(xs[1])
    expect(line([key('next'), key('last')]).activeX).toBe(xs[2])
    expect(line([key('last'), key('first')]).activeX).toBe(xs[0])
    expect(line([key('next'), key('clear')])).toEqual(initialLineSelection())
  })
  it('follows the pointer and drops only a pointer selection when it leaves', () => {
    const hovered = line([{ type: 'pointer', x: xs[2] }])
    expect(hovered).toMatchObject({ activeX: xs[2], source: 'pointer' })
    expect(lineSelectionReducer(hovered, { type: 'pointer', x: xs[2] })).toBe(hovered)
    expect(lineSelectionReducer(hovered, { type: 'pointer', x: null })).toBe(hovered)
    expect(line([{ type: 'pointer-leave' }], hovered).activeX).toBeNull()
    const typed = line([key('next')])
    expect(lineSelectionReducer(typed, { type: 'pointer-leave' })).toBe(typed)
  })
  it('drops a keyboard selection on blur but not one the pointer holds', () => {
    expect(line([key('next'), { type: 'blur' }]).activeX).toBeNull()
    const hovered = line([{ type: 'pointer', x: xs[0] }])
    expect(lineSelectionReducer(hovered, { type: 'blur' })).toBe(hovered)
    const idle = initialLineSelection()
    expect(lineSelectionReducer(idle, { type: 'blur' })).toBe(idle)
    expect(lineSelectionReducer(idle, { type: 'pointer-leave' })).toBe(idle)
  })
  it('keeps the point a finger tapped after it lifts, until another tap, Escape or blur', () => {
    const tapped = line([{ type: 'pointer', x: xs[1], touch: true }])
    expect(tapped).toMatchObject({ activeX: xs[1], source: 'touch' })
    expect(lineSelectionReducer(tapped, { type: 'pointer', x: xs[1], touch: true })).toBe(tapped)
    expect(lineSelectionReducer(tapped, { type: 'pointer-leave' })).toBe(tapped)
    expect(line([{ type: 'pointer', x: xs[2], touch: true }, { type: 'pointer-leave' }], tapped)).toMatchObject({ activeX: xs[2], source: 'touch' })
    expect(line([key('clear')], tapped).activeX).toBeNull()
    expect(line([{ type: 'blur' }], tapped).activeX).toBeNull()
    expect(line([key('previous')], tapped)).toMatchObject({ activeX: xs[0], source: 'keyboard' })
    // A mouse on the same device takes the selection over and drops it on leaving, as before.
    expect(line([{ type: 'pointer', x: xs[1] }], tapped)).toMatchObject({ activeX: xs[1], source: 'pointer' })
    expect(line([{ type: 'pointer', x: xs[1] }, { type: 'pointer-leave' }], tapped).activeX).toBeNull()
  })
  it('continues from the pointer position when the keyboard takes over', () => {
    expect(line([{ type: 'pointer', x: xs[1] }, key('next')])).toMatchObject({ activeX: xs[2], source: 'keyboard' })
  })
  it('switches series off and on without touching the selection', () => {
    const state = line([key('next'), { type: 'toggle', key: 'lidl' }, { type: 'toggle', key: 'aldi' }])
    expect(state).toMatchObject({ activeX: xs[0], hidden: ['lidl', 'aldi'] })
    expect(line([{ type: 'toggle', key: 'lidl' }], state).hidden).toEqual(['aldi'])
    expect(initialLineSelection(['a', 'a', 'b']).hidden).toEqual(['a', 'b'])
  })
  it('shows the selection only while its interval is among the visible series', () => {
    const state = line([key('last')])
    expect(activeLineX(state, xs)).toBe(xs[2])
    expect(activeLineX(state, xs.slice(0, 2))).toBeNull()
    expect(activeLineX(initialLineSelection(), xs)).toBeNull()
  })
})

describe('line readout for the live region', () => {
  const series = [
    { label: 'Lidl', values: new Map([[xs[0], '1,05 EUR'], [xs[1], '1,09 EUR']]) },
    { label: 'Aldi', values: new Map([[xs[1], '0,99 EUR']]) },
  ]
  const formatX = (x: string) => `месяц ${x.slice(5, 7)}`

  it('names the interval and every series that has a value in it', () => {
    expect(lineReadout(xs[1], series, formatX)).toBe('месяц 02: Lidl — 1,09 EUR; Aldi — 0,99 EUR')
    expect(lineReadout(xs[0], series, formatX)).toBe('месяц 01: Lidl — 1,05 EUR')
  })
  it('is empty without a selection and says so when no visible series has data', () => {
    expect(lineReadout(null, series, formatX)).toBe('')
    expect(lineReadout(xs[2], series, formatX)).toBe('месяц 03: нет данных')
  })
})

describe('line tooltip anchor', () => {
  it('hangs right of the crosshair in the left half, anchored by the left edge', () => {
    expect(lineTooltipAnchor(64, 640)).toEqual({ side: 'right', style: { left: '10%' } })
    expect(lineTooltipAnchor(320, 640)).toEqual({ side: 'right', style: { left: '50%' } })
  })
  it('hangs left of the crosshair in the right half, anchored by the right edge so the room is the left part of the plot', () => {
    // Anchoring by `left` here would leave only the 11 % and 5 % right of the last point for the width.
    expect(lineTooltipAnchor(569.6, 640)).toEqual({ side: 'left', style: { right: '11%' } })
    expect(lineTooltipAnchor(304, 320)).toEqual({ side: 'left', style: { right: '5%' } })
    expect(lineTooltipAnchor(321, 640)).toEqual({ side: 'left', style: { right: '49.84%' } })
  })
  it('always leaves at least half of the plot on the chosen side and never points outside it', () => {
    for (const width of [240, 320, 640, 1200]) {
      for (let step = 0; step <= 20; step += 1) {
        const anchor = lineTooltipAnchor((width * step) / 20, width)
        const offset = parseFloat('left' in anchor.style ? anchor.style.left : anchor.style.right)
        expect(offset).toBeGreaterThanOrEqual(0)
        expect(offset).toBeLessThanOrEqual(50)
        expect(Object.keys(anchor.style)).toEqual([anchor.side === 'left' ? 'right' : 'left'])
      }
    }
    expect(lineTooltipAnchor(700, 640)).toEqual({ side: 'left', style: { right: '0%' } })
    expect(lineTooltipAnchor(-5, 640)).toEqual({ side: 'right', style: { left: '0%' } })
  })
})
