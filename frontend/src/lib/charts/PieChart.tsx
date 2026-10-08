import { useEffect, useId, useReducer, useRef, useState } from 'react'
import type { ComponentType, CSSProperties, ReactNode } from 'react'
import { layoutPieLabels, pieSlices, pieTones } from './pie.ts'
import { seriesColors } from './line.ts'
import { usePlotWidth } from './plot-width.ts'
import { coordinate as c } from './scale.ts'
import { activePieKey, noPieHighlight, pieHighlightReducer } from './selection.ts'
import './Charts.css'

export interface ChartLinkProps { to: string; className?: string; tabIndex?: number; children?: ReactNode }
/** The project `Link` fits; the default is a plain `<a href>`. */
export type ChartLinkComponent = ComponentType<ChartLinkProps>

export interface PieChartItem {
  key: string
  /** Full name for the legend. Special rows («Прочее», «Без товара») are named by the caller. */
  label: string
  /** Drawing value only (see `chartNumber`); an item that is not positive stays in the legend. */
  value: number
  /** Formatted by the caller: sum with currency and the share, e.g. «412,30 EUR» and «20,70 %». */
  valueText: string
  shareText: string
  /** Short text next to the sector (up to ~8 characters); `shareText` by default. */
  chartLabel?: string
  /** Drill-down address. Without it the sector and its legend name are plain. */
  href?: string
  /** `other` — the «Прочее» roll-up, `muted` — special rows; both are drawn in neutral tones. */
  tone?: 'series' | 'other' | 'muted'
  /** Small text under the name in the legend. */
  note?: string
}

export interface PieChartProps {
  /** Names the chart and captions the legend table. */
  title: string
  items: readonly PieChartItem[]
  headers?: { name: string; value: string; share: string }
  /** Shown in the middle while no sector is highlighted, e.g. «Всего» / «1 986,40 EUR». */
  centerLabel?: string
  centerValue?: string
  /** Mark of a legend row whose sum is not positive. */
  excludedNote?: string
  emptyMessage?: string
  linkComponent?: ChartLinkComponent
}

const base = { width: 320, height: 240, outer: 76, inner: 46 }
const figureWidth = { fallback: base.width, min: 240, max: 380 }

/**
 * The drawing for a figure of the given width, one to one: the text stays 12px at any width. A figure narrower than
 * the base keeps the ring and loses room beside the labels; a wider one grows the ring with it.
 */
function pieFrame(width: number) {
  const scale = Math.max(1, width / base.width)
  const height = base.height * scale
  const geometry = { cx: width / 2, cy: height / 2, outer: base.outer * scale, inner: base.inner * scale }
  return { width, height, geometry, labelArea: { ...geometry, radius: geometry.outer + 14, lineHeight: 15, top: 12, bottom: height - 12 } }
}
const defaultHeaders = { name: 'Название', value: 'Сумма', share: 'Доля' }

function PlainLink({ to, ...props }: ChartLinkProps) {
  return <a href={to} {...props} />
}

