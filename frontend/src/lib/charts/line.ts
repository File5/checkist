/** Pure line-chart layout: time axis by `period_start`, value axis with nice ticks, runs broken at gaps. */
import { coordinate as c, dayNumber, linearScale, minAxisStep, nextPeriodStart, niceTicks, pickTicks } from './scale.ts'
import type { ChartInterval } from './scale.ts'

export interface LineInputPoint { x: string; value: number }
export interface LineInputSeries {
  key: string
  points: readonly LineInputPoint[]
  /** Short text drawn at the end of the line. */
  endLabel?: string
}
export interface LineLayoutOptions {
  width: number
  height: number
  /** Step of the time axis. With it, a missing period breaks the line; without it all points are joined. */
  interval?: ChartInterval
  /** Join points across missing periods (never through zero). */
  connectGaps?: boolean
  /** Start the value axis at zero. */
  zeroBaseline?: boolean
  /** Text of a value-axis division; `step` is the step of that axis, the same for all its divisions. */
  formatValue?: (value: number, step: number) => string
  formatTick?: (x: string) => string
}

export const markerShapes = ['circle', 'square', 'triangle', 'diamond', 'triangle-down'] as const
export type MarkerShape = (typeof markerShapes)[number]
export const dashPatterns = ['', '7 4', '2 4', '10 3 2 3'] as const
export const seriesColors = 8

export interface SeriesStyle { color: number; dash: string; shape: MarkerShape }
/** Colour, dash and marker cycle with different periods: 40 slots pass before a combination repeats. */
export function seriesStyle(slot: number): SeriesStyle {
  const index = Number.isSafeInteger(slot) && slot >= 0 ? slot : 0
  return {
    color: (index % seriesColors) + 1,
    dash: dashPatterns[index % dashPatterns.length],
    shape: markerShapes[index % markerShapes.length],
  }
}

export function markerPath(shape: MarkerShape, x: number, y: number, r: number): string {
  switch (shape) {
    case 'square': { const h = r * 0.9; return `M${c(x - h)} ${c(y - h)}H${c(x + h)}V${c(y + h)}H${c(x - h)}Z` }
    case 'triangle': return `M${c(x)} ${c(y - r * 1.15)}L${c(x + r * 1.1)} ${c(y + r * 0.85)}H${c(x - r * 1.1)}Z`
    case 'triangle-down': return `M${c(x)} ${c(y + r * 1.15)}L${c(x + r * 1.1)} ${c(y - r * 0.85)}H${c(x - r * 1.1)}Z`
    case 'diamond': return `M${c(x)} ${c(y - r * 1.25)}L${c(x + r * 1.25)} ${c(y)}L${c(x)} ${c(y + r * 1.25)}L${c(x - r * 1.25)} ${c(y)}Z`
    default: return `M${c(x - r)} ${c(y)}A${c(r)} ${c(r)} 0 1 0 ${c(x + r)} ${c(y)}A${c(r)} ${c(r)} 0 1 0 ${c(x - r)} ${c(y)}Z`
  }
}

export interface LinePointLayout { x: string; value: number; cx: number; cy: number; xIndex: number; marker: boolean }
export interface LineEndLabel { text: string; x: number; y: number; leader: [number, number, number, number] | null }
export interface LineSeriesLayout {
  key: string
  points: LinePointLayout[]
  /** One path per run of adjacent periods with at least two points. */
  segments: string[]
  end: LinePointLayout | null
  label: LineEndLabel | null
}
export interface AxisTick { position: number; text: string }
export interface XTick extends AxisTick { x: string; anchor: 'start' | 'middle' | 'end' }
export interface LineLayout {
  width: number
  height: number
  plot: { left: number; right: number; top: number; bottom: number }
  /** Distinct period starts of the laid out series, ascending: the stops of keyboard navigation. */
  xs: string[]
  xPositions: number[]
  xTicks: XTick[]
  yTicks: AxisTick[]
  series: LineSeriesLayout[]
}

const charWidth = 6.6
const labelHeight = 14
/** Markers on every point only while the line stays readable. */
export const denseSeriesPoints = 16

/** Valid points of a series, ascending by date; a repeated date keeps the last value. */
export function cleanPoints<T extends LineInputPoint>(points: readonly T[]): T[] {
  const byDate = new Map<string, T>()
  for (const point of points) {
    if (dayNumber(point.x) !== null && Number.isFinite(point.value)) byDate.set(point.x, point)
  }
  return [...byDate.values()].sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : 0))
}

/** Distinct valid period starts of several series, ascending. */
export function periodStarts(series: readonly { points: readonly LineInputPoint[] }[]): string[] {
  const all = new Set<string>()
  for (const item of series) for (const point of cleanPoints(item.points)) all.add(point.x)
  return [...all].sort()
}

/** Runs of points with no missing period between neighbours. */
export function splitRuns<T extends { x: string }>(points: readonly T[], interval?: ChartInterval, connectGaps = false): T[][] {
  const runs: T[][] = []
  points.forEach((point, index) => {
    const previous = points[index - 1]
    const expected = previous && interval && !connectGaps ? nextPeriodStart(previous.x, interval) : null
    const adjacent = previous !== undefined && (expected === null || point.x <= expected)
    if (adjacent) runs[runs.length - 1].push(point)
    else runs.push([point])
  })
  return runs
}

