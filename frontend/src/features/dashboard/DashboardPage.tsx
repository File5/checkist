import { useEffect, useState } from 'react'
import { getDashboard } from '../../api/budget'
import type { Dashboard, DashboardCategory, DashboardCurrency, DashboardRecent, DashboardSubCategory } from '../../api/budget'
import RequestState from '../../components/RequestState'
import { Link } from '../../navigation'
import { QuickShot } from '../recognition'
import {
  badgeLetter, capitalize, categoryIds, categoryTone, cents, compareMonths, daysLeftText, dashboardErrorMessage, dashboardPeople, deviceMonth, formatMoney,
  formatNumber, initials,
  inMonth, monthIsEmpty, monthTitle, progress, recentMeta, shiftMonth, subCategories,
} from './dashboard-state'
import type { Progress } from './dashboard-state'
import './Dashboard.css'

const monthHref = (month: string) => `/?month=${month}`

/** The filled part of a bar; the numbers next to it say the same in words. */
function Bar({ value, label, small = false }: { value: Progress; label: string; small?: boolean }) {
  return <div className={`dash-bar${small ? ' dash-bar-small' : ''}${value.over ? ' dash-bar-over' : ''}`} role="progressbar" aria-label={label}
    aria-valuemin={0} aria-valuemax={100} aria-valuenow={value.percent}>
    <span className="dash-bar-fill" style={{ width: `${value.percent}%` }} />
  </div>
}

function SpentCard({ block, data, family, current }: { block: DashboardCurrency; data: Dashboard; family: boolean; current: boolean }) {
  const comparison = compareMonths(block.spent, block.previous_spent, data.previous_month)
  const total = progress(block.spent, block.limit_total)
  return <section className="dash-card dash-spent" aria-label={`Потрачено, ${block.currency}`}>
    <p className="dash-label">{family ? 'Потрачено семьёй' : 'Потрачено'}</p>
    <p className="dash-total">{formatMoney(block.spent, block.currency)}</p>
    {comparison && <p className={`dash-compare dash-compare-${comparison.tone}`}>{comparison.text}</p>}
    {total && block.limit_total && <>
      <Bar value={total} label={`Потрачено ${total.percent}% общего лимита`} />
      <p className="dash-left">
        {total.over
          ? <span className="dash-over">Сверх лимита на <span className="dash-value">{formatMoney(total.overBy, block.currency)}</span></span>
          : <>Осталось <span className="dash-value dash-strong">{formatMoney(total.remaining, block.currency)}</span> из <span className="dash-value">{formatMoney(block.limit_total, block.currency)}</span></>}
        {current && data.days_left > 0 && <span className="dash-days"> · {daysLeftText(data.days_left)}</span>}
      </p>
    </>}
  </section>
}

/** «Аренда» under «Жильё»: indented, a thinner bar, the colour of its top-level row. Only limited sub-categories
 * and their ancestors come here; one without its own limit shows what was spent, without a bar. */
function SubLimitRow({ row, currency }: { row: DashboardSubCategory; currency: string }) {
  const bar = progress(row.spent, row.limit)
  const children = subCategories(row)
  return <li className="dash-sublimit">
    <div className="dash-limit-head">
      <span className="dash-sublimit-name">{row.name}</span>
      <span className="dash-limit-value dash-sublimit-value">
        {row.limit === null ? formatMoney(row.spent, currency)
          : <>{formatNumber(row.spent)} / {formatMoney(row.limit, currency)}</>}
      </span>
    </div>
    {bar && <Bar small value={bar} label={`${row.name}: потрачено ${bar.percent}% лимита`} />}
    {bar?.over && <p className="dash-over dash-sublimit-over">Сверх лимита на <span className="dash-value">{formatMoney(bar.overBy, currency)}</span></p>}
    {children.length > 0 && <SubLimitList rows={children} currency={currency} label={row.name} />}
  </li>
}

function SubLimitList({ rows, currency, label }: { rows: DashboardSubCategory[]; currency: string; label: string }) {
  return <ul className="dash-sublimit-list" aria-label={`${label}: подкатегории с лимитами`}>
    {rows.map((row) => <SubLimitRow key={row.category_id} row={row} currency={currency} />)}
  </ul>
}

function LimitRow({ category, currency }: { category: DashboardCategory; currency: string }) {
  const bar = progress(category.spent, category.limit)
  const children = subCategories(category)
  return <li className={`dash-limit dash-cat-${categoryTone(category.category_id)}`}>
    <div className="dash-limit-head">
      <span className="dash-dot" aria-hidden="true" />
      <span className="dash-limit-name">{category.name}</span>
      <span className="dash-limit-value">
        {category.limit === null ? formatMoney(category.spent, currency)
          : <>{formatNumber(category.spent)} / {formatMoney(category.limit, currency)}</>}
      </span>
    </div>
    {bar && <Bar value={bar} label={`${category.name}: потрачено ${bar.percent}% лимита`} />}
    {bar?.over && <p className="dash-over">Сверх лимита на <span className="dash-value">{formatMoney(bar.overBy, currency)}</span></p>}
    {children.length > 0 && <SubLimitList rows={children} currency={currency} label={category.name} />}
  </li>
}

function LimitsCard({ block, several }: { block: DashboardCurrency; several: boolean }) {
  const headingId = `dash-limits-${block.currency}`
  return <section className="dash-card dash-limits" aria-labelledby={headingId}>
    <div className="dash-card-head">
      <h2 id={headingId}>Лимиты{several && <span className="dash-currency"> · {block.currency}</span>}</h2>
      <Link className="dash-link" to="/budget/limits">Изменить</Link>
    </div>
    {block.categories.length
      ? <ul className="dash-limit-list">{block.categories.map((category) => <LimitRow key={category.category_id ?? `none-${category.name}`} category={category} currency={block.currency} />)}</ul>
      : <p className="dash-note">Трат по категориям нет.</p>}
    {block.limit_total === null && <p className="dash-note">Лимиты не заданы. <Link className="dash-link" to="/budget/limits">Задать лимиты</Link></p>}
  </section>
}

