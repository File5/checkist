import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { getCategorySpends } from '../../api/budget'
import type { CategorySpendCurrency, CategorySpendItem, CategorySpends } from '../../api/budget'
import Icon from '../../components/Icon'
import { usePageTitle } from '../../components/page-header'
import RequestState from '../../components/RequestState'
import { currencySymbol, formatMoney } from '../../lib/money'
import { Link } from '../../navigation'
import { capitalize, dashboardErrorMessage, dayAndMonth, deviceMonth, inMonth, monthSlide, monthTitle, plural, shiftMonth } from './dashboard-state'
import { glue } from '../../lib/text'
import type { MonthSlide } from './dashboard-state'
import { categorySpendsHref, partShare, showsLines, spendNote, spendSource, spendTitle, wholeReceipt } from './category-spends-state'
import { categoryTone } from '../../lib/category-tone'
import './Dashboard.css'

function SpendItem({ item, currency, tone }: { item: CategorySpendItem; currency: string; tone: number }) {
  const note = spendNote(item)
  const whole = wholeReceipt(item, currency)
  return <li className="cat-spend">
    <Link className="cat-spend-row" to={`/receipts/${item.receipt_id}`}>
      {/* By a receipt or by hand, as in «Траты»: the picture says it, the meta line names it. */}
      <span className={`cat-spend-badge dash-cat-${tone}`} aria-hidden="true"><Icon name={item.source === 'photo' ? 'receipt' : 'pencil'} size={20} /></span>
      <span className="cat-spend-main">
        <span className="cat-spend-title">{spendTitle(item)}</span>
        {note && <span className="cat-spend-note">{note}</span>}
        <span className="cat-spend-meta"><time dateTime={item.purchased_on}>{dayAndMonth(item.purchased_on)}</time> · {spendSource(item)} · {item.owner_name}</span>
      </span>
      <span className="cat-spend-amount">
        <span className="ck-figures">{formatMoney(item.category_amount, currency)}</span>
        {whole && <span className="cat-spend-whole">{whole}</span>}
      </span>
    </Link>
    {showsLines(item) && <details className="cat-spend-lines">
      <summary>Позиции: {item.lines.length.toLocaleString('ru-RU')}</summary>
      <ul>{item.lines.map((line) => <li key={line.id} className="ck-leader">
        <span className="cat-spend-line-name">{line.name}<span className="cat-spend-line-category"> · {line.category_name}</span></span>
        <span className="ck-figures">{formatMoney(line.amount, currency)}</span>
      </li>)}</ul>
    </details>}
  </li>
}

/** «‹ Октябрь 2026 ›» in the head of the first card: the month of the category, its steps through the address. */
function MonthSteps({ categoryId, month, today }: { categoryId: number; month: string; today: string }) {
  return <nav className="cat-month" aria-label="Месяц">
    <span className="cat-spends-month">{monthTitle(month)}</span>
    <span className="cat-month-steps">
      <Link className="ck-round dash-month-step" to={categorySpendsHref(categoryId, shiftMonth(month, -1))} aria-label="Предыдущий месяц"><Icon name="back" size={20} /></Link>
      {month < today
        ? <Link className="ck-round dash-month-step" to={categorySpendsHref(categoryId, shiftMonth(month, 1))} aria-label="Следующий месяц"><Icon name="forward" size={20} /></Link>
        : <span className="ck-round dash-month-step dash-month-step-off" aria-hidden="true"><Icon name="forward" size={20} /></span>}
    </span>
  </nav>
}

