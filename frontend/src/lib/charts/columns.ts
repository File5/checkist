/** Pure layout of stacked columns: one column per period, segments stacked from zero, a value axis with nice ticks. */
import { linearScale, minAxisStep, niceTicks, pickTicks } from './scale.ts'
import type { AxisTick, XTick } from './line.ts'

export interface ColumnInputSegment {
  key: string
  /** Drawing value only (see `chartNumber`); a segment that is not positive is not drawn. */
  value: number
}
export interface ColumnInput { x: string; segments: readonly ColumnInputSegment[] }
export interface ColumnLayoutOptions {
  width: number
  height: number
  /** Text of a value-axis division; `step` is the step of that axis, the same for all its divisions. */
  formatValue: (value: number, step: number) => string
  /** Short name of a period for the axis. */
  formatTick: (x: string) => string
}
export interface SegmentLayout { key: string; y: number; height: number }
export interface ColumnLayout {
  x: string
  /** Left edge and width of the drawn bar. */
  left: number
  width: number
  /** The whole slot of the period: the target of a pointer is wider than the bar. */
  slotLeft: number
  slotWidth: number
  center: number
  /** Top of the stack; the bottom of the plot for an empty period. */
  top: number
  /** From the bottom up, in the given order. */
  segments: SegmentLayout[]
}
export interface ColumnsLayout {
  width: number
  height: number
  plot: { left: number; right: number; top: number; bottom: number }
  yTicks: AxisTick[]
  xTicks: XTick[]
  columns: ColumnLayout[]
}

const charWidth = 6.6
/** Neighbouring axis texts keep at least this gap. */
const tickGap = 10
/** A bar takes this share of its slot; the rest is the gap between bars. */
export const barShare = 0.64
/** Bars wider than this look like blocks, not columns. */
const maxBarWidth = 56

/** The visible height of a stack: the sum of its positive segments. */
export const stackHeight = (column: ColumnInput) => column.segments.reduce((sum, segment) => sum + (segment.value > 0 ? segment.value : 0), 0)

export function layoutColumns(columns: readonly ColumnInput[], { width, height, formatValue, formatTick }: ColumnLayoutOptions): ColumnsLayout {
  const highest = Math.max(0, ...columns.map(stackHeight))
  const ticks = niceTicks(0, highest, 5, true, minAxisStep)
  const yTexts = ticks.values.map((value) => formatValue(value, ticks.step))
  const left = Math.ceil(Math.max(...yTexts.map((text) => text.length), 1) * charWidth) + 12
  const plot = { left, right: width - 8, top: 10, bottom: height - 28 }
  const y = linearScale([ticks.min, ticks.max], [plot.bottom, plot.top])
  const slot = columns.length ? (plot.right - plot.left) / columns.length : 0
  const bar = Math.min(maxBarWidth, Math.max(2, slot * barShare))

  const laid = columns.map((column, index): ColumnLayout => {
    const slotLeft = plot.left + slot * index
    const center = slotLeft + slot / 2
    let base = 0
    const segments: SegmentLayout[] = []
    for (const segment of column.segments) {
      if (!(segment.value > 0)) continue
      const bottom = y(base)
      base += segment.value
      const top = y(base)
      segments.push({ key: segment.key, y: top, height: bottom - top })
    }
    return { x: column.x, left: center - bar / 2, width: bar, slotLeft, slotWidth: slot, center, top: y(base), segments }
  })

  const texts = columns.map((column) => formatTick(column.x))
  const widest = Math.max(...texts.map((text) => text.length), 1) * charWidth
  const picked = pickTicks(laid.map((column) => column.center), widest + tickGap)
  const xTicks: XTick[] = picked.map((index) => ({ x: laid[index].x, position: laid[index].center, text: texts[index], anchor: 'middle' }))
  return {
    width, height, plot,
    yTicks: ticks.values.map((value, index) => ({ position: y(value), text: yTexts[index] })),
    xTicks,
    columns: laid,
  }
}
