/** Pure pie/donut geometry. Angles are radians, clockwise from 12 o'clock. */
import { coordinate as c } from './scale.ts'

export const fullTurn = Math.PI * 2
/** A sector below this share is named only in the legend. */
export const minLabelShare = 0.02

export interface PieInput { key: string; value: number }
export interface PieGeometry { cx: number; cy: number; outer: number; inner: number }
export interface PieSlice {
  key: string
  /** Index of the item in the input list (items that are not drawn keep their index). */
  index: number
  value: number
  /** 0..1 of the sum of the drawn (positive) values. */
  share: number
  start: number
  end: number
  mid: number
  path: string
  /** `false` for a sector too thin to carry its own label. */
  labeled: boolean
}

export function polar(cx: number, cy: number, radius: number, angle: number): [number, number] {
  return [cx + Math.sin(angle) * radius, cy - Math.cos(angle) * radius]
}

/** Ring sector; a full turn becomes two closed circles, because an arc cannot end where it starts. */
export function arcPath({ cx, cy, outer, inner }: PieGeometry, start: number, end: number): string {
  if (end - start >= fullTurn - 1e-9) {
    const circle = (radius: number, sweep: 0 | 1) =>
      `M${c(cx)} ${c(cy - radius)}A${c(radius)} ${c(radius)} 0 1 ${sweep} ${c(cx)} ${c(cy + radius)}`
      + `A${c(radius)} ${c(radius)} 0 1 ${sweep} ${c(cx)} ${c(cy - radius)}Z`
    return circle(outer, 1) + (inner > 0 ? circle(inner, 0) : '')
  }
  const large = end - start > Math.PI ? 1 : 0
  const [x0, y0] = polar(cx, cy, outer, start)
  const [x1, y1] = polar(cx, cy, outer, end)
  const outerArc = `M${c(x0)} ${c(y0)}A${c(outer)} ${c(outer)} 0 ${large} 1 ${c(x1)} ${c(y1)}`
  if (inner <= 0) return `${outerArc}L${c(cx)} ${c(cy)}Z`
  const [x2, y2] = polar(cx, cy, inner, end)
  const [x3, y3] = polar(cx, cy, inner, start)
  return `${outerArc}L${c(x2)} ${c(y2)}A${c(inner)} ${c(inner)} 0 ${large} 0 ${c(x3)} ${c(y3)}Z`
}

/** Sectors in input order. Non-positive and non-finite values are not drawn. */
export function pieSlices(items: readonly PieInput[], geometry: PieGeometry): PieSlice[] {
  const drawn = items
    .map((item, index) => ({ ...item, index }))
    .filter((item) => Number.isFinite(item.value) && item.value > 0)
  const total = drawn.reduce((sum, item) => sum + item.value, 0)
  if (!(total > 0) || !Number.isFinite(total)) return []
  let accumulated = 0
  return drawn.map((item, position) => {
    const start = (accumulated / total) * fullTurn
    accumulated += item.value
    // The last sector closes the circle exactly, whatever the rounding of the running sum.
    const end = position === drawn.length - 1 ? fullTurn : (accumulated / total) * fullTurn
    const share = item.value / total
    return {
      key: item.key, index: item.index, value: item.value, share, start, end, mid: (start + end) / 2,
      path: arcPath(geometry, start, end), labeled: share >= minLabelShare,
    }
  })
}

export interface PieLabelArea { cx: number; cy: number; outer: number; radius: number; lineHeight: number; top: number; bottom: number }
export interface PieLabel {
  key: string
  side: 'left' | 'right'
  x: number
  y: number
  anchor: 'start' | 'end'
  /** Leader from the sector edge to the label. */
  line: [number, number, number, number]
}

/**
 * Outside labels in two columns. Labels of one side keep `lineHeight` between them; when a side cannot
 * hold all of them, the smallest sectors lose the label (they are still in the legend).
 */
export function layoutPieLabels(slices: readonly PieSlice[], area: PieLabelArea): PieLabel[] {
  const { cx, cy, outer, radius, lineHeight, top, bottom } = area
  const capacity = Math.max(1, Math.floor((bottom - top) / lineHeight) + 1)
  const labels: PieLabel[] = []
  for (const side of ['right', 'left'] as const) {
    let column = slices.filter((slice) => slice.labeled && (Math.sin(slice.mid) >= 0 ? 'right' : 'left') === side)
    if (column.length > capacity) {
      const kept = new Set([...column].sort((a, b) => b.share - a.share || a.index - b.index).slice(0, capacity).map((slice) => slice.key))
      column = column.filter((slice) => kept.has(slice.key))
    }
    const placed = column
      .map((slice) => ({ slice, y: Math.min(bottom, Math.max(top, polar(cx, cy, radius, slice.mid)[1])) }))
      .sort((a, b) => a.y - b.y || a.slice.index - b.slice.index)
    for (let index = 1; index < placed.length; index += 1) {
      placed[index].y = Math.max(placed[index].y, placed[index - 1].y + lineHeight)
    }
    for (let index = placed.length - 1; index >= 0; index -= 1) {
      const limit = index === placed.length - 1 ? bottom : placed[index + 1].y - lineHeight
      placed[index].y = Math.min(placed[index].y, limit)
    }
    const direction = side === 'right' ? 1 : -1
    for (const { slice, y } of placed) {
      const dy = y - cy
      const reach = Math.abs(dy) < radius ? Math.sqrt(radius * radius - dy * dy) : 0
      const x = cx + direction * Math.max(reach, 6)
      const [fromX, fromY] = polar(cx, cy, outer + 2, slice.mid)
      labels.push({ key: slice.key, side, x, y, anchor: side === 'right' ? 'start' : 'end', line: [fromX, fromY, x - direction * 3, y] })
    }
  }
  return labels
}

export type PieToneName = 'series' | 'other' | 'muted'
export interface PieTone { className: string; hatched: boolean }

/**
 * Fill of each item. The colour follows the position among ordinary items, so a special row never shifts
 * the palette; past the available hues the palette repeats with a hatch, never with a generated colour.
 */
export function pieTones(tones: readonly (PieToneName | undefined)[], colors: number): PieTone[] {
  let ordinary = 0
  return tones.map((tone = 'series') => {
    if (tone !== 'series') return { className: `ck-chart-${tone}`, hatched: tone === 'muted' }
    const slot = ordinary
    ordinary += 1
    return { className: `ck-chart-c${(slot % colors) + 1}`, hatched: slot >= colors }
  })
}
