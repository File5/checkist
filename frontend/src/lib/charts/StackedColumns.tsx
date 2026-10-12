import { useMemo } from 'react'
import type { CSSProperties } from 'react'
import { Card, CardList, useNarrow } from '../cards'
import type { CardFact } from '../cards'
import { layoutColumns } from './columns.ts'
import type { ChartLinkComponent, ChartLinkProps } from './PieChart.tsx'
import { usePlotWidth } from './plot-width.ts'
import { coordinate as c } from './scale.ts'
import './Charts.css'
import './Columns.css'

export interface StackedSegment {
  /** The key of a legend entry. */
  key: string
  /** Drawing value only (see `chartNumber`); a segment that is not positive is not drawn. */
  value: number
  /** Formatted by the caller, with the currency. */
  valueText: string
}
export interface StackedColumn {
  /** `YYYY-MM-DD` of the period start. */
  x: string
  segments: readonly StackedSegment[]
  /** The total of the period as the server sent it, with the currency. */
  totalText: string
  /** Opens the period. Without it the column is not a link. */
  href?: string
}
export interface StackedLegendEntry {
  key: string
  label: string
  /** 1–6 — the colour of a category (`--ck-cat-N`); 0 — the neutral colour of what has no category. */
  tone: number
  /** Small text after the name, e.g. the total of the window. */
  note?: string
}
export interface StackedColumnsProps {
  /** Names the chart for assistive technology and captions the table. */
  title: string
  columns: readonly StackedColumn[]
  /** Bottom-up order of the segments and the columns of the table. */
  legend: readonly StackedLegendEntry[]
  /** The opened period: its column is marked. */
  activeX?: string | null
  /** Full name of a period: links, table. */
  formatX: (x: string) => string
  /** Short name for the axis. */
  formatTick: (x: string) => string
  formatValue: (value: number, step: number) => string
  valueAxisLabel?: string
  totalHeader?: string
  intervalHeader?: string
  linkComponent?: ChartLinkComponent
}

const plotWidth = { fallback: 640, min: 240, max: 1200 }
const heightFor = (width: number) => (width < 420 ? 220 : 280)

function PlainLink({ to, children, ...rest }: ChartLinkProps) {
  return <a href={to} {...rest}>{children}</a>
}

function Swatch({ tone }: { tone: number }) {
  return <span className={`ck-columns-swatch ck-columns-tone-${tone}`} aria-hidden="true" />
}

/** The phone view of the table of values: one card per period, a fact per legend entry and the total. */
function ColumnValueCards({ label, caption, columns, legend, formatX, totalHeader }: {
  label: string; caption: string; columns: readonly StackedColumn[]; legend: readonly StackedLegendEntry[]
  formatX: (x: string) => string; totalHeader: string
}) {
  return (
    <CardList label={label} caption={caption}>
      {columns.map((column) => {
        const values = new Map(column.segments.map((segment) => [segment.key, segment.valueText]))
        const facts: CardFact[] = [
          ...legend.filter((entry) => values.has(entry.key)).map((entry) => ({ key: entry.key, label: entry.label, value: values.get(entry.key) })),
          { key: 'total', label: totalHeader, value: column.totalText },
        ]
        return <Card key={column.x} title={<time dateTime={column.x}>{formatX(column.x)}</time>} facts={facts} />
      })}
    </CardList>
  )
}

/**
 * Stacked columns by period. The drawing is not announced: every column is a link with its name and total, the
 * legend names the colours and the table holds every value. A finger taps a column like any link; the page keeps
 * scrolling under it.
 */
