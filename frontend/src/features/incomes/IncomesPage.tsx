import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { createIncomeCategory, getIncomeCategories, getIncomes } from '../../api/incomes'
import type { IncomeCategory, IncomeMonth } from '../../api/incomes'
import Icon from '../../components/Icon'
import RequestState from '../../components/RequestState'
import { baseTwin, formatMoney } from '../../lib/money'
import { Link } from '../../navigation'
import { dashboardErrorMessage, dayAndMonth, monthTitle, shiftMonth } from '../dashboard/dashboard-state'
import { rememberIncomeMonth, sessionIncomeMonth, takeIncomeNotice } from './incomes-state'
import './Incomes.css'

export type IncomesViewProps = {
  data: IncomeMonth
  categories: IncomeCategory[]
  notice?: string | null
  busy?: boolean
  failure?: string | null
  onAddCategory?: (name: string) => void
}

/** `/incomes` without loading: the markup tests render it directly. */
export function IncomesView({ data, categories, notice = null, busy = false, failure = null, onAddCategory = () => {} }: IncomesViewProps) {
  const [name, setName] = useState('')
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!busy && name.trim()) onAddCategory(name.trim())
  }
  return <div className="inc-page ck-stack">
    {notice && <p className="inc-notice" role="status">{notice}</p>}
    <section className="ck-panel" aria-labelledby="inc-month-heading">
      <div className="ck-panel-head">
        <h2 id="inc-month-heading">{monthTitle(data.month)}</h2>
        <nav className="inc-months" aria-label="Месяц">
          <Link className="ck-round" to={`/incomes?month=${shiftMonth(data.month, -1)}`} aria-label="Прошлый месяц"><Icon name="back" size={20} /></Link>
          <Link className="ck-round" to={`/incomes?month=${shiftMonth(data.month, 1)}`} aria-label="Следующий месяц"><Icon name="forward" size={20} /></Link>
        </nav>
      </div>
      <p className="inc-total"><span>Доход семьи</span>
        <strong className="ck-figures">{data.family_total === null ? 'не внесён' : formatMoney(data.family_total, data.base_currency)}</strong></p>
      {data.results.length > 0
        ? <ul className="ck-list">{data.results.map((row) => {
          const twin = baseTwin(row.currency, row.base_amount, data.base_currency)
          return <li key={row.id}><Link className="ck-row" to={`/incomes/${row.id}/edit`}>
            <span className="ck-row-badge inc-day" aria-hidden="true">{Number(row.received_on.slice(8, 10))}</span>
            <span className="ck-row-main">
              <span className="ck-row-title">{row.category.name}</span>
              <span className="ck-row-meta">{[dayAndMonth(row.received_on), row.owner_name, twin, row.note].filter(Boolean).join(' · ')}</span>
            </span>
            <span className="ck-row-amount ck-figures inc-amount">{formatMoney(row.amount, row.currency)}</span>
          </Link></li>
        })}</ul>
        : <p className="inc-note">{data.family_total === null ? 'Доходов за месяц пока нет.' : 'Ваших записей за месяц нет.'}</p>}
      <Link className="inc-add" to="/receipts/new?kind=income">Добавить доход</Link>
      <p className="inc-note">Записи видят тот, кто внёс, и главный в семье; общий доход месяца — вся семья.</p>
    </section>
    <section className="ck-panel" aria-labelledby="inc-categories-heading">
      <div className="ck-panel-head"><h2 id="inc-categories-heading">Категории доходов</h2></div>
      <ul className="inc-chips">{categories.map((category) => <li key={category.id} className="inc-chip">{category.name}</li>)}</ul>
      <form className="inc-category-form" onSubmit={submit} noValidate>
        <label htmlFor="inc-category-name">Своя категория</label>
        <div className="inc-category-row">
          <input id="inc-category-name" value={name} maxLength={60} autoComplete="off" placeholder="Аренда гаража"
            onChange={(event) => setName(event.target.value)} />
          <button type="submit" aria-disabled={busy || undefined}>Добавить</button>
        </div>
        {failure && <p className="inc-failure" role="alert">{failure}</p>}
      </form>
    </section>
  </div>
}

type Load = { kind: 'error'; message: string } | { kind: 'ok'; data: IncomeMonth; categories: IncomeCategory[] }

/** `/incomes`: the records of a month the person may see, the family's total, the categories and a category of one's own.
 * Without `month` — the month opened last in this session, or the server's current one in a new session. */
export default function IncomesPage({ month: asked }: { month?: string }) {
  const month = asked ?? sessionIncomeMonth()
  useEffect(() => { if (asked) rememberIncomeMonth(asked) }, [asked])
  const [load, setLoad] = useState<Load>()
  const [attempt, setAttempt] = useState(0)
  const [notice, setNotice] = useState<string | null>(() => takeIncomeNotice() ?? null)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    void Promise.all([getIncomes(month, { signal }), getIncomeCategories({ signal })]).then(([incomes, categories]) => {
      if (signal.aborted) return
      if (incomes.kind === 'error') { setLoad({ kind: 'error', message: dashboardErrorMessage(incomes) }); return }
      if (incomes.kind !== 'ok') return
      setLoad({ kind: 'ok', data: incomes.data, categories: categories.kind === 'ok' ? categories.data : [] })
    })
    return () => controller.abort()
  }, [month, attempt])
  const addCategory = (name: string) => {
    setBusy(true)
    setFailure(null)
    void createIncomeCategory(name).then((result) => {
      setBusy(false)
      if (result.kind === 'ok') {
        setNotice(`Категория «${result.data.name}» есть в форме дохода.`)
        setAttempt((value) => value + 1)
      } else if (result.kind === 'error') setFailure(result.reason === 'invalid_parameter' ? 'Название — от 1 до 60 символов.' : dashboardErrorMessage(result))
    })
  }
  if (!load) return <RequestState kind="loading" message="Загружаем доходы…" />
  if (load.kind === 'error') return <RequestState kind="error" message={load.message} onRetry={() => setAttempt((value) => value + 1)} />
  return <IncomesView data={load.data} categories={load.categories} notice={notice} busy={busy} failure={failure} onAddCategory={addCategory} />
}
