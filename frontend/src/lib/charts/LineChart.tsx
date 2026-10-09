import { Fragment, useId, useMemo, useReducer } from 'react'
import type { KeyboardEvent, PointerEvent } from 'react'
import { cleanPoints, layoutLineChart, markerPath, periodStarts, seriesStyle } from './line.ts'
import type { SeriesStyle } from './line.ts'
import { usePlotWidth } from './plot-width.ts'
import { coordinate as c, nearestIndex } from './scale.ts'
import type { ChartInterval } from './scale.ts'
import { activeLineX, initialLineSelection, lineKeyCommand, lineReadout, lineSelectionReducer, lineTooltipAnchor } from './selection.ts'
import './Charts.css'

export interface LineChartPoint {
  /** `period_start` of the interval, `YYYY-MM-DD`. */
  x: string
  /** Drawing value only (see `chartNumber`). */
  value: number
  /** Formatted by the caller, with currency and unit: shown in the tooltip, the live line and the table. */
  valueText: string
}
export interface LineChartSeries {
  key: string
  label: string
  /** Only intervals that have data; a missing interval is a gap, not a zero. */
  points: readonly LineChartPoint[]
  /** Short text at the end of the line and in the legend; the series number by default. */
  shortLabel?: string
  /** Small text after the name in the legend, e.g. «похожий товар · RU». */
  note?: string
  /** Fixed style slot (colour, dash, marker); the position in `series` by default. */
  slot?: number
}
export interface LineChartProps {
  /** Names the chart for assistive technology and captions the table. */
  title: string
  series: readonly LineChartSeries[]
  /** Step of the time axis: with it a missing interval breaks the line. */
  interval?: ChartInterval
  connectGaps?: boolean
  zeroBaseline?: boolean
  /** Full name of an interval: tooltip, live line, table. */
  formatX: (x: string) => string
  /** Short name for the axis; `formatX` by default. */
  formatTick?: (x: string) => string
  /** Value-axis divisions. */
  formatValue: (value: number) => string
  /** Unit of the value axis, e.g. «EUR/л». */
  valueAxisLabel?: string
  /** Series switched off at first. Later changes belong to the legend. */
  defaultHiddenKeys?: readonly string[]
  onHiddenChange?: (hiddenKeys: readonly string[]) => void
  emptyMessage?: string
  intervalHeader?: string
}

const plotWidth = { fallback: 640, min: 240, max: 1200 }
const heightFor = (width: number) => (width < 420 ? 240 : 300)

/** A text wraps only at its ordinary spaces: «2,99 EUR/кг» and «01.09.2026» stay whole, though «/» and the
    inherited `overflow-wrap: anywhere` would allow a break inside them. */
function wholeWords(text: string) {
  return text.split(' ').map((word, index) => (
    <Fragment key={index}>{index > 0 && ' '}<span className="ck-chart-whole">{word}</span></Fragment>
  ))
}

function Swatch({ style }: { style: SeriesStyle }) {
  return (
    <svg className={`ck-line-swatch ck-chart-c${style.color}`} viewBox="0 0 34 14" aria-hidden="true" focusable="false">
      <path className="ck-line-path" d="M1 7H33" strokeDasharray={style.dash || undefined} />
      <path className="ck-line-marker" d={markerPath(style.shape, 17, 7, 3.6)} />
    </svg>
  )
}

