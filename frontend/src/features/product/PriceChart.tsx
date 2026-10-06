import { useCallback, useState } from 'react'
import { getProductPriceSeries } from '../../api/price-series'
import type { PriceSeries, PriceSeriesInterval, PriceSeriesKind } from '../../api/price-series'
import type { ApiResult } from '../../api/types'
import RequestState from '../../components/RequestState'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import { LineChart } from '../../lib/charts'
import { navigate } from '../../navigation'
import type { ProductQuery } from '../../navigation'
import ProductRequestState from './ProductRequestState'
import {
  chartFailureKind, chartInterval, chartNotes, chartPanels, chartPrice, emptyMessage, formatAxisValue, hasPeriod, intervalOptions,
  mixedPackagesWarning, periodFormats, priceOptions, priceSeriesParams, rangeTooLargeMessage,
} from './price-chart-state'
import type { ChartPanel } from './price-chart-state'
import type { RequestState as LoadState } from './state'
import { useProductRequest } from './useProductRequest'

/** Series switched off in the legend, by panel key. Lives on the page: a reload of the series keeps it, the address does not hold it. */
export type HiddenSeries = Readonly<Record<string, readonly string[]>>

function Choice<T extends string>({ legend, name, value, options, onChange }: {
  legend: string; name: string; value: T; options: { value: T; label: string }[]; onChange: (value: T) => void
}) {
  return (
    <fieldset className="product-chart-choice">
      <legend>{legend}</legend>
      {options.map((option) => (
        <label key={option.value} className="product-chart-option">
          <input type="radio" name={name} value={option.value} checked={option.value === value} onChange={() => onChange(option.value)} />
          <span>{option.label}</span>
        </label>
      ))}
    </fieldset>
  )
}

function Panel({ panel, interval, hidden, onHidden }: {
  panel: ChartPanel; interval: PriceSeriesInterval; hidden: readonly string[] | undefined; onHidden: (keys: readonly string[]) => void
}) {
  const headingId = `product-chart-${panel.currency}-${panel.unit}`
  const format = periodFormats[interval]
  return (
    <section className="product-chart-panel" aria-labelledby={headingId}>
      <h3 id={headingId}>{panel.title}</h3>
      <p className="product-note">Магазинов с этим товаром: {panel.own.toLocaleString('ru-RU')}. Рядов похожих товаров: {panel.similar.toLocaleString('ru-RU')}.</p>
      {panel.mixedPackages && <p className="product-chart-warning">{mixedPackagesWarning}</p>}
      <LineChart title={`Цены, ${panel.axisLabel}`} series={panel.series} connectGaps formatX={format.full} formatTick={format.tick}
        formatValue={formatAxisValue} valueAxisLabel={panel.axisLabel} intervalHeader={format.header}
        defaultHiddenKeys={hidden} onHiddenChange={onHidden} emptyMessage="Нет наблюдений для графика." />
    </section>
  )
}

/** Markup of the block for a given request state; `PriceChart` below owns the request. */
export function PriceChartView({ state, query, similar, hidden, onPrice, onInterval, onSimilar, onHidden, retry, reset }: {
  state: LoadState<PriceSeries>; query: ProductQuery; similar: boolean; hidden?: HiddenSeries
  onPrice: (price: PriceSeriesKind) => void; onInterval: (interval: PriceSeriesInterval) => void
  onSimilar: (similar: boolean) => void; onHidden?: (panel: string, keys: readonly string[]) => void
  retry: () => void; reset: () => void
}) {
  const block = useLocalRequestFocus(state)
  const price = chartPrice(query)
  const interval = chartInterval(query)
  const failure = state.kind === 'error' ? chartFailureKind(state) : undefined
  const panels = state.kind === 'ok' ? chartPanels(state.data) : []
  const notes = state.kind === 'ok' ? chartNotes(state.data) : []
  return (
    <section ref={block} className="product-panel" aria-labelledby="product-chart-heading" aria-busy={state.kind === 'loading'}>
      <h2 id="product-chart-heading" tabIndex={-1} data-request-focus-target>График цен</h2>
      <p className="product-note">Линии этого товара — по магазинам, где его покупали; линии похожих товаров того же обобщённого продукта — по странам.
        Точка — средняя цена покупок за интервал, интервалы без покупок пропущены. Каждая пара «валюта, единица» — отдельная панель.</p>
      <p className="product-note">Из фильтров выше график берёт только период; магазин, страна и валюта на него не влияют.</p>
      <div className="product-chart-controls">
        <Choice legend="Цена" name="product-chart-price" value={price} options={priceOptions} onChange={onPrice} />
        <Choice legend="Интервал" name="product-chart-interval" value={interval} options={intervalOptions} onChange={onInterval} />
        <label className="product-chart-option product-chart-similar">
          <input type="checkbox" checked={similar} onChange={(event) => onSimilar(event.target.checked)} />
          <span>Показывать похожие товары</span>
        </label>
      </div>
      {state.kind === 'loading' && <RequestState kind="loading" message="Загружаем график цен…" />}
      {state.kind === 'error' && (failure === 'range_too_large'
        ? <RequestState kind="empty" message={rangeTooLargeMessage(interval)}
          action={interval !== 'month' && <button type="button" onClick={() => onInterval('month')}>Показать по месяцам</button>} />
        : <ProductRequestState failure={state} retry={retry} reset={reset} />)}
      {state.kind === 'ok' && <>
        {notes.length > 0 && <ul className="product-chart-notes">{notes.map((note) => (
          <li key={note.key} className={note.tone === 'warning' ? 'product-chart-warning' : undefined}>{note.text}</li>
        ))}</ul>}
        {panels.length === 0
          ? <RequestState kind="empty" message={emptyMessage(query, price)}
            action={hasPeriod(query) && <button type="button" onClick={reset}>Сбросить фильтры</button>} />
          : panels.map((panel) => <Panel key={panel.key} panel={panel} interval={state.data.interval}
            hidden={hidden?.[panel.key]} onHidden={(keys) => onHidden?.(panel.key, keys)} />)}
      </>}
    </section>
  )
}

/** Independent block of the product card: its refusal leaves the history table and the summary as they are. */
export default function PriceChart({ productId, query, reset }: { productId: number; query: ProductQuery; reset: () => void }) {
  const [similar, setSimilar] = useState(true)
  const [hidden, setHidden] = useState<HiddenSeries>({})
  const { date_from, date_to, price, interval } = query
  const load = useCallback(async (signal: AbortSignal): Promise<ApiResult<PriceSeries>> => {
    const params = priceSeriesParams({ date_from, date_to, price, interval, page: 1 }, similar)
    const result = await getProductPriceSeries(productId, params, { signal })
    // An answer for another mode would be drawn under the wrong switch.
    return result.kind === 'ok' && (result.data.price !== params.price || result.data.interval !== params.interval)
      ? { kind: 'error', reason: 'invalid_response' } : result
  }, [productId, date_from, date_to, price, interval, similar])
  const request = useProductRequest(load)
  // The switches change only the query, so the shell leaves the focus on them; the history page is kept.
  const change = (next: Pick<ProductQuery, 'price' | 'interval'>) => navigate({ kind: 'product', productId, query: { ...query, ...next } })
  const onHidden = useCallback((panel: string, keys: readonly string[]) => setHidden((previous) => ({ ...previous, [panel]: keys })), [])
  return <PriceChartView state={request.state} query={query} similar={similar} hidden={hidden}
    onPrice={(next) => change({ price: next })} onInterval={(next) => change({ interval: next })}
    onSimilar={setSimilar} onHidden={onHidden} retry={request.retry} reset={reset} />
}
