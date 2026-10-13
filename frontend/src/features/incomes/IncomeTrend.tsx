import { useMemo } from 'react'
import type { ReactNode } from 'react'
import { getIncomeTrends } from '../../api/incomes'
import RequestState from '../../components/RequestState'
import { LineChart } from '../../lib/charts'
import { Link } from '../../navigation'
import type { TrendsQuery } from '../../navigation'
import { useStatsRequest } from '../stats/receipts-request'
import { Failure, Panel } from '../stats/trends-blocks'
import { formatMonthStart, formatMonthTick, loadingOf, moneyAxis, windowParams } from '../stats/trends-state'
import { incomeSeries } from './incomes-state'

/** «Доход и отложено» of «Динамика»: its own request over the window of the screen, in the base currency of the family. */
export default function IncomeTrend({ query }: { query: TrendsQuery }) {
  const key = JSON.stringify(windowParams(query))
  const load = useMemo(() => {
    const params = JSON.parse(key)
    return (signal: AbortSignal) => getIncomeTrends(params, { signal })
  }, [key])
  const { state, retry } = useStatsRequest(load)
  const shown = loadingOf(state)
  let body: ReactNode
  switch (shown.kind) {
    case 'loading': body = <RequestState kind="loading" message="Загружаем доходы по месяцам…" />; break
    case 'ok': body = shown.data.items.some((item) => item.income !== null)
      ? <LineChart title={`Доход и отложено, ${shown.data.base_currency}`} series={incomeSeries(shown.data)} interval="month" zeroBaseline
        formatX={formatMonthStart} formatTick={formatMonthTick} formatValue={moneyAxis} valueAxisLabel={shown.data.base_currency} intervalHeader="Месяц" />
      : <RequestState kind="empty" message="За это время доходов нет." action={<Link className="action-link" to="/receipts/new?kind=income">Внести доход</Link>} />
      break
    default: body = <Failure state={shown} onRetry={retry} />
  }
  return <Panel title="Доход и отложено" state={state}
    note="Доход семьи и то, что от него осталось после трат месяца, в основной валюте по курсу дня. Месяц без внесённого дохода — разрыв линии.">
    {body}
  </Panel>
}
