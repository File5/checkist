import { useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { getDashboard } from '../../api/budget'
import type { Dashboard, DashboardCategory, DashboardCurrency, DashboardRecent, DashboardSubCategory } from '../../api/budget'
import type { ExcludedSpends } from '../../api/base-currency'
import Icon from '../../components/Icon'
import { HeaderSlot } from '../../components/PageHeader'
import { usePageTitle } from '../../components/page-header'
import RequestState from '../../components/RequestState'
import type { Person } from '../../lib/people'
import { Link } from '../../navigation'
import { useQuickShot } from '../recognition/QuickShot'
import {
  badgeLetter, capitalize, categoryIds, categoryTone, cents, compareMonths, currencyName, daysLeftText, dashboardErrorMessage, dashboardPeople, deviceDate, deviceMonth,
  formatMoney, formatNumber, hasLimit, initials, inMonth, monthIsEmpty, monthSlide, monthTitle, progress, recentMeta, shiftMonth,
} from './dashboard-state'
import type { MonthSlide, Progress } from './dashboard-state'
import { categorySpendsHref } from './category-spends-state'
import { baseTwin, currencySymbol } from '../../lib/money'
import { collapsedHint, isExpanded, readExpanded, rowChildren, subListId, withChoice, writeExpanded } from './limit-collapse-state'
import type { ExpandedChoices } from './limit-collapse-state'
import { subCategoriesText } from './limits-state'
import './Dashboard.css'

const monthHref = (month: string) => `/?month=${month}`

/** The filled part of a bar; the numbers next to it say the same in words. */
function Bar({ value, label, small = false }: { value: Progress; label: string; small?: boolean }) {
  return <div className={`dash-bar${small ? ' dash-bar-small' : ''}${value.over ? ' dash-bar-over' : ''}`} role="progressbar" aria-label={label}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={value.percent}>
    <span className="dash-bar-fill" style={{ width: `${value.percent}%` }} />
  </div>
}

/** The header row of «Главная» (the shell's, components/PageHeader): «‹», the month as the heading of the page, «›»
 * while a later month is not in the future, and the family on the right. Drawn while the month loads too. */
function MonthHeader({ month, today, people, family }: { month: string; today: string; people: Person[]; family: boolean }) {
  // An ordinary space: on a window narrower than the row «Сентябрь 2026» goes to two lines, never «Сентябрь 2 / 026».
  usePageTitle(monthTitle(month).replace('\u00a0', ' '))
  return <>
    <HeaderSlot side="start">
      <Link className="ck-round dash-month-step" to={monthHref(shiftMonth(month, -1))} aria-label="Предыдущий месяц"><Icon name="back" size={20} /></Link>
    </HeaderSlot>
    <HeaderSlot side="end">
      {month < today && <Link className="ck-round dash-month-step" to={monthHref(shiftMonth(month, 1))} aria-label="Следующий месяц"><Icon name="forward" size={20} /></Link>}
      {people.length > 0 && <ul className="dash-family" aria-label={family ? 'Семья' : 'Кто тратит'}>
        {people.map((person, index) => <li key={person.username} className={`dash-avatar dash-cat-${(index % 6) + 1}`} title={person.display_name}>
          <span aria-hidden="true">{initials(person.display_name)}</span><span className="dash-visually-hidden">{person.display_name}</span>
        </li>)}
      </ul>}
    </HeaderSlot>
  </>
}

/** «Осталось 112 550 ₸ из 400 000 ₸» or the overspend; `limited` is what the categories with a limit spent. */
function LimitLeft({ value, total, currency }: { value: Progress; total: string; currency: string }) {
  return value.over
    ? <span className="dash-over">Сверх лимита на <span className="dash-value">{formatMoney(value.overBy, currency)}</span></span>
    : <span>Осталось <span className="dash-value dash-strong">{formatMoney(value.remaining, currency)}</span> из <span className="dash-value">{formatMoney(total, currency)}</span></span>
}

/** The first currency of the month: the hero figure of the screen, the comparison, the overall limit and its days. */
function HeroCard({ block, data, family, current }: { block: DashboardCurrency; data: Dashboard; family: boolean; current: boolean }) {
  const comparison = compareMonths(block.spent, block.previous_spent, data.previous_month)
  // The overall limit covers only the categories that have one: compare it with their spending, not the whole month.
  const total = block.limited_spent != null ? progress(block.limited_spent, block.limit_total) : undefined
  const partial = block.limited_spent != null && cents(block.limited_spent) !== cents(block.spent)
  return <section className="ck-panel dash-card dash-hero" aria-label={`Потрачено, ${block.currency}`}>
    <div className="ck-panel-head">
      <p className="dash-label">{family ? 'Потрачено семьёй' : 'Потрачено'}</p>
      <Link className="dash-card-link" to="/stats/trends">Динамика</Link>
    </div>
    <p className="dash-total ck-hero-figure">{formatMoney(block.spent, block.currency)}</p>
    {comparison && <p className={`dash-compare dash-compare-${comparison.tone}`}>{comparison.text}</p>}
    {total && block.limit_total && block.limited_spent != null && <div className="dash-hero-limit">
      <Bar value={total} label={`Потрачено ${total.percent}% общего лимита`} />
      <p className="dash-left">
        <LimitLeft value={total} total={block.limit_total} currency={block.currency} />
        {current && data.days_left > 0 && <span className="dash-days">{daysLeftText(data.days_left)}</span>}
      </p>
      {partial && <p className="dash-note dash-hero-note">Категории с лимитом: <span className="dash-value">{formatMoney(block.limited_spent, block.currency)}</span></p>}
    </div>}
  </section>
}

/** Another currency of the month: one compact row each, never a second hero and never added to the first. */
function OtherCurrencies({ blocks, data }: { blocks: DashboardCurrency[]; data: Dashboard }) {
  return <section className="ck-panel dash-card dash-others" aria-labelledby="dash-others-heading">
    <div className="ck-panel-head"><h2 id="dash-others-heading">Другие валюты</h2></div>
    <ul className="ck-list">
      {blocks.map((block) => {
        const total = block.limited_spent != null ? progress(block.limited_spent, block.limit_total) : null
        const comparison = compareMonths(block.spent, block.previous_spent, data.previous_month)
        const meta = total && block.limit_total
          ? <LimitLeft value={total} total={block.limit_total} currency={block.currency} />
          : comparison?.text
        return <li key={block.currency} className="ck-row dash-other" aria-label={`Потрачено, ${block.currency}`}>
          <span className="ck-row-badge dash-currency-badge" aria-hidden="true">{currencySymbol(block.currency)}</span>
          <span className="ck-row-main">
            <span className="ck-row-title">{currencyName(block.currency)}</span>
            {meta && <span className="ck-row-meta">{meta}</span>}
          </span>
          <span className="ck-row-amount ck-figures dash-other-amount">{formatMoney(block.spent, block.currency)}</span>
        </li>
      })}
    </ul>
  </section>
}

/** Spends of the month in a currency whose rate of the National Bank on the day of purchase is not loaded yet: not in
 * the total above, so they are named here instead of silently missing. Every other currency is in the total. */
function Unconverted({ items }: { items: ExcludedSpends[] }) {
  return <section className="ck-panel dash-card dash-others dash-unconverted" aria-labelledby="dash-unconverted-heading">
    <div className="ck-panel-head"><h2 id="dash-unconverted-heading">Без курса</h2></div>
    <ul className="ck-list">
      {items.map((item) => <li key={item.currency} className="ck-row dash-other" aria-label={`Без курса, ${item.currency}`}>
        <span className="ck-row-badge dash-currency-badge" aria-hidden="true">{currencySymbol(item.currency)}</span>
        <span className="ck-row-main">
          <span className="ck-row-title">{currencyName(item.currency)}</span>
          <span className="ck-row-meta">Нет курса Нацбанка на дату покупки — не в итоге</span>
        </span>
        <span className="ck-row-amount ck-figures dash-other-amount">{formatMoney(item.total, item.currency)}</span>
      </li>)}
    </ul>
  </section>
}

/** The two big actions of the artifact: the camera of «Снять чек» and the form of «Трата». Not pinned: they stand in
 * the page under the total, the «＋» of the bottom bar is the action that is always at hand. */
function Actions() {
  const shot = useQuickShot('camera')
  return <div className="dash-actions">
    <button type="button" className="dash-action dash-action-shot" onClick={shot.open}><Icon name="camera" />Снять чек</button>
    {shot.field}
    <Link className="dash-action dash-action-spend" to="/receipts/new"><Icon name="plus" />Трата</Link>
  </div>
}

/** The heading of a category row: a link to what its money went on this month («Траты категории»); a row without
 * a category id (an older server) stays plain text. */
function RowHead({ categoryId, month, className = 'dash-limit-head', children }: { categoryId: number | null; month: string; className?: string; children: ReactNode }) {
  return categoryId === null ? <div className={className}>{children}</div>
    : <Link className={`${className} dash-limit-link`} to={categorySpendsHref(categoryId, month)}>{children}</Link>
}

/** «92 300 / 120 000 ₸» on one line, the spent part in the colour of an overspend when it is one; without a limit
 * what was spent. */
function LimitValue({ spent, limit, currency, over, sub = false }: { spent: string; limit: string | null; currency: string; over: boolean; sub?: boolean }) {
  return <span className={`dash-limit-value${sub ? ' dash-sublimit-value' : ''} ck-figures`}>
    {limit === null ? formatMoney(spent, currency)
      : <><span className={over ? 'dash-limit-spent dash-limit-spent-over' : 'dash-limit-spent'}>{formatNumber(spent)}</span>
        <span className="dash-limit-of"> / {formatMoney(limit, currency)}</span></>}
  </span>
}

/** Folds and unfolds the direct sub-categories of a row: a button of its own, beside the link of the row, so a tap on
 * the row still opens «Траты категории». Folded, it says how many there are and, when it fits one line, their limits. */
function SubToggle({ row, listId, expanded, onToggle, count }: { row: DashboardCategory | DashboardSubCategory; listId: string; expanded: boolean; onToggle: Toggle; count: number }) {
  const hint = expanded ? null : collapsedHint(row)
  return <button type="button" className="dash-sub-toggle" aria-expanded={expanded} aria-controls={listId}
    onClick={() => row.category_id !== null && onToggle(row.category_id, !expanded)}>
    <Icon name="forward" size={14} className="ck-icon dash-sub-chevron" />
    <span className="dash-sub-text">
      <span className="dash-visually-hidden">{row.name}: </span>
      <span className="dash-sub-count">{subCategoriesText(count)}</span>
      {hint && <span className="dash-sub-hint ck-figures">{hint}</span>}
    </span>
  </button>
}

type Toggle = (categoryId: number, open: boolean) => void
type Fold = { choices: ExpandedChoices; onToggle: Toggle }

/** The sub-categories of a row with their button; a row without a category id (an older server) has none. */
function SubLimits({ row, currency, month, fold }: { row: DashboardCategory | DashboardSubCategory; currency: string; month: string; fold: Fold }) {
  const children = rowChildren(row)
  if (!children.length || row.category_id === null) return null
  const listId = subListId(currency, row.category_id)
  const expanded = isExpanded(row, fold.choices)
  return <>
    <SubToggle row={row} listId={listId} expanded={expanded} onToggle={fold.onToggle} count={children.length} />
    <ul className="dash-sublimit-list" id={listId} aria-label={`${row.name}: подкатегории`} hidden={!expanded}>
      {children.map((child) => <SubLimitRow key={child.category_id} row={child} currency={currency} month={month} fold={fold} />)}
    </ul>
  </>
}

/** «Аренда» under «Жильё»: indented, a thinner bar, the colour of its top-level row. Every sub-category with spends
 * of the month comes here, and a limited one with its ancestors; one without its own limit shows what was spent. */
function SubLimitRow({ row, currency, month, fold }: { row: DashboardSubCategory; currency: string; month: string; fold: Fold }) {
  const bar = progress(row.spent, row.limit)
  return <li className="dash-sublimit">
    <RowHead categoryId={row.category_id} month={month}>
      <span className="dash-sublimit-name">{row.name}</span>
      <LimitValue spent={row.spent} limit={row.limit} currency={currency} over={Boolean(bar?.over)} sub />
    </RowHead>
    {bar && <Bar small value={bar} label={`${row.name}: потрачено ${bar.percent}% лимита`} />}
    {bar?.over && <p className="dash-over dash-sublimit-over">Сверх лимита на <span className="dash-value">{formatMoney(bar.overBy, currency)}</span></p>}
    <SubLimits row={row} currency={currency} month={month} fold={fold} />
  </li>
}

function LimitRow({ category, currency, month, fold }: { category: DashboardCategory; currency: string; month: string; fold: Fold }) {
  const bar = progress(category.spent, category.limit)
  return <li className={`dash-limit dash-cat-${categoryTone(category.category_id)}`}>
    <RowHead categoryId={category.category_id} month={month}>
      <span className="dash-dot" aria-hidden="true" />
      <span className="dash-limit-name">{category.name}</span>
      <LimitValue spent={category.spent} limit={category.limit} currency={currency} over={Boolean(bar?.over)} />
    </RowHead>
    {bar && <Bar value={bar} label={`${category.name}: потрачено ${bar.percent}% лимита`} />}
    {bar?.over && <p className="dash-over">Сверх лимита на <span className="dash-value">{formatMoney(bar.overBy, currency)}</span></p>}
    <SubLimits row={category} currency={currency} month={month} fold={fold} />
  </li>
}

/** A category without any limit: one compact line, its colour, its name and what it spent, no bar. */
function PlainRow({ category, currency, month }: { category: DashboardCategory; currency: string; month: string }) {
  return <li className={`dash-plain dash-cat-${categoryTone(category.category_id)}`}>
    <RowHead categoryId={category.category_id} month={month} className="dash-plain-head">
      <span className="dash-dot" aria-hidden="true" />
      <span className="dash-plain-name">{category.name}</span>
      <span className="dash-plain-value ck-figures">{formatMoney(category.spent, currency)}</span>
    </RowHead>
  </li>
}

function LimitsCard({ block, several, month, fold }: { block: DashboardCurrency; several: boolean; month: string; fold: Fold }) {
  const headingId = `dash-limits-${block.currency}`
  const limited = block.categories.filter(hasLimit)
  const plain = block.categories.filter((category) => !hasLimit(category))
  const key = (category: DashboardCategory) => category.category_id ?? `none-${category.name}`
  return <section className="ck-panel dash-card dash-limits" aria-labelledby={headingId}>
    <div className="ck-panel-head">
      <h2 id={headingId}>Лимиты{several && <span className="dash-currency"> · {currencySymbol(block.currency)}</span>}</h2>
      <Link className="dash-card-link" to="/budget/limits">Изменить</Link>
    </div>
    {limited.length > 0 && <ul className="dash-limit-list">{limited.map((category) => <LimitRow key={key(category)} category={category} currency={block.currency} month={month} fold={fold} />)}</ul>}
    {block.limit_total === null && <p className="dash-note">Лимиты не заданы. <Link className="dash-inline-link" to="/budget/limits">Задать лимиты</Link></p>}
    {plain.length > 0 && <div className="dash-plain-block">
      {limited.length > 0 && <h3 className="dash-plain-title">Без лимита</h3>}
      <ul className="dash-plain-list">{plain.map((category) => <PlainRow key={key(category)} category={category} currency={block.currency} month={month} />)}</ul>
    </div>}
    {!block.categories.length && <p className="dash-note">Трат по категориям нет.</p>}
  </section>
}

function RecentItem({ item, tone, date, base }: { item: DashboardRecent; tone: number; date: string; base?: string }) {
  // «20 $» and under it «≈ 8 979 ₸»: a spend in another currency keeps its own amount, the total above counts the twin.
  const twin = baseTwin(item.currency, item.base_total, base)
  return <li>
    <Link className="ck-row dash-recent-item" to={`/receipts/${item.id}`}>
      <span className={`ck-row-badge dash-badge dash-cat-${tone}`} aria-hidden="true">{badgeLetter(item.category_name, item.title)}</span>
      <span className="ck-row-main">
        <span className="ck-row-title dash-recent-title">{item.title || (item.source === 'manual' ? 'Трата' : 'Чек')}</span>
        <span className="ck-row-meta">{recentMeta(item, date)}</span>
      </span>
      <span className="ck-row-amount ck-figures">{formatMoney(item.total, item.currency)}
        {twin && <span className="dash-recent-twin">{twin}</span>}</span>
    </Link>
  </li>
}

export type DashboardViewProps = {
  data: Dashboard
  /** The month of the device: there is nothing to see after it. */
  today?: string
  /** «Пользователь с семьёй» says «семьёй»; one person without a family — just «Потрачено». */
  family?: boolean
  /** The month came after another one: it slides in from that side (not under reduced motion). */
  slide?: MonthSlide
  /** Opened and closed rows of «Лимиты» to start with; the saved ones of this browser by default. */
  expanded?: ExpandedChoices
  /** The date of the device: «сегодня» and «вчера» of the latest spends. */
  date?: string
}

/** The dashboard itself, without loading: the markup tests render it directly (the header row then stays in place). */
export function DashboardView({ data, today = deviceMonth(), family = data.members.length > 1, slide, expanded, date = deviceDate() }: DashboardViewProps) {
  const current = data.month === today
  const empty = monthIsEmpty(data)
  const unconverted = data.excluded ?? []
  const ids = categoryIds(data)
  const several = data.currencies.length > 1
  const [choices, setChoices] = useState<ExpandedChoices>(() => expanded ?? readExpanded())
  const fold: Fold = {
    choices,
    onToggle: (categoryId, open) => setChoices((before) => {
      const next = withChoice(before, categoryId, open)
      writeExpanded(next)
      return next
    }),
  }
  const spent = data.currencies.filter((block) => cents(block.spent) !== 0n || block.limit_total !== null)
  const [hero, ...others] = spent
  // The main currency always gets its limits card; another one only when it has limits (its spends are in «Другие валюты»).
  const limits = data.currencies.filter((block, index) => block.limit_total !== null || (index === 0 && block.categories.length))
  // Two columns on a wide screen: the month and the spends, the limits beside them. A phone reads them as one column:
  // the money, the actions, the limits, the latest spends (the order of Dashboard.css).
  return <div className={`dash${slide ? ` dash-slide-${slide}` : ''}`}>
    <MonthHeader month={data.month} today={today} people={dashboardPeople(data)} family={family} />
    <div className="dash-column dash-column-main">
      {(empty || !hero) && unconverted.length > 0 ? null : empty || !hero
        ? <section className="ck-panel dash-card dash-empty">
          <p className="dash-empty-title">{capitalize(inMonth(data.month))} трат {current ? 'пока нет' : 'не было'}</p>
          {current && <p className="dash-note">Снимите чек или добавьте трату — сумма появится здесь.</p>}
          <Link className="dash-empty-action" to="/receipts/new">Добавить трату</Link>
        </section>
        : <HeroCard block={hero} data={data} family={family} current={current} />}
      {!empty && others.length > 0 && <OtherCurrencies blocks={others} data={data} />}
      {unconverted.length > 0 && <Unconverted items={unconverted} />}
      <Actions />
      <section className="ck-panel dash-card dash-recent" aria-labelledby="dash-recent-heading">
        <div className="ck-panel-head">
          <h2 id="dash-recent-heading">Последние траты</h2>
          <Link className="dash-card-link" to="/receipts">Все</Link>
        </div>
        {data.recent.length
          ? <ul className="ck-list dash-recent-list">{data.recent.map((item) => <RecentItem key={item.id} item={item} date={date} base={data.base_currency}
            tone={categoryTone(item.category_name === null ? null : ids.get(item.category_name))} />)}</ul>
          : <p className="dash-note">Трат пока нет.</p>}
      </section>
    </div>
    <div className="dash-column dash-column-side">
      {limits.map((block) => <LimitsCard key={block.currency} block={block} several={several} month={data.month} fold={fold} />)}
      {!data.currencies.length && <section className="ck-panel dash-card dash-limits" aria-label="Лимиты">
        <div className="ck-panel-head"><h2>Лимиты</h2><Link className="dash-card-link" to="/budget/limits">Изменить</Link></div>
        <p className="dash-note">Лимиты на месяц помогают видеть, сколько ещё можно потратить.</p>
      </section>}
    </div>
  </div>
}

type Load = { key: string } & ({ kind: 'error'; message: string } | { kind: 'ok'; data: Dashboard; slide?: MonthSlide })

/** «Главная»: the month of the family budget. The month lives in the address (`/?month=YYYY-MM`).
 * An answer belongs to its month and attempt: another month shows «loading» until its own answer comes. */
export default function DashboardPage({ month }: { month?: string }) {
  const [load, setLoad] = useState<Load | undefined>()
  const [attempt, setAttempt] = useState(0)
  const key = `${month ?? ''}:${attempt}`
  // The month shown last: the next one slides in from its side.
  const shown = useRef<string | undefined>(undefined)
  useEffect(() => {
    const controller = new AbortController()
    void getDashboard(month, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || result.kind === 'aborted') return
      if (result.kind !== 'ok') { setLoad({ key, kind: 'error', message: dashboardErrorMessage(result) }); return }
      const slide = monthSlide(shown.current, result.data.month)
      shown.current = result.data.month
      setLoad({ key, kind: 'ok', data: result.data, slide })
    })
    return () => controller.abort()
  }, [month, key])
  const today = deviceMonth()
  // While the month loads, its header is already there: the steps work, the heading names the month, the family of the
  // month shown before stays in its place.
  const before = load?.kind === 'ok' ? load.data : undefined
  const waiting = <MonthHeader month={month ?? today} today={today} people={before ? dashboardPeople(before) : []} family={before ? before.members.length > 1 : false} />
  if (!load || load.key !== key) return <>{waiting}<RequestState kind="loading" message="Загружаем траты месяца…" /></>
  if (load.kind === 'error') return <>{waiting}<RequestState kind="error" message={load.message} onRetry={() => setAttempt((value) => value + 1)} /></>
  return <DashboardView data={load.data} slide={load.slide} />
}
