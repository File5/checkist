/** Pure chart arithmetic: linear scales, "nice" axis ticks and calendar periods. No DOM, no formatting. */

export type Pair = readonly [number, number]
export type ChartInterval = 'day' | 'week' | 'month' | 'quarter' | 'year'

/** Drawing coordinate of a Decimal string. Geometry only: money is never added or shown through it. */
export function chartNumber(value: string | null | undefined): number | null {
  if (typeof value !== 'string' || !/^-?\d+(\.\d+)?$/.test(value)) return null
  const number = Number(value)
  return Number.isFinite(number) ? number : null
}

/** A degenerate domain maps every value to the middle of the range instead of dividing by zero. */
export function linearScale([d0, d1]: Pair, [r0, r1]: Pair): (value: number) => number {
  const span = d1 - d0
  if (!Number.isFinite(span) || span === 0) {
    const middle = (r0 + r1) / 2
    return () => middle
  }
  return (value) => r0 + ((value - d0) / span) * (r1 - r0)
}

export interface Ticks { min: number; max: number; step: number; values: number[] }

/** Axis divisions on a 1 / 2 / 2.5 / 5 × 10ⁿ step that cover [min, max]. */
export function niceTicks(min: number, max: number, target = 5, includeZero = false): Ticks {
  let low = Number.isFinite(min) ? min : 0
  let high = Number.isFinite(max) ? max : low
  if (low > high) [low, high] = [high, low]
  if (includeZero) { low = Math.min(low, 0); high = Math.max(high, 0) }
  if (low === high) {
    // One value (or a flat series): open a band around it without crossing zero.
    const pad = low === 0 ? 1 : Math.abs(low) * 0.1
    high = low + pad
    low = low >= 0 ? Math.max(0, low - pad) : low - pad
  }
  const raw = (high - low) / Math.max(1, target)
  const exponent = Math.floor(Math.log10(raw))
  const magnitude = 10 ** exponent
  const normalized = raw / magnitude
  const factor = normalized <= 1 ? 1 : normalized <= 2 ? 2 : normalized <= 2.5 ? 2.5 : normalized <= 5 ? 5 : 10
  const step = factor * magnitude
  const decimals = Math.min(20, Math.max(0, 1 - exponent))
  const round = (value: number) => Number(value.toFixed(decimals))
  const first = Math.floor(low / step + 1e-9)
  const last = Math.ceil(high / step - 1e-9)
  const values = Array.from({ length: last - first + 1 }, (_, index) => round((first + index) * step))
  return { min: values[0], max: values[values.length - 1], step: round(step), values }
}

const isoDate = /^(\d{4})-(\d{2})-(\d{2})$/
const dayMs = 86_400_000

/** Days since the epoch for a real calendar `YYYY-MM-DD`; `null` otherwise. Time zones are not involved. */
export function dayNumber(iso: string): number | null {
  const match = isoDate.exec(iso)
  if (!match) return null
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])]
  const date = new Date(Date.UTC(year, month - 1, day))
  date.setUTCFullYear(year)
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null
  return Math.round(date.getTime() / dayMs)
}

function toIso(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0')
  return `${year}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`
}

/** Start of the period that follows the one starting at `iso`; `null` for an invalid date. */
export function nextPeriodStart(iso: string, interval: ChartInterval): string | null {
  const day = dayNumber(iso)
  if (day === null) return null
  if (interval === 'day' || interval === 'week') return toIso(new Date((day + (interval === 'day' ? 1 : 7)) * dayMs))
  const date = new Date(day * dayMs)
  const months = interval === 'month' ? 1 : interval === 'quarter' ? 3 : 12
  // Period starts are the first day of a month, so adding months cannot overflow a short month.
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, date.getUTCDate()))
  next.setUTCFullYear(date.getUTCFullYear() + Math.floor((date.getUTCMonth() + months) / 12))
  return toIso(next)
}

/** Indices of positions (ascending) to label so that neighbouring labels are at least `minGap` apart. */
export function pickTicks(positions: readonly number[], minGap: number): number[] {
  const picked: number[] = []
  let last = -Infinity
  positions.forEach((position, index) => {
    if (position - last >= minGap) { picked.push(index); last = position }
  })
  return picked
}

/** Index of the position closest to `target`; the earlier one wins a tie. `null` for an empty list. */
export function nearestIndex(positions: readonly number[], target: number): number | null {
  let best: number | null = null
  let distance = Infinity
  positions.forEach((position, index) => {
    const current = Math.abs(position - target)
    if (current < distance) { best = index; distance = current }
  })
  return best
}

/** Two decimals are enough for SVG coordinates and keep the markup stable in tests. */
export function coordinate(value: number): string {
  const rounded = Math.round(value * 100) / 100
  return String(Object.is(rounded, -0) ? 0 : rounded)
}
