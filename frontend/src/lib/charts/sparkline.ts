/** A sparkline as one SVG path: values left to right on a fixed box, the scale from zero (or the lowest value below it). */
import { coordinate as c, linearScale } from './scale.ts'

export interface Sparkline {
  /** The line through every value. */
  line: string
  /** The last point: drawn as a dot so the current month is visible. */
  last: { x: number; y: number } | null
}

export function sparkline(values: readonly number[], width: number, height: number, pad = 2): Sparkline {
  const finite = values.map((value) => (Number.isFinite(value) ? value : 0))
  if (finite.length === 0) return { line: '', last: null }
  const low = Math.min(0, ...finite)
  const high = Math.max(...finite)
  const x = linearScale([0, Math.max(1, finite.length - 1)], [pad, width - pad])
  // A flat zero line lies on the bottom, not in the middle.
  const y = high === low ? () => height - pad : linearScale([low, high], [height - pad, pad])
  const points = finite.map((value, index) => [x(finite.length === 1 ? 0.5 : index), y(value)] as const)
  const line = points.map(([px, py], index) => `${index === 0 ? 'M' : 'L'}${c(px)} ${c(py)}`).join('')
  const [lx, ly] = points[points.length - 1]
  return { line, last: { x: lx, y: ly } }
}