export default function StackedColumns({
  title, columns, legend, activeX = null, formatX, formatTick, formatValue, valueAxisLabel,
  totalHeader = 'Итого', intervalHeader = 'Месяц', linkComponent: LinkComponent = PlainLink,
}: StackedColumnsProps) {
  const [plotRef, width] = usePlotWidth<HTMLDivElement>(plotWidth)
  const narrow = useNarrow()
  const height = heightFor(width)
  const tones = useMemo(() => new Map(legend.map((entry) => [entry.key, entry.tone])), [legend])
  const order = useMemo(() => new Map(legend.map((entry, index) => [entry.key, index])), [legend])
  const sorted = useMemo(() => columns.map((column) => ({
    ...column,
    segments: [...column.segments].sort((a, b) => (order.get(a.key) ?? Infinity) - (order.get(b.key) ?? Infinity)),
  })), [columns, order])
  const layout = useMemo(() => layoutColumns(sorted, { width, height, formatValue, formatTick }), [sorted, width, height, formatValue, formatTick])
  const { plot } = layout
  const tableLabel = `Таблица значений: ${title}`

  return (
    <div className="ck-chart ck-columns" role="group" aria-label={title}>
      <ul className="ck-columns-legend" aria-label="Цвета на графике">
        {legend.map((entry) => (
          <li key={entry.key}>
            <Swatch tone={entry.tone} />
            <span>{entry.label}{entry.note && <span className="ck-chart-note"> · <span className="ck-chart-whole">{entry.note}</span></span>}</span>
          </li>
        ))}
      </ul>
      <div ref={plotRef} className="ck-columns-plot">
        <svg className="ck-columns-svg" viewBox={`0 0 ${layout.width} ${layout.height}`} aria-hidden="true" focusable="false">
          <g className="ck-chart-grid">
            {layout.yTicks.map((tick) => <line key={tick.position} x1={c(plot.left)} x2={c(plot.right)} y1={c(tick.position)} y2={c(tick.position)} />)}
          </g>
          {layout.columns.map((column) => column.x === activeX && (
            <rect key={column.x} className="ck-columns-active" x={c(column.slotLeft)} y={c(plot.top)} width={c(column.slotWidth)} height={c(plot.bottom - plot.top)} />
          ))}
          <g className="ck-chart-axis">
            <line x1={c(plot.left)} x2={c(plot.right)} y1={c(plot.bottom)} y2={c(plot.bottom)} />
            {layout.yTicks.map((tick) => (
              <text key={tick.position} x={c(plot.left - 6)} y={c(tick.position)} textAnchor="end" dominantBaseline="central">{tick.text}</text>
            ))}
            {layout.xTicks.map((tick) => (
              <text key={tick.x} x={c(tick.position)} y={c(plot.bottom + 17)} textAnchor={tick.anchor}
                className={tick.x === activeX ? 'ck-columns-tick-active' : undefined}>{tick.text}</text>
            ))}
          </g>
          {layout.columns.map((column) => (
            <g key={column.x} className="ck-columns-stack" data-state={activeX === null ? undefined : column.x === activeX ? 'active' : 'dim'}>
              {column.segments.map((segment) => (
                <rect key={segment.key} className={`ck-columns-segment ck-columns-tone-${tones.get(segment.key) ?? 0}`}
                  x={c(column.left)} y={c(segment.y)} width={c(column.width)} height={c(segment.height)} />
              ))}
            </g>
          ))}
        </svg>
        <ol className="ck-columns-hits" aria-label={`Месяцы: ${title}`}>
          {sorted.map((column, index) => {
            const laid = layout.columns[index]
            const style: CSSProperties = {
              left: `${(laid.slotLeft / layout.width) * 100}%`, width: `${(laid.slotWidth / layout.width) * 100}%`,
              top: `${(plot.top / layout.height) * 100}%`, height: `${((plot.bottom - plot.top) / layout.height) * 100}%`,
            }
            const name = `${formatX(column.x)}: ${column.totalText}`
            return (
              <li key={column.x} style={style}>
                {column.href
                  ? <LinkComponent to={column.href} className="ck-columns-hit" aria-label={column.x === activeX ? `${name}, открыт` : name} />
                  : <span className="ck-columns-hit" role="img" aria-label={name} />}
              </li>
            )
          })}
        </ol>
      </div>
      {valueAxisLabel && <p className="ck-chart-note">Вертикальная ось: {valueAxisLabel}.</p>}
      <details className="ck-line-table ck-columns-table">
        <summary>Таблица значений</summary>
        {narrow ? <ColumnValueCards label={tableLabel} caption={title} columns={sorted} legend={legend} formatX={formatX} totalHeader={totalHeader} /> : (
          <div className="ck-line-table-scroll" role="region" aria-label={tableLabel} tabIndex={0}>
            <table>
              <caption>{title}</caption>
              <thead>
                <tr>
                  <th scope="col">{intervalHeader}</th>
                  {legend.map((entry) => <th key={entry.key} scope="col" className="ck-chart-number">{entry.label}</th>)}
                  <th scope="col" className="ck-chart-number">{totalHeader}</th>
                </tr>
              </thead>
              <tbody>
                {sorted.map((column) => {
                  const values = new Map(column.segments.map((segment) => [segment.key, segment.valueText]))
                  return (
                    <tr key={column.x}>
                      <th scope="row"><time dateTime={column.x}>{formatX(column.x)}</time></th>
                      {legend.map((entry) => <td key={entry.key} className="ck-chart-number">{values.get(entry.key) ?? '—'}</td>)}
                      <td className="ck-chart-number">{column.totalText}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        )}
      </details>
    </div>
  )
}