export function layoutLineChart(series: readonly LineInputSeries[], options: LineLayoutOptions): LineLayout {
  const { width, height, interval, connectGaps = false, zeroBaseline = false } = options
  const formatValue = options.formatValue ?? ((value: number) => String(value))
  const formatTick = options.formatTick ?? ((x: string) => x)
  const cleaned = series.map((item) => ({ item, points: cleanPoints(item.points) }))
  const values = cleaned.flatMap(({ points }) => points.map((point) => point.value))
  const xs = periodStarts(series)

  const ticks = values.length ? niceTicks(Math.min(...values), Math.max(...values), height < 260 ? 4 : 5, zeroBaseline, minAxisStep) : niceTicks(0, 1)
  const tickTexts = ticks.values.map((value) => formatValue(value, ticks.step))
  const endTexts = cleaned.map(({ item, points }) => (points.length ? item.endLabel ?? '' : ''))
  const longestEnd = Math.max(0, ...endTexts.map((text) => text.length))
  const plot = {
    left: Math.min(width * 0.3, Math.max(36, Math.max(...tickTexts.map((text) => text.length)) * charWidth + 12)),
    right: width - Math.min(width * 0.3, longestEnd ? 16 + longestEnd * charWidth : 12),
    top: 12,
    bottom: height - 30,
  }
  const days = xs.map((x) => dayNumber(x) as number)
  const scaleX = linearScale([days[0] ?? 0, days[days.length - 1] ?? 0], [plot.left + 8, plot.right - 8])
  const scaleY = linearScale([ticks.min, ticks.max], [plot.bottom, plot.top])
  const xPositions = days.map(scaleX)
  const xIndex = new Map(xs.map((x, index) => [x, index]))

  const tickGap = Math.max(...xs.map((x) => formatTick(x).length), 4) * charWidth + 14
  const xTicks = pickTicks(xPositions, tickGap).map((index): XTick => {
    const text = formatTick(xs[index])
    const half = (text.length * charWidth) / 2
    const position = xPositions[index]
    const anchor = position - half < 0 ? 'start' : position + half > width ? 'end' : 'middle'
    return { x: xs[index], position, text, anchor }
  })

  const laidOut = cleaned.map(({ item, points }, seriesIndex): LineSeriesLayout => {
    const runs = splitRuns(points, interval, connectGaps)
    const showAll = points.length <= denseSeriesPoints
    const placed = runs.map((run) => run.map((point, index): LinePointLayout => {
      const position = xIndex.get(point.x) as number
      return {
        x: point.x, value: point.value, cx: xPositions[position], cy: scaleY(point.value), xIndex: position,
        // A lone point has no line of its own: without a marker it would be invisible.
        marker: showAll || run.length === 1 || index === 0 || index === run.length - 1,
      }
    }))
    const flat = placed.flat()
    const end = flat[flat.length - 1] ?? null
    return {
      key: item.key,
      points: flat,
      segments: placed.filter((run) => run.length > 1).map((run) => run.map((point, index) => `${index ? 'L' : 'M'}${c(point.cx)} ${c(point.cy)}`).join('')),
      end,
      label: end && endTexts[seriesIndex] ? { text: endTexts[seriesIndex], x: end.cx + 9, y: end.cy, leader: null } : null,
    }
  })
  spreadEndLabels(laidOut, plot.top + 6, plot.bottom - 2)

  return {
    width, height, plot, xs, xPositions, xTicks,
    yTicks: ticks.values.map((value, index) => ({ position: scaleY(value), text: tickTexts[index] })),
    series: laidOut,
  }
}

/** Moves overlapping end labels apart vertically and links a moved label to its line end. */
function spreadEndLabels(series: LineSeriesLayout[], top: number, bottom: number): void {
  const labels = series.flatMap((item) => (item.label && item.end ? [{ label: item.label, end: item.end }] : []))
    .sort((a, b) => a.label.y - b.label.y || a.label.x - b.label.x)
  const overlaps = (a: LineEndLabel, b: LineEndLabel) =>
    a.x < b.x + b.text.length * charWidth + 4 && b.x < a.x + a.text.length * charWidth + 4
  const placed: LineEndLabel[] = []
  for (const { label } of labels) {
    label.y = Math.max(top, label.y)
    for (const other of placed) {
      if (overlaps(label, other) && label.y < other.y + labelHeight) label.y = other.y + labelHeight
    }
    placed.push(label)
  }
  // Pushed below the plot: move the tail of the column back up, keeping the spacing.
  for (let index = placed.length - 1; index >= 0; index -= 1) {
    const label = placed[index]
    let limit = bottom
    for (const lower of placed.slice(index + 1)) {
      if (overlaps(label, lower)) limit = Math.min(limit, lower.y - labelHeight)
    }
    label.y = Math.min(label.y, limit)
  }
  for (const { label, end } of labels) {
    if (Math.abs(label.y - end.cy) > 3) label.leader = [end.cx + 5, end.cy, label.x - 2, label.y]
  }
}