function RecentItem({ item, tone }: { item: DashboardRecent; tone: number }) {
  return <li>
    <Link className="dash-recent-item" to={`/receipts/${item.id}`}>
      <span className={`dash-badge dash-cat-${tone}`} aria-hidden="true">{badgeLetter(item.category_name, item.title)}</span>
      <span className="dash-recent-main">
        <span className="dash-recent-title">{item.title || (item.source === 'manual' ? 'Трата' : 'Чек')}</span>
        <span className="dash-recent-meta">{recentMeta(item)}</span>
      </span>
      <span className="dash-recent-amount">{formatMoney(item.total, item.currency)}</span>
    </Link>
  </li>
}

export type DashboardViewProps = {
  data: Dashboard
  /** The month of the device: there is nothing to see after it. */
  today?: string
  /** «Пользователь с семьёй» says «семьёй»; one person without a family — just «Потрачено». */
  family?: boolean
}

/** The dashboard itself, without loading: the markup tests render it directly. */
export function DashboardView({ data, today = deviceMonth(), family = data.members.length > 1 }: DashboardViewProps) {
  const current = data.month === today
  const empty = monthIsEmpty(data)
  const ids = categoryIds(data)
  const several = data.currencies.length > 1
  const people = dashboardPeople(data)
  return <div className="dash">
    <div className="dash-head">
      <nav className="dash-month" aria-label="Месяц">
        <Link className="dash-month-step" to={monthHref(shiftMonth(data.month, -1))} aria-label="Предыдущий месяц">‹</Link>
        <h2 className="dash-month-title">{monthTitle(data.month)}</h2>
        {data.month < today
          ? <Link className="dash-month-step" to={monthHref(shiftMonth(data.month, 1))} aria-label="Следующий месяц">›</Link>
          : <span className="dash-month-step dash-month-step-off" aria-hidden="true">›</span>}
      </nav>
      <ul className="dash-family" aria-label={family ? 'Семья' : 'Кто тратит'}>
        {people.map((person, index) => <li key={person.username} className={`dash-avatar dash-cat-${(index % 6) + 1}`} title={person.display_name}>
          <span aria-hidden="true">{initials(person.display_name)}</span><span className="dash-visually-hidden">{person.display_name}</span>
        </li>)}
      </ul>
    </div>

    {empty
      ? <section className="dash-card dash-empty">
        <p className="dash-empty-title">{capitalize(inMonth(data.month))} трат {current ? 'пока нет' : 'не было'}</p>
        {current && <p className="dash-note">Снимите чек или добавьте трату — сумма появится здесь.</p>}
      </section>
      : data.currencies.filter((block) => cents(block.spent) !== 0n || block.limit_total !== null)
        .map((block) => <SpentCard key={block.currency} block={block} data={data} family={family} current={current} />)}

    <div className="dash-actions">
      <QuickShot className="dash-action dash-action-shot" label="Снять чек" />
      <QuickShot className="dash-action dash-action-spend" source="gallery" label="Из галереи" />
      <Link className="dash-action dash-action-spend" to="/receipts/new">Трата</Link>
    </div>

    {data.currencies.filter((block) => block.categories.length || block.limit_total !== null)
      .map((block) => <LimitsCard key={block.currency} block={block} several={several} />)}
    {!data.currencies.length && <section className="dash-card dash-limits" aria-label="Лимиты">
      <div className="dash-card-head"><h2>Лимиты</h2><Link className="dash-link" to="/budget/limits">Изменить</Link></div>
      <p className="dash-note">Лимиты на месяц помогают видеть, сколько ещё можно потратить.</p>
    </section>}

    <section className="dash-card dash-recent" aria-labelledby="dash-recent-heading">
      <div className="dash-card-head">
        <h2 id="dash-recent-heading">Последние траты</h2>
        <Link className="dash-link" to="/receipts">Все</Link>
      </div>
      {data.recent.length
        ? <ul className="dash-recent-list">{data.recent.map((item) => <RecentItem key={item.id} item={item}
          tone={categoryTone(item.category_name === null ? null : ids.get(item.category_name))} />)}</ul>
        : <p className="dash-note">Трат пока нет.</p>}
    </section>
  </div>
}

type Load = { key: string } & ({ kind: 'error'; message: string } | { kind: 'ok'; data: Dashboard })

/** «Главная»: the month of the family budget. The month lives in the address (`/?month=YYYY-MM`).
 * An answer belongs to its month and attempt: another month shows «loading» until its own answer comes. */
export default function DashboardPage({ month }: { month?: string }) {
  const [load, setLoad] = useState<Load | undefined>()
  const [attempt, setAttempt] = useState(0)
  const key = `${month ?? ''}:${attempt}`
  useEffect(() => {
    const controller = new AbortController()
    void getDashboard(month, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || result.kind === 'aborted') return
      setLoad(result.kind === 'ok' ? { key, kind: 'ok', data: result.data } : { key, kind: 'error', message: dashboardErrorMessage(result) })
    })
    return () => controller.abort()
  }, [month, key])
  if (!load || load.key !== key) return <RequestState kind="loading" message="Загружаем траты месяца…" />
  if (load.kind === 'error') return <RequestState kind="error" message={load.message} onRetry={() => setAttempt((value) => value + 1)} />
  return <DashboardView data={load.data} />
}