/** A sum wider than the hole of the ring is left to the legend: cut or wrapped digits would read as another number. */
function CenterValue({ text }: { text: string }) {
  const ref = useRef<HTMLElement>(null)
  const [fits, setFits] = useState(true)
  useEffect(() => {
    const node = ref.current
    if (!node || typeof ResizeObserver === 'undefined') return undefined
    // The box is as wide as its text up to the width of the hole, so every change of the answer changes its size.
    const observer = new ResizeObserver(() => setFits(node.scrollWidth <= node.clientWidth))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return <strong ref={ref} className="ck-pie-center-value" data-fits={fits ? undefined : 'false'}>{text}</strong>
}

export default function PieChart({
  title, items, headers = defaultHeaders, centerLabel, centerValue,
  excludedNote = 'Не входит в диаграмму: сумма не положительная.',
  emptyMessage = 'Нет данных для диаграммы.',
  linkComponent: LinkComponent = PlainLink,
}: PieChartProps) {
  const patternId = useId()
  const [figureRef, width] = usePlotWidth<HTMLDivElement>(figureWidth)
  const [highlight, dispatch] = useReducer(pieHighlightReducer, noPieHighlight)
  if (items.length === 0) return <p className="ck-chart ck-chart-empty">{emptyMessage}</p>

  const view = pieFrame(width)
  const slices = pieSlices(items, view.geometry)
  const sliceByKey = new Map(slices.map((slice) => [slice.key, slice]))
  const labels = layoutPieLabels(slices, view.labelArea)
  const active = activePieKey(highlight, items.map((item) => item.key))
  const activeItem = items.find((item) => item.key === active)

  const toneList = pieTones(items.map((item) => item.tone), seriesColors)
  const tones = new Map(items.map((item, index) => [item.key, toneList[index]]))
  const handlers = (key: string) => ({
    onPointerEnter: () => dispatch({ type: 'enter', key }),
    onPointerLeave: () => dispatch({ type: 'leave', key }),
    onFocus: () => dispatch({ type: 'focus', key }),
    onBlur: () => dispatch({ type: 'blur', key }),
  })
  const state = (key: string) => (active === null ? undefined : active === key ? 'active' : 'dim')

  return (
    <div className="ck-chart ck-pie">
      {slices.length === 0 ? (
        <p className="ck-chart-empty">Положительных сумм нет, диаграмма не построена. Все значения — в таблице.</p>
      ) : (
        <div ref={figureRef} className="ck-pie-figure" style={{ '--ck-pie-hole': `${c(view.geometry.inner * 2)}px` } as CSSProperties}>
          {/* The legend table below is the accessible form; the drawing repeats it for the eye and the pointer. */}
          <svg className="ck-pie-svg" viewBox={`0 0 ${view.width} ${c(view.height)}`} aria-hidden="true" focusable="false">
            <defs>
              <pattern id={patternId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
                <rect className="ck-chart-hatch" width="2" height="6" />
              </pattern>
            </defs>
            {slices.map((slice) => {
              const item = items[slice.index]
              const tone = tones.get(slice.key)
              const shape = (
                <>
                  <path className="ck-pie-shape" d={slice.path} />
                  {tone?.hatched && <path className="ck-pie-shape" d={slice.path} fill={`url(#${patternId})`} />}
                </>
              )
              return (
                <g key={slice.key} className={`ck-pie-slice ${tone?.className ?? ''}`} data-state={state(slice.key)} {...handlers(slice.key)}>
                  {/* Out of the tab order: the same link in the legend is the keyboard stop. */}
                  {item.href ? <LinkComponent to={item.href} className="ck-pie-link" tabIndex={-1}>{shape}</LinkComponent> : shape}
                </g>
              )
            })}
            {labels.map((label) => {
              const item = items[(sliceByKey.get(label.key) as { index: number }).index]
              return (
                <g key={label.key} className="ck-pie-label" data-state={state(label.key)}>
                  <line x1={c(label.line[0])} y1={c(label.line[1])} x2={c(label.line[2])} y2={c(label.line[3])} />
                  <text x={c(label.x)} y={c(label.y)} textAnchor={label.anchor} dominantBaseline="central">{item.chartLabel ?? item.shareText}</text>
                </g>
              )
            })}
          </svg>
          <div className="ck-pie-center" aria-hidden="true">
            {activeItem ? (
              <>
                <span className="ck-pie-center-label">{activeItem.label}</span>
                <CenterValue text={activeItem.valueText} />
                <span>{activeItem.shareText}</span>
              </>
            ) : (
              <>
                {centerLabel && <span className="ck-pie-center-label">{centerLabel}</span>}
                {centerValue && <CenterValue text={centerValue} />}
              </>
            )}
          </div>
        </div>
      )}
      <div className="ck-pie-legend-scroll" role="region" aria-label={`Таблица: ${title}`} tabIndex={0}>
        <table className="ck-pie-legend">
          <caption>{title}</caption>
          <thead>
            <tr>
              <th scope="col">{headers.name}</th>
              <th scope="col" className="ck-chart-number">{headers.value}</th>
              <th scope="col" className="ck-chart-number">{headers.share}</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const drawn = sliceByKey.has(item.key)
              const tone = tones.get(item.key)
              return (
                <tr key={item.key} data-state={state(item.key)} {...handlers(item.key)}>
                  <th scope="row">
                    <span className="ck-pie-name">
                      <span className={`ck-pie-swatch ${drawn ? tone?.className ?? '' : 'ck-pie-swatch-none'}`} data-hatched={drawn && tone?.hatched ? 'true' : undefined} aria-hidden="true" />
                      <span className="ck-pie-name-text">
                        {item.href ? <LinkComponent to={item.href}>{item.label}</LinkComponent> : item.label}
                        {item.note && <span className="ck-chart-note">{item.note}</span>}
                        {!drawn && <span className="ck-chart-note">{excludedNote}</span>}
                      </span>
                    </span>
                  </th>
                  <td className="ck-chart-number">{item.valueText}</td>
                  <td className="ck-chart-number">{item.shareText}</td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </div>
  )
}
