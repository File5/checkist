import { describe, expect, it } from 'vitest'
import { chartNumber, coordinate, dayNumber, linearScale, nearestIndex, nextPeriodStart, niceTicks, pickTicks } from './scale'
import { arcPath, fullTurn, layoutPieLabels, pieSlices, pieTones, polar } from './pie'
import { cleanPoints, layoutLineChart, markerPath, markerShapes, periodStarts, seriesStyle, splitRuns } from './line'

describe('scales and axis divisions', () => {
  it('reads a Decimal string as a drawing coordinate and rejects anything else', () => {
    expect(chartNumber('412.30')).toBe(412.3)
    expect(chartNumber('-2.50')).toBe(-2.5)
    expect(chartNumber('0')).toBe(0)
    for (const bad of ['', 'abc', '1e5', '1,5', ' 1', '.5', null, undefined]) expect(chartNumber(bad)).toBeNull()
  })
  it('maps a domain onto a range, also inverted, and survives a degenerate domain', () => {
    expect(linearScale([0, 10], [0, 100])(2.5)).toBe(25)
    expect(linearScale([10, 30], [270, 12])(20)).toBe(141)
    expect(linearScale([5, 5], [0, 100])(5)).toBe(50)
    expect(linearScale([0, Infinity], [0, 100])(3)).toBe(50)
  })
  it('chooses 1 / 2 / 2.5 / 5 steps that cover the data', () => {
    expect(niceTicks(27.4, 45.5).values).toEqual([25, 30, 35, 40, 45, 50])
    expect(niceTicks(0, 13041.07).values).toEqual([0, 5000, 10000, 15000])
    expect(niceTicks(-2.5, 7.5).values).toEqual([-4, -2, 0, 2, 4, 6, 8])
    expect(niceTicks(27.4, 45.5, 5, true).values).toEqual([0, 10, 20, 30, 40, 50])
    expect(niceTicks(45.5, 27.4)).toEqual(niceTicks(27.4, 45.5))
  })
  it('keeps small steps free of floating-point tails', () => {
    const ticks = niceTicks(1.05, 1.09)
    expect(ticks.values).toEqual([1.05, 1.06, 1.07, 1.08, 1.09])
    expect(ticks.step).toBe(0.01)
    expect(niceTicks(0.1, 0.3).values).toEqual([0.1, 0.15, 0.2, 0.25, 0.3])
  })
  it('opens a band around a single value without crossing zero', () => {
    const flat = niceTicks(5, 5)
    expect(flat.min).toBeLessThan(5)
    expect(flat.max).toBeGreaterThan(5)
    expect(flat.min).toBeGreaterThanOrEqual(0)
    expect(niceTicks(0, 0)).toMatchObject({ min: 0, max: 1 })
    expect(niceTicks(-3, -3).max).toBeLessThanOrEqual(0)
    expect(niceTicks(NaN, NaN)).toMatchObject({ min: 0, max: 1 })
  })
  it('counts calendar days and refuses dates that do not exist', () => {
    expect(dayNumber('1970-01-01')).toBe(0)
    expect(dayNumber('1970-01-02')).toBe(1)
    expect(dayNumber('2024-02-29')).toBe(dayNumber('2024-02-28')! + 1)
    for (const bad of ['2026-02-29', '2026-13-01', '2026-1-01', '2026-01-32', '2026-01-01T00:00:00Z', '']) expect(dayNumber(bad)).toBeNull()
  })
  it('steps to the next period of each interval', () => {
    expect(nextPeriodStart('2026-01-31', 'day')).toBe('2026-02-01')
    expect(nextPeriodStart('2026-12-28', 'week')).toBe('2027-01-04')
    expect(nextPeriodStart('2026-12-01', 'month')).toBe('2027-01-01')
    expect(nextPeriodStart('2026-02-01', 'month')).toBe('2026-03-01')
    expect(nextPeriodStart('2026-10-01', 'quarter')).toBe('2027-01-01')
    expect(nextPeriodStart('2020-01-01', 'year')).toBe('2021-01-01')
    expect(nextPeriodStart('nope', 'month')).toBeNull()
  })
  it('thins axis labels by distance and finds the nearest interval', () => {
    expect(pickTicks([0, 10, 50, 55, 120], 40)).toEqual([0, 2, 4])
    expect(pickTicks([], 40)).toEqual([])
    expect(nearestIndex([10, 20, 30], 24)).toBe(1)
    expect(nearestIndex([10, 20, 30], 25)).toBe(1)
    expect(nearestIndex([10, 20, 30], -100)).toBe(0)
    expect(nearestIndex([10, 20, 30], 999)).toBe(2)
    expect(nearestIndex([], 5)).toBeNull()
  })
  it('prints coordinates with two decimals and no negative zero', () => {
    expect(coordinate(12.3456)).toBe('12.35')
    expect(coordinate(-0.001)).toBe('0')
  })
})

