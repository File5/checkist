import { useMemo } from 'react'
import { getReceiptCompare, getReceiptSeries } from '../../api/stats'
import { buildReceiptsStatsQuery, parseReceiptsStatsQuery } from '../../navigation'
import type { ReceiptsStatsPageProps } from '../../pages/types'
import CompareBlock from './receipts-compare'
import ReceiptsFilters from './receipts-filters'
import { useStatsRequest } from './receipts-request'
import { appliedErrors, comparePlan, seriesParams } from './receipts-state'
import type { CompareState } from './receipts-state'
import TrendBlock from './receipts-trend'
import './ReceiptsStats.css'

/** «Why did the average receipt change»: two periods from the address, the comparison and the chart as independent blocks. */
export default function ReceiptsStatsPage({ query }: ReceiptsStatsPageProps) {
  // The address strings are the request keys: the interval belongs to the chart and never reloads the comparison.
  const seriesKey = buildReceiptsStatsQuery(query)
  const compareKey = buildReceiptsStatsQuery({ ...query, interval: undefined })
  const plan = useMemo(() => comparePlan(parseReceiptsStatsQuery(compareKey).query), [compareKey])
  const loadCompare = useMemo(() => (plan.kind === 'request'
    ? (signal: AbortSignal) => getReceiptCompare(plan.params, { signal }) : null), [plan])
  const loadSeries = useMemo(() => {
    const params = seriesParams(parseReceiptsStatsQuery(seriesKey).query)
    return (signal: AbortSignal) => getReceiptSeries(params, { signal })
  }, [seriesKey])
  const compare = useStatsRequest(loadCompare)
  const series = useStatsRequest(loadSeries)
  const compareState: CompareState = compare.state.kind === 'idle' ? (plan.kind === 'invalid' ? plan : { kind: 'idle' }) : compare.state
  const seriesState = series.state.kind === 'idle' ? { kind: 'loading' as const } : series.state

  return (
    <section className="stats-receipts" aria-labelledby="stats-receipts-heading">
      <h2 id="stats-receipts-heading">Почему изменился средний чек</h2>
      <p className="stats-intro">
        Сравните два периода: экран покажет, насколько изменился средний чек и что на это повлияло — число позиций за поход, цены на те же товары или другой состав покупок.
        Поход — чек продажи; возвраты не считаются.
      </p>
      <ReceiptsFilters query={query} applied={appliedErrors(query, [compare.state, series.state])} />
      <CompareBlock state={compareState} query={query} onRetry={compare.retry} />
      <TrendBlock state={seriesState} query={query} onRetry={series.retry} />
    </section>
  )
}
