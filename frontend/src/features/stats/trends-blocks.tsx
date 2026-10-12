import { useId, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import type { TrendsCategory, TrendsCategoryCurrency, TrendsCategoryOption, TrendsMonthly, TrendsMonthlyCurrency, TrendsPrices, TrendsPricesCurrency } from '../../api/trends'
import RequestState from '../../components/RequestState'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import { LineChart, StackedColumns } from '../../lib/charts'
import { currencySymbol } from '../../lib/money'
import { Link, navigate } from '../../navigation'
import type { TrendsQuery } from '../../navigation'
import { canRetry, failureMessage } from './receipts-state'
import {
  categoryChart, categoryHeading, categoryHref, closeMonthHref, formatMonthStart, formatMonthTick, indexAxis, indexChart, indexSummary,
  lastMonthChange, monthBreakdown, monthStart, monthlyChart, monthlySummary, moneyAxis, moverCounts, moverRows, optionLabel, partsChart,
} from './trends-state'
import { loadingOf } from './trends-state'
import type { BlockState, ChangeBadge, MoverRow } from './trends-state'


/** A change as arrow, sign and words — never colour alone. `up` is the over tone: more spent, prices grew. */
export function Badge({ badge, label }: { badge: ChangeBadge; label?: string }) {
  return (
    <span className={`trends-badge trends-badge-${badge.tone}`} title={label ? `${badge.words} ${label}` : badge.words}>
      <span aria-hidden="true">{badge.arrow}</span> <span className="trends-value">{badge.text}</span>
      <span className="trends-hidden"> ({badge.words}{label ? ` ${label}` : ''})</span>
    </span>
  )
}

export function Failure({ state, onRetry }: { state: Exclude<BlockState<unknown>, { kind: 'ok' | 'idle' | 'loading' }>; onRetry: () => void }) {
  return canRetry(state) ? <RequestState kind="error" message={failureMessage(state)} onRetry={onRetry} />
    : <RequestState kind="empty" message={failureMessage(state)} />
}

/**
 * A card of the screen: the heading with an optional link on the right, the content, then the explanation in small
 * print — the numbers come first, as on «Главная».
 */
export function Panel({ title, note, state, link, children }: {
  title: string; note?: string; state: { kind: string }
  /** A link at the right of the heading, e.g. «Изменить» to the limits. */
  link?: { to: string; label: string }
  children: ReactNode
}) {
  const id = useId()
  const phase = useMemo(() => ({ kind: state.kind === 'idle' ? 'loading' : state.kind } as { kind: 'loading' | 'ok' | 'error' }), [state])
  const block = useLocalRequestFocus<HTMLElement>(phase)
  return (
    <section ref={block} className="stats-panel trends-panel" aria-labelledby={id} aria-busy={state.kind === 'loading' || state.kind === 'idle'}>
      <div className="stats-panel-head">
        <h3 id={id} data-request-focus-target tabIndex={-1}>{title}</h3>
        {link && <Link className="stats-panel-link" to={link.to}>{link.label}</Link>}
      </div>
      {children}
      {note && <p className="stats-note stats-footnote">{note}</p>}
    </section>
  )
}

// --- «Траты по месяцам» ---

function MonthDetails({ block, month, query }: { block: TrendsMonthlyCurrency; month: string | undefined; query: TrendsQuery }) {
  const details = monthBreakdown(block, month)
  if (!details) return <p className="stats-note">Нажмите на столбец, чтобы увидеть траты месяца по категориям.</p>
  return (
    <div className="trends-month" aria-live="polite">
      <div className="trends-month-head">
        <p className="trends-month-title"><time dateTime={monthStart(details.month)}>{details.title}</time></p>
        <p className="trends-big">{details.total}</p>
      </div>
      {details.rows.length > 0 ? (
        <ul className="trends-rows">
          {details.rows.map((row) => (
            <li key={row.key} className={`trends-row trends-cat-${row.tone}`}>
              <span className="trends-dot" aria-hidden="true" />
              <span className="trends-row-main">
                {row.href ? <Link className="trends-row-name" to={row.href}>{row.label}</Link> : <span className="trends-row-name">{row.label}</span>}
                {row.bar > 0 && <span className="trends-row-bar" aria-hidden="true"><span style={{ width: `${row.bar}%` }} /></span>}
              </span>
              <span className="trends-value">{row.amount}</span>
            </li>
          ))}
        </ul>
      ) : <p className="stats-note">В этом месяце трат не было.</p>}
      <p className="trends-links">
        <Link className="trends-link" to={details.spendingHref}>Траты месяца подробно →</Link>
        <Link className="trends-link" to={closeMonthHref(query)}>Закрыть месяц</Link>
      </p>
    </div>
  )
}

function MonthlyCurrency({ block, query, several }: { block: TrendsMonthlyCurrency; query: TrendsQuery; several: boolean }) {
  const id = useId()
  const chart = useMemo(() => monthlyChart(block, query), [block, query])
  const summary = monthlySummary(block)
  const title = `Траты по месяцам, ${block.currency}`
  return (
    <article className="stats-currency trends-currency" aria-labelledby={id}>
      <div className="trends-summary">
        <h4 id={id}>Всего за период{several && `, ${currencySymbol(block.currency)}`}</h4>
        <p className="trends-big">{summary.total}</p>
        <p className="stats-note">В среднем <span className="trends-value">{summary.average}</span> в месяц</p>
      </div>
      <StackedColumns title={title} columns={chart.columns} legend={chart.legend} activeX={query.month ? monthStart(query.month) : null}
        formatX={formatMonthStart} formatTick={formatMonthTick} formatValue={moneyAxis} valueAxisLabel={block.currency} linkComponent={Link} />
      <MonthDetails block={block} month={query.month} query={query} />
    </article>
  )
}

export function MonthlyBlock({ state, query, onRetry }: { state: BlockState<TrendsMonthly>; query: TrendsQuery; onRetry: () => void }) {
  const shown = loadingOf(state)
  let body: ReactNode
  switch (shown.kind) {
    case 'loading': body = <RequestState kind="loading" message="Загружаем траты по месяцам…" />; break
    case 'ok': body = shown.data.currencies.length === 0
      ? <RequestState kind="empty" message="За это время трат нет. Снимите чек или добавьте трату — месяцы появятся здесь." />
      : shown.data.currencies.map((block) => <MonthlyCurrency key={block.currency} block={block} query={query} several={shown.data.currencies.length > 1} />)
      break
    default: body = <Failure state={shown} onRetry={onRetry} />
  }
  return (
    <Panel title="Траты по месяцам" state={state}
      note="Столбец — всё потраченное за месяц, с возвратами; цвета — категории верхнего уровня, как на главной. «Без категории» — услуги, залоги, строки без категории и скидки на весь чек.">
      {body}
    </Panel>
  )
}

// --- «Категория во времени» ---

function CategoryPicker({ options, query, current }: { options: readonly TrendsCategoryOption[]; query: TrendsQuery; current: number | null }) {
  const id = useId()
  if (options.length === 0) return null
  return (
    <div className="stats-field trends-picker">
      <label htmlFor={id}>Категория</label>
      <select id={id} value={current ?? ''} onChange={(event) => navigate(categoryHref(query, Number(event.target.value) || undefined))}>
        {current === null && <option value="">Выберите категорию</option>}
        {options.map((option) => <option key={option.id} value={option.id}>{optionLabel(option.path)}</option>)}
      </select>
    </div>
  )
}

function CategoryCurrency({ block, several, name }: { block: TrendsCategoryCurrency; several: boolean; name: string }) {
  const id = useId()
  const series = useMemo(() => categoryChart(block), [block])
  const parts = useMemo(() => partsChart(block, name, block.months.map((entry) => entry.month)), [block, name])
  const change = lastMonthChange(block)
  const summary = monthlySummary(block)
  return (
    <article className="stats-currency trends-currency" aria-labelledby={id}>
      <div className="trends-summary">
        <h4 id={id}>Последний месяц{several && `, ${currencySymbol(block.currency)}`}</h4>
        {change && <>
          <p className="trends-big">{change.last}</p>
          <p className={`trends-compare trends-compare-${change.tone}`}>{change.text}</p>
        </>}
        <p className="stats-note">В среднем <span className="trends-value">{summary.average}</span> в месяц, за период <span className="trends-value">{summary.total}</span></p>
      </div>
      <LineChart title={`${name}: траты по месяцам, ${block.currency}`} series={series} interval="month" zeroBaseline
        formatX={formatMonthStart} formatTick={formatMonthTick} formatValue={moneyAxis} valueAxisLabel={block.currency} intervalHeader="Месяц" />
      {parts && <>
        <h5 className="trends-subheading">Из чего складывается</h5>
        <StackedColumns title={`${name}: подкатегории по месяцам, ${block.currency}`} columns={parts.columns} legend={parts.legend}
          formatX={formatMonthStart} formatTick={formatMonthTick} formatValue={moneyAxis} valueAxisLabel={block.currency} />
      </>}
    </article>
  )
}

export function CategoryBlock({ state, query, onRetry }: { state: BlockState<TrendsCategory>; query: TrendsQuery; onRetry: () => void }) {
  const shown = loadingOf(state)
  // The picker stays while another category loads: the focus does not leave the list under the finger.
  const [options, setOptions] = useState<readonly TrendsCategoryOption[]>([])
  if (shown.kind === 'ok' && shown.data.options !== options) setOptions(shown.data.options)
  const current = shown.kind === 'ok' ? shown.data.category?.id ?? null : query.category ?? null
  let body: ReactNode
  switch (shown.kind) {
    case 'loading': body = <RequestState kind="loading" message="Загружаем траты категории…" />; break
    case 'ok': {
      const { data } = shown
      const heading = categoryHeading(data)
      body = data.category === null
        ? <RequestState kind="empty" message="За это время трат по категориям нет." />
        : <>
          <p className="trends-category-name">{heading}{data.suggested && <span className="stats-note"> · выбрана категория, где тратили чаще всего</span>}</p>
          {data.currencies.length === 0
            ? <RequestState kind="empty" message="В этой категории за это время трат нет. Выберите другую категорию." />
            : data.currencies.map((block) => <CategoryCurrency key={block.currency} block={block} several={data.currencies.length > 1} name={heading} />)}
        </>
      break
    }
    default: body = shown.reason === 'not_found'
      ? <RequestState kind="empty" message="Такой категории нет." action={<Link className="action-link" to={categoryHref(query, undefined)}>Показать предложенную</Link>} />
      : <Failure state={shown} onRetry={onRetry} />
  }
  return (
    <Panel title="Категория во времени" state={state}
      note="Сколько уходит на одну категорию с подкатегориями каждый месяц — например, коммунальные услуги или аренда. Пунктир — среднее за период, месяц без трат — ноль.">
      <CategoryPicker options={options} query={query} current={current} />
      {body}
    </Panel>
  )
}

// --- «Как менялись цены» ---

function Movers({ title, rows, tone }: { title: string; rows: readonly MoverRow[]; tone: 'more' | 'less' }) {
  const id = useId()
  return (
    <section className="trends-movers" aria-labelledby={id}>
      <h5 id={id}>{title}</h5>
      {rows.length === 0 ? <p className="stats-note">Таких товаров нет.</p> : (
        <ol className="trends-mover-list">
          {rows.map((row) => (
            <li key={row.key} className="trends-mover">
              <Link className="trends-mover-name" to={`/catalog/products/${row.productId}`}>{row.name}</Link>
              <span className={`trends-badge trends-badge-${tone === 'more' ? 'up' : 'down'}`}>
                <span aria-hidden="true">{tone === 'more' ? '▲' : '▼'}</span> <span className="trends-value">{row.change}</span>
              </span>
              <span className="trends-mover-prices"><span className="trends-value">{row.old}</span> → <span className="trends-value">{row.next}</span></span>
              <span className="trends-mover-months stats-note">{row.oldMonth} → {row.newMonth}</span>
            </li>
          ))}
        </ol>
      )}
    </section>
  )
}

function PricesCurrency({ block, several }: { block: TrendsPricesCurrency; several: boolean }) {
  const id = useId()
  const series = useMemo(() => indexChart(block), [block])
  const summary = indexSummary(block)
  const risers = useMemo(() => moverRows(block.risers, block.currency), [block])
  const fallers = useMemo(() => moverRows(block.fallers, block.currency), [block])
  return (
    <article className="stats-currency trends-currency" aria-labelledby={id}>
      <div className="trends-summary">
        <h4 id={id}>Индекс цен семьи{several && `, ${currencySymbol(block.currency)}`}</h4>
        {summary && <p className="trends-lead">{summary.text} <Badge badge={summary.badge} /></p>}
        <p className="trends-counts">{moverCounts(block)}</p>
      </div>
      <LineChart title={`Индекс цен семьи, ${block.currency}`} series={series} interval="month"
        formatX={formatMonthStart} formatTick={formatMonthTick} formatValue={indexAxis} intervalHeader="Месяц"
        valueAxisLabel="индекс; 100 — первый месяц с покупками, месяц без общих с прошлыми покупками товаров — разрыв линии" />
      <div className="trends-movers-grid">
        <Movers title="Сильнее всего подорожало" rows={risers} tone="more" />
        <Movers title="Сильнее всего подешевело" rows={fallers} tone="less" />
      </div>
      <p className="stats-note">Цена — оплаченная сумма за единицу в первом и последнем месяце покупки. Товаров, купленных хотя бы в двух месяцах: {block.products_total.toLocaleString('ru-RU')}.</p>
    </article>
  )
}

export function PricesBlock({ state, onRetry }: { state: BlockState<TrendsPrices>; onRetry: () => void }) {
  const shown = loadingOf(state)
  let body: ReactNode
  switch (shown.kind) {
    case 'loading': body = <RequestState kind="loading" message="Загружаем цены…" />; break
    case 'ok': body = shown.data.currencies.length === 0
      ? <RequestState kind="empty" message="За это время нет покупок товаров из чеков с фото: сравнивать цены не с чем." />
      : shown.data.currencies.map((block) => <PricesCurrency key={block.currency} block={block} several={shown.data.currencies.length > 1} />)
      break
    default: body = <Failure state={shown} onRetry={onRetry} />
  }
  return (
    <Panel title="Как менялись цены" state={state}
      note="Индекс сравнивает цены одних и тех же товаров в соседних месяцах (индекс Фишера) и складывает изменения цепочкой. Товары есть только в чеках с фото: ручные траты без товаров в расчёт не входят.">
      {body}
    </Panel>
  )
}