describe('pie geometry', () => {
  const disc = { cx: 100, cy: 100, outer: 50, inner: 0 }
  const ring = { ...disc, inner: 20 }

  it('places angles clockwise from 12 o’clock', () => {
    expect(polar(100, 100, 50, 0)).toEqual([100, 50])
    const [x, y] = polar(100, 100, 50, Math.PI / 2)
    expect(x).toBeCloseTo(150)
    expect(y).toBeCloseTo(100)
  })
  it('splits the circle in proportion to the values', () => {
    const [first, second] = pieSlices([{ key: 'a', value: 5 }, { key: 'b', value: 5 }], disc)
    expect([first.start, first.end, second.start, second.end]).toEqual([0, Math.PI, Math.PI, fullTurn])
    expect(first.share).toBe(0.5)
    expect(first.path).toBe('M100 50A50 50 0 0 1 100 150L100 100Z')
    expect(second.path).toBe('M100 150A50 50 0 0 1 100 50L100 100Z')
  })
  it('draws a ring sector with both arcs and the large-arc flag past a half turn', () => {
    const [quarter, rest] = pieSlices([{ key: 'a', value: 1 }, { key: 'b', value: 3 }], ring)
    expect(quarter.path).toBe('M100 50A50 50 0 0 1 150 100L120 100A20 20 0 0 0 100 80Z')
    expect(rest.path).toBe('M150 100A50 50 0 1 1 100 50L100 80A20 20 0 1 0 120 100Z')
  })
  it('draws a single 100 % sector as closed circles, not as a zero-length arc', () => {
    const [only] = pieSlices([{ key: 'all', value: 7 }], ring)
    expect(only).toMatchObject({ share: 1, start: 0, end: fullTurn, labeled: true })
    expect(only.path).toBe('M100 50A50 50 0 1 1 100 150A50 50 0 1 1 100 50ZM100 80A20 20 0 1 0 100 120A20 20 0 1 0 100 80Z')
    expect(arcPath(disc, 0, fullTurn)).toBe('M100 50A50 50 0 1 1 100 150A50 50 0 1 1 100 50Z')
  })
  it('leaves non-positive and non-numeric values out and keeps the input index of the rest', () => {
    const slices = pieSlices([
      { key: 'a', value: 10 }, { key: 'zero', value: 0 }, { key: 'refund', value: -5 }, { key: 'nan', value: NaN }, { key: 'e', value: 30 },
    ], disc)
    expect(slices.map((slice) => [slice.key, slice.index, slice.share])).toEqual([['a', 0, 0.25], ['e', 4, 0.75]])
    expect(pieSlices([], disc)).toEqual([])
    expect(pieSlices([{ key: 'refund', value: -5 }, { key: 'zero', value: 0 }], disc)).toEqual([])
  })
  it('closes the circle exactly whatever the rounding of the sum', () => {
    const slices = pieSlices([0.1, 0.2, 0.3, 0.7].map((value, index) => ({ key: String(index), value })), disc)
    expect(slices[slices.length - 1].end).toBe(fullTurn)
    slices.slice(1).forEach((slice, index) => expect(slice.start).toBe(slices[index].end))
  })
  it('labels a sector on the chart only from 2 %', () => {
    const slices = pieSlices([{ key: 'big', value: 97 }, { key: 'two', value: 2 }, { key: 'one', value: 1 }], disc)
    expect(slices.map((slice) => slice.labeled)).toEqual([true, true, false])
  })

  const area = { cx: 160, cy: 120, outer: 76, radius: 90, lineHeight: 15, top: 12, bottom: 228 }
  const columns = (labels: ReturnType<typeof layoutPieLabels>) => (['right', 'left'] as const)
    .map((side) => labels.filter((label) => label.side === side).map((label) => label.y).sort((a, b) => a - b))

  it('keeps crowded outside labels apart, inside the drawing and on their own side', () => {
    const items = [...Array.from({ length: 6 }, (_, index) => ({ key: `thin${index}`, value: 2.5 })), { key: 'big', value: 85 }]
    const slices = pieSlices(items, { ...area, inner: 46 })
    const labels = layoutPieLabels(slices, area)
    expect(labels).toHaveLength(7)
    for (const column of columns(labels)) {
      column.slice(1).forEach((y, index) => expect(y - column[index]).toBeGreaterThanOrEqual(15 - 1e-9))
      column.forEach((y) => { expect(y).toBeGreaterThanOrEqual(12); expect(y).toBeLessThanOrEqual(228) })
    }
    for (const label of labels) {
      expect(label.anchor).toBe(label.side === 'right' ? 'start' : 'end')
      // A label never lands inside the ring.
      expect(Math.hypot(label.x - 160, label.y - 120)).toBeGreaterThanOrEqual(90 - 1e-6)
    }
    expect(labels.filter((label) => label.key.startsWith('thin')).every((label) => label.side === 'right')).toBe(true)
  })
  it('drops the smallest labels when a side cannot hold them and never labels a thin sector', () => {
    const many = pieSlices(Array.from({ length: 40 }, (_, index) => ({ key: `s${index}`, value: index === 0 ? 3 : 2.5 })), { ...area, inner: 46 })
    const tight = { ...area, top: 60, bottom: 180 }
    const labels = layoutPieLabels(many, tight)
    expect(labels.length).toBe(18)
    expect(labels.some((label) => label.key === 's0')).toBe(true)
    for (const column of columns(labels)) column.slice(1).forEach((y, index) => expect(y - column[index]).toBeGreaterThanOrEqual(15 - 1e-9))
    const thin = pieSlices([{ key: 'big', value: 99 }, { key: 'thin', value: 1 }], { ...area, inner: 46 })
    expect(layoutPieLabels(thin, area).map((label) => label.key)).toEqual(['big'])
  })
})

