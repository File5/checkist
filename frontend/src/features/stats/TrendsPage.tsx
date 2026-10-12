import { useMemo } from 'react'
import { getTrendsCategory, getTrendsLimits, getTrendsMonthly, getTrendsPrices, getTrendsRange } from '../../api/trends'
import type { TrendsPageProps } from '../../pages/types'
import { useStatsRequest } from './receipts-request'
import { CategoryBlock, MonthlyBlock, PricesBlock } from './trends-blocks'
import { LimitsBlock, MonthToMonthBlock, SummaryStrip } from './trends-dashboard'
import { monthOfDate } from './trends-period'
import TrendsPeriodPicker from './trends-period-picker'
import { categoryParams, windowParams } from './trends-state'

const loadRange = (signal: AbortSignal) => getTrendsRange({ signal })
import './ReceiptsStats.css'
import './Trends.css'

/** «Динамика»: three independent blocks over one window of months; the window, the opened month and the category live in the address. */
export default function TrendsPage({ query }: TrendsPageProps) {
  // The request keys: the opened month belongs to the chart only and never reloads anything.
  const windowKey = JSON.stringify(windowParams(query))
  const categoryKey = JSON.stringify(categoryParams(query))
  const loadMonthly = useMemo(() => {
    const params = JSON.parse(windowKey)
    return (signal: AbortSignal) => getTrendsMonthly(params, { signal })
  }, [windowKey])
  const loadPrices = useMemo(() => {
    const params = JSON.parse(windowKey)
    return (signal: AbortSignal) => getTrendsPrices(params, { signal })
  }, [windowKey])
  const loadLimits = useMemo(() => {
    const params = JSON.parse(windowKey)
    return (signal: AbortSignal) => getTrendsLimits(params, { signal })
  }, [windowKey])
  const loadCategory = useMemo(() => {
    const params = JSON.parse(categoryKey)
    return (signal: AbortSignal) => getTrendsCategory(params, { signal })
  }, [categoryKey])
  const monthly = useStatsRequest(loadMonthly)
  const category = useStatsRequest(loadCategory)
  const prices = useStatsRequest(loadPrices)
  const limits = useStatsRequest(loadLimits)
  // The first month with receipts and the server's month: only the ready periods use them, no block waits for them.
  const range = useStatsRequest(loadRange)
  const current = range.state.kind === 'ok' ? range.state.data.current_month : monthOfDate(new Date())
  const first = range.state.kind === 'ok' ? range.state.data.first_month : undefined

  return (
    <section className="stats-receipts trends" aria-labelledby="trends-heading">
      <h2 id="trends-heading">Как менялись траты и цены</h2>
      <p className="stats-intro">
        Траты семьи по месяцам, категории месяц к месяцу, лимиты, одна категория во времени и цены на одни и те же товары. Валюты не складываются: у каждой валюты свои графики.
      </p>
      <TrendsPeriodPicker query={query} current={current} first={first} />
      <SummaryStrip monthly={monthly.state} prices={prices.state} />
      <MonthlyBlock state={monthly.state} query={query} onRetry={monthly.retry} />
      <MonthToMonthBlock state={monthly.state} query={query} onRetry={monthly.retry} />
      <LimitsBlock state={limits.state} onRetry={limits.retry} />
      <CategoryBlock state={category.state} query={query} onRetry={category.retry} />
      <PricesBlock state={prices.state} onRetry={prices.retry} />
    </section>
  )
}
