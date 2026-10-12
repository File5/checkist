/** The dashboard part of «Динамика»: the summary strip, «Месяц к месяцу» and «Лимиты по месяцам». */
import { useId, useMemo } from 'react'
import type { TrendsLimits, TrendsMonthly, TrendsMonthlyCurrency, TrendsPrices } from '../../api/trends'
import RequestState from '../../components/RequestState'
import { categoryTone } from '../../lib/category-tone'
import { useNarrow } from '../../lib/cards'
import { sparkline } from '../../lib/charts/sparkline'
import { currencySymbol } from '../../lib/money'
import { Link } from '../../navigation'
import type { TrendsQuery } from '../../navigation'
import { Badge, Failure, Panel } from './trends-blocks'
import { indexSummary, limitRows, loadingOf, monthName, monthRowHeadings, monthRows, moverCounts, spendSummary } from './trends-state'
import type { BlockState, ChangeBadge, LimitCell, MonthRow } from './trends-state'

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

/**
 * A change in words, like the hero card of «Главная»: «▲ на 10,50 % больше, чем в сентябре 2026». More spent is the
 * over tone, less — the success tone; the arrow and the words say it too, never the colour alone.
 */
export function ChangeLine({ badge, label, extra }: { badge: ChangeBadge; label: string; extra?: string }) {
  const words = badge.tone === 'same' ? `столько же, ${label.replace(/^чем/, 'сколько')}`
    : `на ${badge.magnitude} ${badge.tone === 'up' ? 'больше' : 'меньше'}, ${label}`
  return (
    <p className={`trends-change trends-change-${badge.tone}`}>
      <span aria-hidden="true">{badge.arrow}</span> {words}{extra && <> <span className="trends-value">{extra}</span></>}
    </p>
  )
}

