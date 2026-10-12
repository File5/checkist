/** The dashboard part of «Динамика»: the summary strip, «Месяц к месяцу» and «Лимиты по месяцам». */
import { useId, useMemo } from 'react'
import type { TrendsLimits, TrendsMonthly, TrendsMonthlyCurrency, TrendsPrices } from '../../api/trends'
import RequestState from '../../components/RequestState'
import { Card, CardList, useNarrow } from '../../lib/cards'
import { sparkline } from '../../lib/charts/sparkline'
import { Link } from '../../navigation'
import type { TrendsQuery } from '../../navigation'
import { Badge, Failure, Panel } from './trends-blocks'
import { indexSummary, limitRows, loadingOf, monthRowHeadings, monthRows, moverCounts, spendSummary } from './trends-state'
import type { BlockState, MonthRow } from './trends-state'

/** A small line of every month of the window; the last month is a dot. Decoration: the numbers are next to it. */
export function Sparkline({ values }: { values: readonly number[] }) {
  const width = 96
  const height = 28
  const { line, last } = sparkline(values, width, height, 3)
  return (
    <svg className="trends-spark" viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true" focusable="false">
      <path d={line} />
      {last && <circle cx={last.x} cy={last.y} r={2.5} />}
    </svg>
  )
}

// --- сводка сверху ---

/** Big numbers on top: this month against the previous one and the average, the family price index. */
export function SummaryStrip({ monthly, prices }: { monthly: BlockState<TrendsMonthly>; prices: BlockState<TrendsPrices> }) {
  const spends = monthly.kind === 'ok' ? monthly.data.currencies : []
  const indices = prices.kind === 'ok' ? prices.data.currencies : []
  if (monthly.kind !== 'ok' && prices.kind !== 'ok') return null
  if (spends.length === 0 && indices.length === 0) return null
  return (
    <section className="trends-strip" aria-label="Коротко">
      {spends.map((block) => {
        const card = spendSummary(block)
        return (
          <article key={`spent-${block.currency}`} className="trends-card">
            <p className="trends-card-label">Потрачено <time dateTime={`${block.summary.month}-01`}>{card.monthTitle}</time>{spends.length > 1 && <> · {block.currency}</>}</p>
            <p className="trends-big">{card.spent}</p>
            {card.vsPrevious && <p className="trends-card-line"><Badge badge={card.vsPrevious.badge} label={card.vsPrevious.label} /> <span className="trends-card-note">{card.vsPrevious.label}</span></p>}
            {card.vsAverage && <p className="trends-card-line"><Badge badge={card.vsAverage.badge} label={card.vsAverage.label} /> <span className="trends-card-note">{card.vsAverage.label} ({card.average})</span></p>}
          </article>
        )
      })}
      {indices.map((block) => {
        const summary = indexSummary(block)
        if (!summary) return null
        return (
          <article key={`index-${block.currency}`} className="trends-card">
            <p className="trends-card-label">Цены на те же товары{indices.length > 1 && <> · {block.currency}</>}</p>
            <p className="trends-big"><Badge badge={summary.badge} /></p>
            <p className="trends-card-note">{summary.text}</p>
            <p className="trends-card-note">{moverCounts(block)}</p>
          </article>
        )
      })}
    </section>
  )
}

// --- «Месяц к месяцу» ---

const monthColumns = { name: 'Категория', trend: 'По месяцам', change: 'Изменение' }

function MonthRowCards({ rows, label, headings }: { rows: readonly MonthRow[]; label: string; headings: { previous: string; last: string } }) {
  return (
    <CardList label={label}>
      {rows.map((row) => (
        <Card key={row.key} title={<span className={row.depth > 0 ? 'trends-sub' : undefined}><Link to={row.href}>{row.name}</Link></span>} facts={[
          { key: 'trend', label: monthColumns.trend, value: <Sparkline values={row.values} /> },
          { key: 'previous', label: headings.previous, value: row.previous },
          { key: 'last', label: headings.last, value: row.last },
          { key: 'change', label: monthColumns.change, value: row.badge ? <Badge badge={row.badge} /> : '—' },
        ]} />
      ))}
    </CardList>
  )
}