describe('line layout', () => {
  const size = { width: 640, height: 300 }
  const months = (values: Record<string, number>) => Object.entries(values).map(([month, value]) => ({ x: `2026-${month}-01`, value }))

  it('varies colour, dash and marker so that 40 slots stay distinct without colour alone', () => {
    expect(seriesStyle(0)).toEqual({ color: 1, dash: '', shape: 'circle' })
    expect(seriesStyle(1)).toEqual({ color: 2, dash: '7 4', shape: 'square' })
    expect(seriesStyle(8).color).toBe(1)
    expect(seriesStyle(8).shape).not.toBe(seriesStyle(0).shape)
    const combos = new Set(Array.from({ length: 40 }, (_, slot) => JSON.stringify(seriesStyle(slot))))
    expect(combos.size).toBe(40)
    // The first eight differ by dash or marker even when the colours are indistinguishable.
    const withoutColour = new Set(Array.from({ length: 8 }, (_, slot) => `${seriesStyle(slot).dash}|${seriesStyle(slot).shape}`))
    expect(withoutColour.size).toBe(8)
    expect(seriesStyle(-1)).toEqual(seriesStyle(0))
    for (const shape of markerShapes) expect(markerPath(shape, 10, 10, 4)).toMatch(/^M[\d. -]+.*Z$/)
  })
  it('sorts points, drops invalid ones and keeps the last value of a repeated date', () => {
    const points = cleanPoints([
      { x: '2026-03-01', value: 3 }, { x: '2026-01-01', value: 1 }, { x: '2026-02-30', value: 9 },
      { x: '2026-02-01', value: NaN }, { x: '2026-01-01', value: 4 },
    ])
    expect(points).toEqual([{ x: '2026-01-01', value: 4 }, { x: '2026-03-01', value: 3 }])
    expect(periodStarts([{ points }, { points: [{ x: '2025-12-01', value: 1 }, { x: '2026-03-01', value: 2 }] }]))
      .toEqual(['2025-12-01', '2026-01-01', '2026-03-01'])
  })
  it('breaks a line where a period is missing', () => {
    const points = months({ '01': 1, '02': 2, '04': 3, '05': 4, '09': 5 })
    const xs = (runs: { x: string }[][]) => runs.map((run) => run.map((point) => point.x.slice(5, 7)))
    expect(xs(splitRuns(points, 'month'))).toEqual([['01', '02'], ['04', '05'], ['09']])
    expect(xs(splitRuns(points, 'quarter'))).toEqual([['01', '02', '04', '05'], ['09']])
    expect(xs(splitRuns(points))).toEqual([['01', '02', '04', '05', '09']])
    expect(xs(splitRuns(points, 'month', true))).toEqual([['01', '02', '04', '05', '09']])
    expect(splitRuns([], 'month')).toEqual([])
  })

  const layout = layoutLineChart([
    { key: 'a', endLabel: '1', points: months({ '01': 10, '02': 20, '04': 30 }) },
    { key: 'b', endLabel: '2', points: months({ '03': 15 }) },
  ], { ...size, interval: 'month' })

  it('lays the time axis out by date and the value axis by nice divisions', () => {
    expect(layout.xs).toEqual(['2026-01-01', '2026-02-01', '2026-03-01', '2026-04-01'])
    expect(layout.plot).toMatchObject({ top: 12, bottom: 270, left: 36 })
    expect(layout.plot.right).toBeCloseTo(640 - 16 - 6.6)
    expect(layout.yTicks.map((tick) => tick.text)).toEqual(['10', '15', '20', '25', '30'])
    expect(layout.yTicks[0].position).toBe(270)
    expect(layout.yTicks[4].position).toBe(12)
    const [first, february, , last] = layout.xPositions
    expect(first).toBe(layout.plot.left + 8)
    expect(last).toBeCloseTo(layout.plot.right - 8)
    // January has 31 of the 90 days between the first and the last period start.
    expect((february - first) / (last - first)).toBeCloseTo(31 / 90)
    expect(layout.xTicks.map((tick) => tick.x)).toEqual(layout.xs)
  })
  it('does not join points across a gap and shows a lone point as a marker', () => {
    const [a, b] = layout.series
    expect(a.segments).toHaveLength(1)
    expect(a.segments[0]).toBe(`M${coordinate(a.points[0].cx)} 270L${coordinate(a.points[1].cx)} 141`)
    expect(a.points.map((point) => [point.xIndex, point.cy, point.marker])).toEqual([[0, 270, true], [1, 141, true], [3, 12, true]])
    expect(b.segments).toEqual([])
    expect(b.points).toHaveLength(1)
    expect(b.points[0]).toMatchObject({ xIndex: 2, marker: true })
    // Nothing is drawn at the missing periods: no point of series a at March, none of series b elsewhere.
    expect(a.points.some((point) => point.xIndex === 2)).toBe(false)
  })
  it('joins across the gap only when asked to', () => {
    const joined = layoutLineChart([{ key: 'a', points: months({ '01': 10, '02': 20, '04': 30 }) }], { ...size, interval: 'month', connectGaps: true })
    expect(joined.series[0].segments).toHaveLength(1)
    expect(joined.series[0].segments[0].match(/L/g)).toHaveLength(2)
  })
  it('puts a label at the end of each line and separates labels that would overlap', () => {
    const [a, b] = layout.series
    expect(a.label).toMatchObject({ text: '1', y: 12 + 6, x: a.end!.cx + 9 })
    expect(b.label).toMatchObject({ text: '2', leader: null })
    const close = layoutLineChart([
      { key: 'a', endLabel: 'Lidl', points: months({ '01': 10, '02': 20 }) },
      { key: 'b', endLabel: 'Aldi', points: months({ '01': 12, '02': 20.2 }) },
      { key: 'c', endLabel: 'Rewe', points: months({ '01': 30, '02': 19.9 }) },
    ], { ...size, interval: 'month' })
    const ys = close.series.map((item) => item.label!.y).sort((x, y) => x - y)
    expect(ys[1] - ys[0]).toBeGreaterThanOrEqual(14)
    expect(ys[2] - ys[1]).toBeGreaterThanOrEqual(14)
    expect(close.series.filter((item) => item.label!.leader !== null).length).toBeGreaterThanOrEqual(1)
    ys.forEach((y) => expect(y).toBeLessThanOrEqual(close.plot.bottom))
    // The gutter grows with the longest label.
    expect(close.plot.right).toBeCloseTo(640 - 16 - 4 * 6.6)
  })
  it('marks only the ends of a long run', () => {
    const long = layoutLineChart([{ key: 'a', points: Array.from({ length: 20 }, (_, index) => ({ x: `2026-01-${String(index + 1).padStart(2, '0')}`, value: index })) }], { ...size, interval: 'day' })
    expect(long.series[0].points.filter((point) => point.marker).map((point) => point.xIndex)).toEqual([0, 19])
    expect(long.xTicks.length).toBeLessThan(20)
    long.xTicks.slice(1).forEach((tick, index) => expect(tick.position - long.xTicks[index].position).toBeGreaterThan(10 * 6.6))
  })
  it('centres a single interval, respects a zero baseline and the formatters', () => {
    const one = layoutLineChart([{ key: 'a', points: months({ '06': 111 }) }], { ...size, zeroBaseline: true, formatValue: (value) => `${value} ₽`, formatTick: () => 'июнь' })
    expect(one.xPositions).toEqual([(one.plot.left + one.plot.right) / 2])
    expect(one.yTicks[0].text).toBe('0 ₽')
    expect(one.yTicks[0].position).toBe(one.plot.bottom)
    expect(one.xTicks).toEqual([{ x: '2026-06-01', position: one.xPositions[0], text: 'июнь', anchor: 'middle' }])
    expect(one.series[0].segments).toEqual([])
    expect(one.series[0].points[0].marker).toBe(true)
  })
  it('lays out an empty chart and a narrow one without errors', () => {
    const empty = layoutLineChart([], size)
    expect(empty).toMatchObject({ xs: [], xPositions: [], xTicks: [], series: [] })
    expect(empty.yTicks.length).toBeGreaterThan(1)
    const narrow = layoutLineChart([{ key: 'a', endLabel: 'Очень длинная подпись магазина', points: months({ '01': 1234567.89, '02': 2 }) }], { width: 240, height: 240, formatValue: (value) => value.toFixed(2) })
    expect(narrow.plot.left).toBeLessThanOrEqual(240 * 0.3)
    expect(narrow.plot.right).toBeGreaterThanOrEqual(240 * 0.7)
    expect(narrow.plot.right - narrow.plot.left).toBeGreaterThan(90)
  })
})

describe('pie fills', () => {
  it('gives ordinary items the palette in order and special rows neutral tones that do not shift it', () => {
    expect(pieTones(['series', 'muted', undefined, 'other', 'series'], 8)).toEqual([
      { className: 'ck-chart-c1', hatched: false }, { className: 'ck-chart-muted', hatched: true },
      { className: 'ck-chart-c2', hatched: false }, { className: 'ck-chart-other', hatched: false },
      { className: 'ck-chart-c3', hatched: false },
    ])
  })
  it('repeats the palette with a hatch instead of inventing a ninth colour', () => {
    const tones = pieTones(Array.from({ length: 10 }, () => undefined), 8)
    expect(tones[7]).toEqual({ className: 'ck-chart-c8', hatched: false })
    expect(tones[8]).toEqual({ className: 'ck-chart-c1', hatched: true })
    expect(tones[9]).toEqual({ className: 'ck-chart-c2', hatched: true })
  })
})