/** Big numbers on top: this month against the previous one and the average, the family price index. */
export function SummaryStrip({ monthly, prices }: { monthly: BlockState<TrendsMonthly>; prices: BlockState<TrendsPrices> }) {
  const spends = monthly.kind === 'ok' ? monthly.data.currencies : []
  const indices = prices.kind === 'ok' ? prices.data.currencies : []
  if (monthly.kind !== 'ok' && prices.kind !== 'ok') return null
  if (spends.length === 0 && indices.length === 0) return null
  return (
    <section className="trends-strip" aria-label="Коротко">
      {spends.map((block, index) => {
        const card = spendSummary(block)
        return (
          <article key={`spent-${block.currency}`} className="trends-card">
            <p className="trends-card-label">Потрачено за <time dateTime={`${block.summary.month}-01`}>{card.monthTitle}</time>{spends.length > 1 && <> · {currencySymbol(block.currency)}</>}</p>
            {/* The one hero sum of the screen is the first currency; another one is large, not hero. */}
            <p className={index === 0 ? 'trends-big ck-hero-figure' : 'trends-big'}>{card.spent}</p>
            {card.vsPrevious && <ChangeLine badge={card.vsPrevious.badge} label={card.vsPrevious.label} />}
            {card.vsAverage && <ChangeLine badge={card.vsAverage.badge} label={card.vsAverage.label} extra={`(${card.average})`} />}
          </article>
        )
      })}
      {indices.map((block) => {
        const summary = indexSummary(block)
        if (!summary) return null
        return (
          <article key={`index-${block.currency}`} className="trends-card">
            <p className="trends-card-label">Цены на те же товары{indices.length > 1 && <> · {currencySymbol(block.currency)}</>}</p>
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

/**
 * The phone view of the table: a row of a list per category — its name and the last month on the first line, the
 * sparkline and the change on the second. A tap opens the row: every month of the window newest first with its
 * change, the sum, the average and the way to the category over time.
 */
export function MonthRowCards({ rows, label }: { rows: readonly MonthRow[]; label: string }) {
  return (
    <ul className="trends-mm" aria-label={label}>
      {rows.map((row) => (
        <li key={row.key} className={row.depth > 0 ? 'trends-mm-row trends-mm-sub' : `trends-mm-row trends-cat-${categoryTone(row.id)}`}>
          <details className="trends-mm-details">
            <summary className="trends-mm-summary">
              <span className="trends-mm-head">
                {row.depth === 0 && <span className="trends-dot" aria-hidden="true" />}
                <span className="trends-mm-name">{row.name}</span>
                <span className="trends-mm-last trends-value">{row.last}</span>
              </span>
              <span className="trends-mm-meta">
                <RowTrend row={row} />
                {row.badge ? <Badge badge={row.badge} /> : <span className="trends-mm-none" aria-hidden="true">—</span>}
              </span>
            </summary>
            <div className="trends-mm-body">
              <ol className="trends-month-strip" aria-label={`${row.name}: по месяцам, сначала последний`}>
                {[...row.months].reverse().map((cell) => (
                  <li key={cell.month} className="trends-month-strip-row">
                    <time dateTime={`${cell.month}-01`}>{cell.title}</time>
                    <span className="trends-value">{cell.amount}</span>
                    <span className="trends-month-strip-change">{cell.badge ? <Badge badge={cell.badge} /> : '—'}</span>
                  </li>
                ))}
              </ol>
              <dl className="trends-mm-totals">
                <div><dt>{monthColumns.total}</dt><dd className="trends-value">{row.total}</dd></div>
                <div><dt>{monthColumns.average}</dt><dd className="trends-value">{row.average}</dd></div>
              </dl>
              <Link className="trends-link" to={row.href}>Категория во времени →</Link>
            </div>
          </details>
        </li>
      ))}
    </ul>
  )
}

function MonthToMonthCurrency({ block, query, several }: { block: TrendsMonthlyCurrency; query: TrendsQuery; several: boolean }) {
  const id = useId()
  const narrow = useNarrow()
  const rows = useMemo(() => monthRows(block, query), [block, query])
  const months = block.months.map((entry) => entry.month)
  const label = `Месяц к месяцу, ${block.currency}`
  const headings = monthRowHeadings(block)
  return (
    <article className="stats-currency trends-currency" aria-labelledby={id}>
      <h4 id={id}>По категориям{several && `, ${currencySymbol(block.currency)}`}</h4>
      {rows.length === 0 ? <p className="stats-note">Трат по категориям за это время нет.</p> : narrow
        ? <>
          <p className="trends-mm-caption">Сумма за {headings.last}, изменение — к прошлому месяцу</p>
          <MonthRowCards rows={rows} label={label} />
        </>
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

/** One month with a limit: the month, the bar of the share used, the percent; the spent sum against the limit under it. */
function LimitMonth({ cell }: { cell: LimitCell }) {
  return (
    <li className={`trends-cell${cell.over ? ' trends-cell-over' : ''}${cell.none ? ' trends-cell-none' : ''}`}
      title={`${cell.title}: ${cell.spent}${cell.none ? ', без лимита' : `, ${cell.percent} лимита ${cell.limit}`}${cell.change ? `; ${cell.change}` : ''}`}>
      <span className="trends-cell-month">
        <time dateTime={`${cell.month}-01`}>{cell.short}</time>
        {cell.change && <span className="trends-cell-change"><span aria-hidden="true"> ◆</span><span className="trends-visually-hidden">, {cell.change}</span></span>}
      </span>
      <span className="trends-cell-bar" aria-hidden="true"><span style={{ width: `${cell.fill}%` }} /></span>
      <span className="trends-cell-percent trends-value">{cell.over && <span aria-hidden="true">▲ </span>}{cell.percent}</span>
      <span className="trends-cell-sums">
        <span className="trends-value">{cell.spent}</span>{!cell.none && <> из <span className="trends-value">{cell.limit}</span></>}
        {cell.over && <span className="trends-cell-word"> · сверх</span>}
      </span>
    </li>
  )
}

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
        {rows.map((row) => {
          // Months with a limit, newest first; the months without one are counted in a line, not drawn one by one.
          const limited = row.cells.filter((cell) => !cell.none).reverse()
          const free = row.cells.length - limited.length
          return (
            <li key={row.key} className={`trends-limit trends-cat-${row.tone}`}>
              <div className="trends-limit-head">
                <span className="trends-dot" aria-hidden="true" />
                <span className="trends-row-name">{row.name}</span>
                <span className="trends-value trends-limit-amount">{row.amount === null ? 'лимит удалён' : `${row.amount} в месяц`}</span>
              </div>
              {limited.length > 0 && <ol className="trends-cells" aria-label={`${row.name}: доля лимита по месяцам`}>
                {limited.map((cell) => <LimitMonth key={cell.month} cell={cell} />)}
              </ol>}
              <div className="trends-limit-foot">
                <p className="trends-limit-note">
                  {row.limitedCount === 0 ? 'Лимита в эти месяцы не было.'
                    : row.overCount === 0 ? 'Ни разу не вышли за лимит.' : `Сверх лимита: ${row.overCount} из ${row.limitedCount} мес.`}
                  {free > 0 && row.limitedCount > 0 && ` Без лимита: ${free} мес.`}
                </p>
                {row.changes.length > 0 && <ul className="trends-limit-changes" aria-label={`${row.name}: изменения лимита`}>
                  {row.changes.map((text) => <li key={text}><span aria-hidden="true">◆ </span>{text}</li>)}
                </ul>}
              </div>
            </li>
          )
        })}
      </ul>
    )
  }
  return (
    <Panel title="Лимиты по месяцам" state={state} link={{ to: '/budget/limits', label: 'Изменить' }}
      note="Сколько процентов лимита того месяца потрачено в каждом месяце; ◆ — в этом месяце лимит меняли. Больше 100 % — сверх лимита.">
      {body}
    </Panel>
  )
}