function MonthToMonthCurrency({ block, query, several }: { block: TrendsMonthlyCurrency; query: TrendsQuery; several: boolean }) {
  const id = useId()
  const narrow = useNarrow()
  const rows = useMemo(() => monthRows(block, query), [block, query])
  const headings = monthRowHeadings(block)
  const label = `Месяц к месяцу, ${block.currency}`
  return (
    <article className="stats-currency trends-currency" aria-labelledby={id}>
      <h4 id={id}>{several ? block.currency : 'По категориям'}</h4>
      {rows.length === 0 ? <p className="stats-note">Трат по категориям за это время нет.</p> : narrow
        ? <MonthRowCards rows={rows} label={label} headings={headings} />
        : (
          <div className="trends-table-scroll" role="region" aria-label={label} tabIndex={0}>
            <table className="trends-table">
              <caption className="trends-hidden">{label}</caption>
              <thead>
                <tr>
                  <th scope="col">{monthColumns.name}</th>
                  <th scope="col">{monthColumns.trend}</th>
                  <th scope="col" className="trends-number">{headings.previous}</th>
                  <th scope="col" className="trends-number">{headings.last}</th>
                  <th scope="col" className="trends-number">{monthColumns.change}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className={row.depth > 0 ? 'trends-sub-row' : undefined}>
                    <th scope="row"><Link to={row.href}>{row.name}</Link></th>
                    <td><Sparkline values={row.values} /></td>
                    <td className="trends-number">{row.previous}</td>
                    <td className="trends-number">{row.last}</td>
                    <td className="trends-number">{row.badge ? <Badge badge={row.badge} /> : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
    </article>
  )
}

export function MonthToMonthBlock({ state, query, onRetry }: { state: BlockState<TrendsMonthly>; query: TrendsQuery; onRetry: () => void }) {
  const shown = loadingOf(state)
  return (
    <Panel title="Месяц к месяцу" state={state}
      note="Категории и их подкатегории: линия — все месяцы периода, суммы — два последних месяца, изменение — последний месяц к предыдущему. Название открывает категорию во времени.">
      {shown.kind === 'loading' ? <RequestState kind="loading" message="Загружаем категории…" />
        : shown.kind === 'ok' ? (shown.data.currencies.length === 0 ? <RequestState kind="empty" message="За это время трат нет." />
          : shown.data.currencies.map((block) => <MonthToMonthCurrency key={block.currency} block={block} query={query} several={shown.data.currencies.length > 1} />))
          : <Failure state={shown} onRetry={onRetry} />}
    </Panel>
  )
}

// --- «Лимиты по месяцам» ---

export function LimitsBlock({ state, onRetry }: { state: BlockState<TrendsLimits>; onRetry: () => void }) {
  const shown = loadingOf(state)
  const rows = useMemo(() => (shown.kind === 'ok' ? limitRows(shown.data.limits) : []), [shown])
  let body
  if (shown.kind === 'loading') body = <RequestState kind="loading" message="Загружаем лимиты…" />
  else if (shown.kind !== 'ok') body = <Failure state={shown} onRetry={onRetry} />
  else if (rows.length === 0) {
    body = <RequestState kind="empty" message="Лимитов пока нет: задайте их, и здесь будет видно, как получалось укладываться в бюджет."
      action={<Link className="action-link" to="/budget/limits">Задать лимиты</Link>} />
  } else {
    body = (
      <ul className="trends-limits">
        {rows.map((row) => (
          <li key={row.key} className="trends-limit">
            <div className="trends-limit-head">
              <span className="trends-row-name">{row.name}</span>
              <span className="trends-value trends-limit-amount">{row.amount} в месяц</span>
            </div>
            <ol className="trends-cells" aria-label={`${row.name}: доля лимита по месяцам`}>
              {row.cells.map((cell) => (
                <li key={cell.month} className={`trends-cell${cell.over ? ' trends-cell-over' : ''}`} title={`${cell.title}: ${cell.spent}, ${cell.percent} лимита`}>
                  <span className="trends-cell-month"><time dateTime={`${cell.month}-01`}>{cell.short}</time></span>
                  <span className="trends-cell-percent trends-value">{cell.over && <span aria-hidden="true">▲ </span>}{cell.percent}</span>
                  <span className="trends-cell-bar" aria-hidden="true"><span style={{ width: `${cell.fill}%` }} /></span>
                  {cell.over && <span className="trends-cell-word">сверх</span>}
                </li>
              ))}
            </ol>
            <p className="stats-note">{row.overCount === 0 ? 'Ни разу не вышли за лимит.' : `Сверх лимита: ${row.overCount} из ${row.cells.length} мес.`}</p>
          </li>
        ))}
      </ul>
    )
  }
  return (
    <Panel title="Лимиты по месяцам" state={state}
      note="Сколько процентов месячного лимита потрачено в каждом месяце; лимит — нынешняя сумма. Больше 100 % — сверх лимита.">
      {body}
    </Panel>
  )
}
