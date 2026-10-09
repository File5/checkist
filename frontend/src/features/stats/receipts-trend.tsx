import { useCallback, useId, useMemo } from 'react'
import type { ReceiptInterval, ReceiptSeriesCurrency } from '../../api/stats'
import RequestState from '../../components/RequestState'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import { LineChart } from '../../lib/charts'
import { formatAxisTick } from '../../lib/charts/scale'
import { Link, receiptsStatsHref } from '../../navigation'
import type { ReceiptsStatsQuery } from '../../navigation'
import { PeriodDate } from './period'
import { axisNumber, intervalName, trendCharts } from './receipts-series'
import { canRetry, coarserIntervals, failureMessage, hasPeriods, hasScope, intervalChoices, intervalHref, seriesParams, withoutScope } from './receipts-state'
import type { SeriesState } from './receipts-state'

/** Divisions of the money axis: whole or with two decimals, like an amount — «2,50 / 3,00 / 3,50». */
const moneyAxisNumber = (value: number, step?: number) => formatAxisTick(value, step, true)

function CurrencyTrend({ block, interval }: { block: ReceiptSeriesCurrency; interval: ReceiptInterval }) {
  const id = useId()
  const charts = useMemo(() => trendCharts(block), [block])
  const formatX = useCallback((x: string) => intervalName(x, interval), [interval])
  const formatTick = useCallback((x: string) => intervalName(x, interval, true), [interval])
  return (
    <article className="stats-currency" aria-labelledby={id}>
      <h4 id={id}>{block.currency}</h4>
      <LineChart title={`Средний и медианный чек, ${block.currency}`} series={charts.receipts} interval={interval} zeroBaseline
        formatX={formatX} formatTick={formatTick} formatValue={moneyAxisNumber} valueAxisLabel={block.currency} />
      <LineChart title="Позиций на чек" series={charts.lines} interval={interval} zeroBaseline
        formatX={formatX} formatTick={formatTick} formatValue={axisNumber} valueAxisLabel="товарных строк на один чек" />
      {block.refunds_excluded > 0 && <p className="stats-note">
        Возвраты в график не входят: исключено {block.refunds_excluded.toLocaleString('ru-RU')}.
      </p>}
    </article>
  )
}

function TrendBody({ state, query, onRetry }: TrendBlockProps) {
  const interval = query.interval ?? 'month'
  switch (state.kind) {
    case 'loading': return <RequestState kind="loading" message="Загружаем походы по времени…" />
    case 'error': {
      if (canRetry(state)) return <RequestState kind="error" message={failureMessage(state)} onRetry={onRetry} />
      const coarser = state.reason === 'range_too_large' ? coarserIntervals(interval) : []
      return <RequestState kind="empty" message={failureMessage(state)} action={coarser.length > 0
        ? <ul className="stats-inline-links">
          {coarser.map((choice) => <li key={choice.interval}><Link className="action-link" to={intervalHref(query, choice.interval)}>Интервал: {choice.label.toLowerCase()}</Link></li>)}
        </ul>
        : <Link className="action-link" to={receiptsStatsHref(query.interval ? { interval: query.interval } : {})}>Сбросить периоды и фильтры</Link>} />
    }
    case 'ok': {
      const { data } = state
      if (data.currencies.length === 0) {
        return hasScope(query)
          ? <RequestState kind="empty" message="По выбранным стране, валюте и магазинам походов за это время нет."
            action={<Link className="action-link" to={receiptsStatsHref(withoutScope(query))}>Убрать фильтры</Link>} />
          : <RequestState kind="empty" message={hasPeriods(query)
            ? 'За это время походов в магазин нет. Выберите другие периоды.'
            : 'Чеков пока нет: график появится после распознавания первых фото чеков.'} />
      }
      return (
        <>
          {data.currencies.length > 1 && <p className="stats-note">Валюты не складываются: у каждой валюты чеков свои графики.</p>}
          {data.currencies.map((block) => <CurrencyTrend key={block.currency} block={block} interval={data.interval} />)}
        </>
      )
    }
  }
}

export interface TrendBlockProps { state: SeriesState; query: ReceiptsStatsQuery; onRetry: () => void }
/** Average receipt over time. Independent of the comparison: a failure here leaves the comparison in place. */
export default function TrendBlock(props: TrendBlockProps) {
  const id = useId()
  const { state, query } = props
  const phase = useMemo(() => ({ kind: state.kind }), [state])
  const block = useLocalRequestFocus<HTMLElement>(phase)
  const { date_from, date_to } = seriesParams(query)
  const span = date_from && date_to ? <>с <PeriodDate date={date_from} /> по <PeriodDate date={date_to} /> — от начала базового периода до конца текущего</>
    : date_from ? <>с <PeriodDate date={date_from} /></> : date_to ? <>по <PeriodDate date={date_to} /></> : 'все сохранённые чеки'
  return (
    <section ref={block} className="stats-panel" aria-labelledby={id} aria-busy={state.kind === 'loading'}>
      <h3 id={id} data-request-focus-target tabIndex={-1}>Средний чек по времени</h3>
      <p className="stats-note">Охват графика: {span}. Интервал без походов — разрыв линии, а не ноль.</p>
      <nav className="stats-intervals" aria-label="Интервал графика">
        <span className="stats-presets-title">Интервал:</span>
        <ul>
          {intervalChoices(query.interval ?? 'month').map((choice) => (
            <li key={choice.interval}>
              <Link className="stats-chip" to={intervalHref(query, choice.interval)} aria-current={choice.active ? 'true' : undefined}>{choice.label}</Link>
            </li>
          ))}
        </ul>
      </nav>
      <TrendBody {...props} />
    </section>
  )
}