function CurrencyBlock({ block, month, hero, categoryName, tone, steps }: {
  block: CategorySpendCurrency; month: string; hero: boolean; categoryName: string; tone: number; steps?: ReactNode
}) {
  const headingId = `cat-spends-items-${block.currency}`
  const parts = block.parts.filter((part) => !part.direct || block.parts.length > 1)
  return <>
    <section className="ck-panel dash-card cat-spends-total" aria-label={`Потрачено, ${block.currency}`}>
      {steps}
      <p className="dash-label">{steps ? 'Потрачено' : `Потрачено ${inMonth(month)}`}{hero ? '' : `, ${currencySymbol(block.currency)}`}</p>
      <p className={`dash-total ${hero ? 'ck-hero-figure' : 'ck-figures dash-total-plain'}`}>{formatMoney(block.total, block.currency)}</p>
      <p className="dash-note cat-spends-count">{glue(block.receipts_count.toLocaleString('ru-RU'), plural(block.receipts_count, 'чек или трата', 'чека или траты', 'чеков и трат'))}</p>
      {parts.length > 0 && <ul className="cat-parts" aria-label="Из чего сложилось">
        {parts.map((part) => {
          const share = partShare(part, block.total)
          const body = <>
            <span className="cat-part-head">
              <span className="dash-dot" aria-hidden="true" />
              <span className="cat-part-name">{part.direct ? `${categoryName} без подкатегории` : part.name}</span>
              <span className="cat-part-amount ck-figures">{formatMoney(part.amount, block.currency)}</span>
            </span>
            <span className="dash-bar dash-bar-small" aria-hidden="true"><span className="dash-bar-fill" style={{ width: `${share}%` }} /></span>
          </>
          return <li key={`${part.id}:${part.direct}`} className={`dash-limit dash-cat-${categoryTone(part.id)}`}>
            {part.direct ? <span className="cat-part">{body}</span>
              : <Link className="cat-part cat-part-link" to={categorySpendsHref(part.id, month)}>{body}</Link>}
          </li>
        })}
      </ul>}
    </section>
    <section className="ck-panel dash-card cat-spends-items" aria-labelledby={headingId}>
      <div className="ck-panel-head"><h2 id={headingId}>Траты и чеки{hero ? '' : ` · ${currencySymbol(block.currency)}`}</h2></div>
      <ul className="cat-spend-list">{block.items.map((item) => <SpendItem key={item.receipt_id} item={item} currency={block.currency} tone={tone} />)}</ul>
    </section>
  </>
}

export type CategorySpendsViewProps = { data: CategorySpends; today?: string; slide?: MonthSlide }

/** The screen without loading: the markup tests render it directly. The name of the category is the heading of the
 * page (the header row of the shell); the categories above it are links under the heading. */
export function CategorySpendsView({ data, today = deviceMonth(), slide }: CategorySpendsViewProps) {
  const { category, month } = data
  const ancestors = category.path.slice(0, -1)
  usePageTitle(category.name)
  const tone = categoryTone(category.path[0]?.id ?? category.id)
  const steps = <MonthSteps categoryId={category.id} month={month} today={today} />
  return <div className={`dash cat-spends${slide ? ` dash-slide-${slide}` : ''}`}>
    {ancestors.length > 0 && <nav className="cat-crumbs" aria-label="Категории выше">
      {ancestors.map((step) => <Link key={step.id} to={categorySpendsHref(step.id, month)}>{step.name}</Link>)}
    </nav>}
    {data.currencies.length
      ? data.currencies.map((block, index) => <CurrencyBlock key={block.currency} block={block} month={month} hero={index === 0} categoryName={category.name}
        tone={tone} steps={index === 0 ? steps : undefined} />)
      : <>
        <section className="ck-panel dash-card cat-spends-total" aria-label="Месяц">{steps}</section>
        <RequestState kind="empty" title={`${capitalize(inMonth(month))} трат в этой категории ${month < today ? 'не было' : 'пока нет'}`}
          message="Траты появятся здесь, как только в категории будет хотя бы одна строка чека или трата."
          action={<Link className="action-link" to={month === today ? '/' : `/?month=${month}`}>На главную</Link>} />
      </>}
  </div>
}

type Load = { key: string } & ({ kind: 'error'; message: string; notFound: boolean } | { kind: 'ok'; data: CategorySpends; slide?: MonthSlide })

/** `/spends/category/{id}?month=YYYY-MM`: the shell keys it by the category, another month slides in from its side. */
export default function CategorySpendsPage({ categoryId, month }: { categoryId: number; month?: string }) {
  const [load, setLoad] = useState<Load | undefined>()
  const [attempt, setAttempt] = useState(0)
  const key = `${month ?? ''}:${attempt}`
  const shown = useRef<string | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    void getCategorySpends(categoryId, month, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || result.kind === 'aborted') return
      if (result.kind !== 'ok') {
        setLoad({ key, kind: 'error', message: dashboardErrorMessage(result), notFound: result.reason === 'not_found' })
        return
      }
      const slide = monthSlide(shown.current, result.data.month)
      shown.current = result.data.month
      setLoad({ key, kind: 'ok', data: result.data, slide })
    })
    return () => controller.abort()
  }, [categoryId, month, key])
  if (!load || load.key !== key) return <RequestState kind="loading" message="Загружаем траты категории…" />
  if (load.kind === 'error') {
    return load.notFound
      ? <RequestState kind="empty" message="Такой категории нет: возможно, её удалили из каталога." action={<Link className="action-link" to="/">На главную</Link>} />
      : <RequestState kind="error" message={load.message} onRetry={() => setAttempt((value) => value + 1)} />
  }
  return <CategorySpendsView data={load.data} slide={load.slide} />
}
