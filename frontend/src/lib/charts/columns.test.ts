import { describe, expect, it } from 'vitest'
import { barShare, layoutColumns, stackHeight } from './columns'
import { formatAxisTick } from './scale'

const options = { width: 640, height: 280, formatValue: (value: number, step: number) => formatAxisTick(value, step, true), formatTick: (x: string) => x.slice(0, 7) }
const months = ['2026-06-01', '2026-07-01', '2026-08-01', '2026-09-01']

describe('stacked columns layout (pure geometry)', () => {
  const layout = layoutColumns([
    { x: months[0], segments: [{ key: 'food', value: 50 }, { key: 'rest', value: 10 }] },
    { x: months[1], segments: [] },
    { x: months[2], segments: [{ key: 'food', value: 54 }, { key: 'rest', value: -2 }] },
    { x: months[3], segments: [{ key: 'food', value: 40 }, { key: 'home', value: 0 }] },
  ], options)

  it('keeps every period, the empty one too, in equal slots', () => {
    expect(layout.columns.map((column) => column.x)).toEqual(months)
    const slots = layout.columns.map((column) => column.slotWidth)
    expect(new Set(slots).size).toBe(1)
    expect(layout.columns[1].segments).toEqual([])
    expect(layout.columns[1].top).toBe(layout.plot.bottom)
    for (const column of layout.columns) {
      expect(column.width).toBeCloseTo(Math.min(56, column.slotWidth * barShare))
      expect(column.center).toBeCloseTo(column.slotLeft + column.slotWidth / 2)
    }
  })
  it('stacks positive segments from zero in the given order and leaves out the rest', () => {
    const [first, , third, fourth] = layout.columns
    expect(first.segments.map((segment) => segment.key)).toEqual(['food', 'rest'])
    expect(first.segments[0].y + first.segments[0].height).toBeCloseTo(layout.plot.bottom)
    expect(first.segments[1].y + first.segments[1].height).toBeCloseTo(first.segments[0].y)
    expect(first.segments[0].height / first.segments[1].height).toBeCloseTo(5)
    expect(third.segments.map((segment) => segment.key)).toEqual(['food'])
    expect(fourth.segments.map((segment) => segment.key)).toEqual(['food'])
    expect(first.top).toBeCloseTo(first.segments[1].y)
  })
  it('puts the axis on nice money ticks from zero over the highest stack', () => {
    expect(layout.yTicks.map((tick) => tick.text)).toEqual(['0', '20', '40', '60'])
    expect(layout.yTicks[0].position).toBe(layout.plot.bottom)
    expect(layout.yTicks.at(-1)!.position).toBe(layout.plot.top)
    expect(stackHeight({ x: months[2], segments: [{ key: 'a', value: 54 }, { key: 'b', value: -2 }] })).toBe(54)
  })
  it('labels as many periods as fit and draws an empty window without dividing by zero', () => {
    expect(layout.xTicks.map((tick) => tick.text)).toEqual(['2026-06', '2026-07', '2026-08', '2026-09'])
    const narrow = layoutColumns(Array.from({ length: 24 }, (_, index) => ({ x: `2025-${String(index).padStart(2, '0')}-01`, segments: [] })), { ...options, width: 320 })
    expect(narrow.xTicks.length).toBeLessThan(24)
    expect(narrow.xTicks.length).toBeGreaterThan(1)
    const empty = layoutColumns([], options)
    expect(empty.columns).toEqual([])
    expect(empty.yTicks.map((tick) => tick.text)).toEqual(['0,00', '0,20', '0,40', '0,60', '0,80', '1,00'])
  })
})