export default function LineChart({
  title, series, interval, connectGaps, zeroBaseline, formatX, formatTick, formatValue, valueAxisLabel,
  defaultHiddenKeys, onHiddenChange, emptyMessage = 'Нет данных для графика.', intervalHeader = 'Интервал',
}: LineChartProps) {
  const hintId = useId()
  const [plotRef, width] = usePlotWidth<HTMLDivElement>(plotWidth)
  const [selection, dispatch] = useReducer(lineSelectionReducer, defaultHiddenKeys, initialLineSelection)

  const described = useMemo(() => series.map((item, index) => ({
    item,
    points: cleanPoints(item.points),
    style: seriesStyle(item.slot ?? index),
    endLabel: item.shortLabel ?? String(index + 1),
  })).filter((entry) => entry.points.length > 0), [series])
  const visible = useMemo(() => described.filter((entry) => !selection.hidden.includes(entry.item.key)), [described, selection.hidden])
  const height = heightFor(width)
  const layout = useMemo(() => layoutLineChart(
    visible.map((entry) => ({ key: entry.item.key, points: entry.points, endLabel: entry.endLabel })),
    { width, height, interval, connectGaps, zeroBaseline, formatValue, formatTick: formatTick ?? formatX },
  ), [visible, width, height, interval, connectGaps, zeroBaseline, formatValue, formatTick, formatX])

  if (described.length === 0) return <p className="ck-chart ck-chart-empty">{emptyMessage}</p>

  const activeX = activeLineX(selection, layout.xs)
  const activeIndex = activeX === null ? -1 : layout.xs.indexOf(activeX)
  const activePosition = activeIndex === -1 ? null : layout.xPositions[activeIndex]
  const valuesOf = (entry: (typeof described)[number]) => new Map(entry.points.map((point) => [point.x, point.valueText]))
  const readoutSeries = visible.map((entry) => ({ label: entry.item.label, style: entry.style, values: valuesOf(entry) }))
  const readout = lineReadout(activeX, readoutSeries, formatX)
  const allXs = periodStarts(described)

  const toggle = (key: string) => {
    const next = lineSelectionReducer(selection, { type: 'toggle', key })
    dispatch({ type: 'toggle', key })
    onHiddenChange?.(next.hidden)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey) return
    const command = lineKeyCommand(event.key)
    if (command === null) return
    // Escape without a selection stays available to whatever encloses the chart.
    if (command === 'clear' && activeX === null) return
    event.preventDefault()
    dispatch({ type: 'key', command, xs: layout.xs })
  }
  const onPointer = (event: PointerEvent<HTMLDivElement>) => {
    const box = event.currentTarget.getBoundingClientRect()
    if (!(box.width > 0)) return
    const index = nearestIndex(layout.xPositions, ((event.clientX - box.left) / box.width) * layout.width)
    dispatch({ type: 'pointer', x: index === null ? null : layout.xs[index], touch: event.pointerType === 'touch' })
  }
  const { plot } = layout
  const tooltip = activePosition === null ? null : lineTooltipAnchor(activePosition, layout.width)

  return (
    <div className="ck-chart ck-line" role="group" aria-label={title}>
      {described.length > 1 && (
        <fieldset className="ck-line-legend">
          <legend>Серии на графике</legend>
          {described.map((entry) => (
            <label key={entry.item.key} className="ck-line-legend-item">
              <input type="checkbox" checked={!selection.hidden.includes(entry.item.key)} onChange={() => toggle(entry.item.key)} />
              <Swatch style={entry.style} />
              <span className="ck-line-legend-text">
                <span className="ck-line-badge">{entry.endLabel}</span>
                {entry.item.label}
                {entry.item.note && <span className="ck-chart-note"> · {entry.item.note}</span>}
              </span>
            </label>
          ))}
        </fieldset>
      )}
      <div
        ref={plotRef}
        className="ck-line-plot"
        role="application"
        tabIndex={0}
        aria-label={`График: ${title}`}
        aria-roledescription="интерактивный график"
        aria-describedby={hintId}
        onKeyDown={onKeyDown}
        onPointerMove={onPointer}
        onPointerDown={onPointer}
        onPointerLeave={() => dispatch({ type: 'pointer-leave' })}
        onBlur={() => dispatch({ type: 'blur' })}
      >
        {/* Values are read from the live line and the table; the drawing itself is not announced. */}
        <svg className="ck-line-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true" focusable="false">
          <g className="ck-chart-grid">
            {layout.yTicks.map((tick) => (
              <line key={tick.position} x1={c(plot.left)} x2={c(plot.right)} y1={c(tick.position)} y2={c(tick.position)} />
            ))}
          </g>
          <g className="ck-chart-axis">
            <line x1={c(plot.left)} x2={c(plot.right)} y1={c(plot.bottom)} y2={c(plot.bottom)} />
            {layout.yTicks.map((tick) => (
              <text key={tick.position} x={c(plot.left - 6)} y={c(tick.position)} textAnchor="end" dominantBaseline="central">{tick.text}</text>
            ))}
            {layout.xTicks.map((tick) => (
              <g key={tick.x}>
                <line x1={c(tick.position)} x2={c(tick.position)} y1={c(plot.bottom)} y2={c(plot.bottom + 4)} />
                <text x={c(tick.position)} y={c(plot.bottom + 17)} textAnchor={tick.anchor}>{tick.text}</text>
              </g>
            ))}
          </g>
          {activePosition !== null && (
            <line className="ck-line-crosshair" x1={c(activePosition)} x2={c(activePosition)} y1={c(plot.top)} y2={c(plot.bottom)} />
          )}
          {layout.series.map((item, index) => {
            const { style } = visible[index]
            return (
              <g key={item.key} className={`ck-line-series ck-chart-c${style.color}`}>
                {item.segments.map((d) => <path key={d} className="ck-line-path" d={d} strokeDasharray={style.dash || undefined} />)}
                {item.points.map((point) => {
                  const current = point.xIndex === activeIndex
                  if (!point.marker && !current) return null
                  return <path key={point.x} className="ck-line-marker" data-state={current ? 'active' : undefined} d={markerPath(style.shape, point.cx, point.cy, current ? 5.5 : 4)} />
                })}
                {item.label && (
                  <g className="ck-line-end">
                    {item.label.leader && <line x1={c(item.label.leader[0])} y1={c(item.label.leader[1])} x2={c(item.label.leader[2])} y2={c(item.label.leader[3])} />}
                    <text x={c(item.label.x)} y={c(item.label.y)} dominantBaseline="central">{item.label.text}</text>
                  </g>
                )}
              </g>
            )
          })}
        </svg>
        {visible.length === 0 && <p className="ck-line-overlay">Все серии скрыты. Включите серию в списке над графиком.</p>}
        {activeX !== null && tooltip !== null && (
          <div className="ck-line-tooltip-track" data-side={tooltip.side} aria-hidden="true">
            {/* The distance from the plot edge of the tooltip's side to the crosshair; it gives way when a whole value needs the room. */}
            <span className="ck-line-tooltip-gap" style={{ flexBasis: 'left' in tooltip.style ? tooltip.style.left : tooltip.style.right }} />
            <div className="ck-line-tooltip" data-side={tooltip.side}>
              <span className="ck-line-tooltip-title">{wholeWords(formatX(activeX))}</span>
              {readoutSeries.map((entry, index) => {
                const value = entry.values.get(activeX)
                if (value === undefined) return null
                return (
                  <span key={visible[index].item.key} className="ck-line-tooltip-row">
                    <Swatch style={entry.style} />
                    <strong>{wholeWords(value)}</strong>
                    <span>{entry.label}</span>
                  </span>
                )
              })}
            </div>
          </div>
        )}
      </div>
      {valueAxisLabel && <p className="ck-chart-note">Вертикальная ось: {valueAxisLabel}.</p>}
      <p className="ck-chart-note" id={hintId}>
        Клавиши на графике: ← и → — соседний интервал, Home и End — первый и последний, Esc — снять выделение.
      </p>
      <p className="ck-line-live" aria-live="polite" aria-atomic="true">{readout || 'Интервал не выбран.'}</p>
      <details className="ck-line-table">
        <summary>Таблица значений</summary>
        <div className="ck-line-table-scroll" role="region" aria-label={`Таблица значений: ${title}`} tabIndex={0}>
          <table>
            <caption>{title}</caption>
            <thead>
              <tr>
                <th scope="col">{intervalHeader}</th>
                {described.map((entry) => <th key={entry.item.key} scope="col" className="ck-chart-number">{entry.item.label}</th>)}
              </tr>
            </thead>
            <tbody>
              {allXs.map((x) => (
                <tr key={x}>
                  <th scope="row">{formatX(x)}</th>
                  {described.map((entry) => (
                    <td key={entry.item.key} className="ck-chart-number">{entry.points.find((point) => point.x === x)?.valueText ?? '—'}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </details>
    </div>
  )
}
