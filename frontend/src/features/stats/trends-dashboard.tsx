/** The dashboard part of «Динамика»: the summary strip, «Месяц к месяцу» and «Лимиты по месяцам». */
import { useId, useMemo } from 'react'
import type { TrendsLimits, TrendsMonthly, TrendsMonthlyCurrency, TrendsPrices } from '../../api/trends'
import RequestState from '../../components/RequestState'
import { Card, CardList, useNarrow } from '../../lib/cards'
import { sparkline } from '../../lib/charts/sparkline'
import { Link } from '../../navigation'
import type { TrendsQuery } from '../../navigation'
import { Badge, Failure, Panel } from './trends-blocks'
import { indexSummary, limitRows, loadingOf, monthName, monthRows, moverCounts, spendSummary } from './trends-state'
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

const monthColumns = { name: 'Категория', trend: 'По месяцам', change: 'Изменение', total: 'Итого за период', average: 'В среднем за месяц' }

/** The sparkline from the first month with spending; when it starts later than the window, the month is written beside it. */
function RowTrend({ row }: { row: MonthRow }) {
  return <span className="trends-row-trend"><Sparkline values={row.values} />{row.sparkFrom && <span className="trends-spark-from">{row.sparkFrom}</span>}</span>
}

/** A phone card: the trend, then every month of the window newest first with its change, then the sum and the average. */
export function MonthRowCards({ rows, label }: { rows: readonly MonthRow[]; label: string }) {
  return (
    <CardList label={label}>
      {rows.map((row) => (
        <Card key={row.key} title={<span className={row.depth > 0 ? 'trends-sub' : undefined}><Link to={row.href}>{row.name}</Link></span>} facts={[
          { key: 'trend', label: monthColumns.trend, value: <RowTrend row={row} /> },
          {
            key: 'months', label: 'Месяцы', value: (
              <ol className="trends-month-strip" aria-label={`${row.name}: по месяцам, сначала последний`}>
                {[...row.months].reverse().map((cell) => (
                  <li key={cell.month} className="trends-month-strip-row">
                    <time dateTime={`${cell.month}-01`}>{cell.title}</time>
                    <span className="trends-value">{cell.amount}</span>
                    <span className="trends-month-strip-change">{cell.badge ? <Badge badge={cell.badge} /> : '—'}</span>
                  </li>
                ))}
              </ol>
            ),
          },
          { key: 'total', label: monthColumns.total, value: row.total },
          { key: 'average', label: monthColumns.average, value: row.average },
        ]} />
      ))}
    </CardList>
  )
}

function MonthToMonthCurrency({ block, query, several }: { block: TrendsMonthlyCurrency; query: TrendsQuery; several: boolean }) {
  const id = useId()
  const narrow = useNarrow()
  const rows = useMemo(() => monthRows(block, query), [block, query])
  const months = block.months.map((entry) => entry.month)
  const label = `Месяц к месяцу, ${block.currency}`
  return (
    <article className="stats-currency trends-currency" aria-labelledby={id}>
      <h4 id={id}>{several ? block.currency : 'По категориям'}</h4>
      {rows.length === 0 ? <p className="stats-note">Трат по категориям за это время нет.</p> : narrow
        ? <MonthRowCards rows={rows} label={label} />
        : (
          <div className="trends-table-scroll" role="region" aria-label={label} tabIndex={0}>
            <table className="trends-table">
              <caption className="trends-hidden">{label}</caption>
              <thead>
                <tr>
                  <th scope="col">{monthColumns.name}</th>
                  <th scope="col">{monthColumns.trend}</th>
                  {months.map((month) => <th key={month} scope="col" className="trends-number"><time dateTime={`${month}-01`}>{monthName(month, true)}</time></th>)}
                  <th scope="col" className="trends-number">{monthColumns.total}</th>
                  <th scope="col" className="trends-number">{monthColumns.average}</th>
                  <th scope="col" className="trends-number">{monthColumns.change}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => (
                  <tr key={row.key} className={row.depth > 0 ? 'trends-sub-row' : undefined}>
                    <th scope="row"><Link to={row.href}>{row.name}</Link></th>
                    <td><RowTrend row={row} /></td>
                    {row.months.map((cell) => <td key={cell.month} className="trends-number">{cell.amount}</td>)}
                    <td className="trends-number">{row.total}</td>
                    <td className="trends-number">{row.average}</td>
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
      note="Категории и их подкатегории: суммы за каждый месяц периода, итог и среднее; линия начинается с первого месяца с тратами, изменение — месяц к предыдущему. Название открывает категорию во времени.">
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
              <span className="trends-value trends-limit-amount">{row.amount === null ? 'лимит удалён' : `сейчас ${row.amount} в месяц`}</span>
            </div>
            <ol className="trends-cells" aria-label={`${row.name}: доля лимита по месяцам`}>
              {row.cells.map((cell) => (
                <li key={cell.month} className={`trends-cell${cell.over ? ' trends-cell-over' : ''}${cell.none ? ' trends-cell-none' : ''}`}
                  title={`${cell.title}: ${cell.spent}${cell.none ? ', без лимита' : `, ${cell.percent} лимита ${cell.limit}`}${cell.change ? `; ${cell.change}` : ''}`}>
                  <span className="trends-cell-month">
                    <time dateTime={`${cell.month}-01`}>{cell.short}</time>
                    {cell.change && <span className="trends-cell-change"><span aria-hidden="true"> ◆</span><span className="trends-visually-hidden">, {cell.change}</span></span>}
                  </span>
                  <span className="trends-cell-percent trends-value">{cell.over && <span aria-hidden="true">▲ </span>}{cell.percent}</span>
                  <span className="trends-cell-bar" aria-hidden="true"><span style={{ width: `${cell.fill}%` }} /></span>
                  {cell.over && <span className="trends-cell-word">сверх</span>}
                </li>
              ))}
            </ol>
            <p className="stats-note">{row.overCount === 0 ? 'Ни разу не вышли за лимит.' : `Сверх лимита: ${row.overCount} из ${row.limitedCount} мес.`}</p>
            {row.changes.length > 0 && <ul className="trends-limit-changes" aria-label={`${row.name}: изменения лимита`}>
              {row.changes.map((text) => <li key={text}><span aria-hidden="true">◆ </span>{text}</li>)}
            </ul>}
          </li>
        ))}
      </ul>
    )
  }
  return (
    <Panel title="Лимиты по месяцам" state={state}
      note="Сколько процентов лимита того месяца потрачено в каждом месяце; ◆ — в этом месяце лимит меняли. Больше 100 % — сверх лимита.">
      {body}
    </Panel>
  )
}
