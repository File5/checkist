import { useMemo } from 'react'
import { getTrendsCategory, getTrendsLimits, getTrendsMonthly, getTrendsPrices } from '../../api/trends'
import { Link } from '../../navigation'
import type { TrendsPageProps } from '../../pages/types'
import { useStatsRequest } from './receipts-request'
import { CategoryBlock, MonthlyBlock, PricesBlock } from './trends-blocks'
import { LimitsBlock, MonthToMonthBlock, SummaryStrip } from './trends-dashboard'
import { categoryParams, windowChoices, windowParams } from './trends-state'
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

  return (
    <section className="stats-receipts trends" aria-labelledby="trends-heading">
      <h2 id="trends-heading">Как менялись траты и цены</h2>
      <p className="stats-intro">
        Траты семьи по месяцам, категории месяц к месяцу, лимиты, одна категория во времени и цены на одни и те же товары. Валюты не складываются: у каждой валюты свои графики.
      </p>
      <nav className="stats-intervals" aria-label="Период">
        <span className="stats-presets-title">Период:</span>
        <ul>
          {windowChoices(query).map((choice) => (
            <li key={choice.months}>
              <Link className="stats-chip" to={choice.href} aria-current={choice.active ? 'true' : undefined}>{choice.label}</Link>
            </li>
          ))}
        </ul>
      </nav>
      <SummaryStrip monthly={monthly.state} prices={prices.state} />
      <MonthlyBlock state={monthly.state} query={query} onRetry={monthly.retry} />
      <MonthToMonthBlock state={monthly.state} query={query} onRetry={monthly.retry} />
      <LimitsBlock state={limits.state} onRetry={limits.retry} />
      <CategoryBlock state={category.state} query={query} onRetry={category.retry} />
      <PricesBlock state={prices.state} onRetry={prices.retry} />
    </section>
  )
}
