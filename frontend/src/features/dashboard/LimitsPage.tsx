import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { createBudgetLimit, deleteBudgetLimit, getBudgetLimits, updateBudgetLimit } from '../../api/budget'
import type { BudgetLimit } from '../../api/budget'
import { getCategories } from '../../api/catalog'
import { getManualDefaults } from '../../api/receipts'
import type { Category } from '../../api/types'
import RequestState from '../../components/RequestState'
import { Link } from '../../navigation'
import { useSession } from '../../session'
import { categoryTone, dashboardErrorMessage, formatMoney } from './dashboard-state'
import {
  amountInput, isDuplicateCreate, limitCurrencies, limitFailureMessage, limitFor, parseCurrency, rowAction, topLevelCategories, withLimit, withoutLimit,
} from './limits-state'
import './Dashboard.css'

export type RowStatus = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; text: string } | { kind: 'error'; text: string }
const idle: RowStatus = { kind: 'idle' }
const rowKey = (categoryId: number, currency: string) => `${categoryId}:${currency}`

export type LimitsViewProps = {
  categories: Category[]; limits: BudgetLimit[]; currencies: string[]; currency: string; family: boolean
  drafts: Record<string, string>; statuses: Record<string, RowStatus>
  onCurrency: (currency: string) => void
  onAddCurrency: (input: string) => string | undefined
  onDraft: (key: string, value: string) => void
  onSave: (category: Category) => void
  onDelete: (limit: BudgetLimit) => void
}

function AddCurrency({ onAdd }: { onAdd: (input: string) => string | undefined }) {
  const [value, setValue] = useState('')
  const [error, setError] = useState<string>()
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const failure = onAdd(value)
    setError(failure)
    if (!failure) setValue('')
  }
  return <form className="limits-add-currency" onSubmit={submit} noValidate>
    <label htmlFor="limits-new-currency">Другая валюта</label>
    <div className="limits-add-row">
      <input id="limits-new-currency" value={value} maxLength={3} autoCapitalize="characters" autoComplete="off" spellCheck={false}
        placeholder="USD" aria-invalid={Boolean(error)} aria-describedby={error ? 'limits-new-currency-error' : undefined}
        onChange={(event) => setValue(event.target.value.toUpperCase())} />
      <button type="submit" className="receipt-secondary">Добавить</button>
    </div>
    {error && <p className="receipt-field-error" id="limits-new-currency-error">{error}</p>}
  </form>
}

/** The limits screen without loading: the markup tests render it directly. */
export function LimitsView({ categories, limits, currencies, currency, family, drafts, statuses, onCurrency, onAddCurrency, onDraft, onSave, onDelete }: LimitsViewProps) {
  return <div className="limits">
    <p className="dash-note">{family
      ? 'Лимит — сколько семья готова потратить на категорию за месяц. Лимиты общие: их видят и меняют все члены семьи.'
      : 'Лимит — сколько вы готовы потратить на категорию за месяц.'}</p>
    <section className="dash-card limits-currencies" aria-labelledby="limits-currency-heading">
      <h2 id="limits-currency-heading" className="limits-small-heading">Валюта</h2>
      <div className="dash-chips" role="group" aria-labelledby="limits-currency-heading">
        {currencies.map((code) => <button key={code} type="button" className="dash-chip" aria-pressed={code === currency}
          onClick={() => onCurrency(code)}>{code}</button>)}
      </div>
      <AddCurrency onAdd={onAddCurrency} />
    </section>
    {categories.length ? <ul className="limits-list" aria-label={`Лимиты в ${currency}`}>
      {categories.map((category) => {
        const key = rowKey(category.id, currency)
        const limit = limitFor(limits, category.id, currency)
        const draft = drafts[key]
        const status = statuses[key] ?? idle
        const action = rowAction(draft, limit)
        const busy = status.kind === 'busy'
        const inputId = `limit-${category.id}`
        const messageId = `${inputId}-message`
        const invalid = status.kind === 'error'
        return <li key={key} className={`dash-card limits-row dash-cat-${categoryTone(category.id)}`}>
          <form className="limits-form" noValidate aria-busy={busy} onSubmit={(event) => { event.preventDefault(); onSave(category) }}>
            <div className="limits-row-head">
              <span className="dash-dot" aria-hidden="true" />
              <label className="limits-name" htmlFor={inputId}>{category.name}</label>
              <span className="limits-current">{limit ? formatMoney(limit.amount, currency) : 'без лимита'}</span>
            </div>
            <div className="limits-controls">
              <span className="limits-input">
                <input id={inputId} inputMode="decimal" autoComplete="off" enterKeyHint="done" placeholder="Сумма в месяц"
                  value={draft ?? (limit ? amountInput(limit.amount) : '')} aria-invalid={invalid}
                  aria-describedby={status.kind === 'idle' || busy ? undefined : messageId}
                  onChange={(event) => onDraft(key, event.target.value)} />
                <span className="limits-input-currency" aria-hidden="true">{currency}</span>
              </span>
              <button type="submit" className="limits-save" disabled={busy || action.kind === 'none'}>{busy ? 'Сохраняем…' : 'Сохранить'}</button>
              {limit && <button type="button" className="receipt-secondary limits-delete" disabled={busy}
                aria-label={`Удалить лимит «${category.name}»`} onClick={() => onDelete(limit)}>Удалить</button>}
            </div>
            {status.kind === 'error' && <p className="receipt-field-error" id={messageId} role="alert">{status.text}</p>}
            {status.kind === 'done' && <p className="limits-done" id={messageId} role="status">{status.text}</p>}
          </form>
        </li>
      })}
    </ul> : <RequestState kind="empty" message="Категорий пока нет: их заводят в каталоге." action={<Link className="action-link" to="/catalog">В каталог</Link>} />}
    <p><Link className="dash-link" to="/">На главную</Link></p>
  </div>
}

type Loaded = { categories: Category[]; currency: string }
type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; data: Loaded }

/** `/budget/limits`: a limit per top-level category and currency, saved and deleted row by row. */
export default function LimitsPage() {
  const session = useSession()
  const family = session.kind === 'user' && session.household !== null
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [limits, setLimits] = useState<BudgetLimit[]>([])
  const [added, setAdded] = useState<string[]>([])
  const [currency, setCurrency] = useState<string>()
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const [statuses, setStatuses] = useState<Record<string, RowStatus>>({})
  const controllers = useRef(new Map<string, AbortController>())

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    void Promise.all([getCategories({}, { signal }), getBudgetLimits({ signal }), getManualDefaults({ signal })]).then(([categories, saved, defaults]) => {
      if (signal.aborted) return
      for (const result of [categories, saved, defaults]) {
        if (result.kind === 'aborted') return
        if (result.kind === 'error') { setLoad({ kind: 'error', message: dashboardErrorMessage(result) }); return }
      }
      if (categories.kind !== 'ok' || saved.kind !== 'ok' || defaults.kind !== 'ok') return
      setLimits(saved.data)
      setLoad({ kind: 'ok', data: { categories: topLevelCategories(categories.data.results), currency: defaults.data.currency } })
    })
    return () => controller.abort()
  }, [attempt])

  useEffect(() => {
    const running = controllers.current
    return () => running.forEach((controller) => controller.abort())
  }, [])

  if (load.kind === 'loading') return <RequestState kind="loading" message="Загружаем лимиты…" />
  if (load.kind === 'error') return <RequestState kind="error" message={load.message}
    onRetry={() => { setLoad({ kind: 'loading' }); setAttempt((value) => value + 1) }} />

  const currencies = limitCurrencies(load.data.currency, limits, added)
  const selected = currency ?? currencies[0]
  const setStatus = (key: string, status: RowStatus) => setStatuses((all) => ({ ...all, [key]: status }))
  const begin = (key: string) => {
    controllers.current.get(key)?.abort()
    const controller = new AbortController()
    controllers.current.set(key, controller)
    setStatus(key, { kind: 'busy' })
    return controller
  }
  const clearDraft = (key: string) => setDrafts((all) => {
    const next = { ...all }
    delete next[key]
    return next
  })

  const save = async (category: Category) => {
    const key = rowKey(category.id, selected)
    const action = rowAction(drafts[key], limitFor(limits, category.id, selected))
    if (action.kind === 'none') return
    if (action.kind === 'invalid') { setStatus(key, { kind: 'error', text: action.error }); return }
    const controller = begin(key)
    const result = action.kind === 'create'
      ? await createBudgetLimit({ category_id: category.id, currency: selected, amount: action.amount }, { signal: controller.signal })
      : await updateBudgetLimit(action.id, action.amount, { signal: controller.signal })
    if (controller.signal.aborted || result.kind === 'aborted') return
    controllers.current.delete(key)
    if (result.kind === 'error') {
      const creating = action.kind === 'create'
      setStatus(key, { kind: 'error', text: limitFailureMessage(result, creating) })
      // Someone in the family saved this pair meanwhile: show their limit, the next save updates it.
      if (isDuplicateCreate(result, creating)) {
        const fresh = await getBudgetLimits()
        if (fresh.kind === 'ok') setLimits(fresh.data)
      }
      return
    }
    setLimits((all) => withLimit(all, result.data))
    clearDraft(key)
    setStatus(key, { kind: 'done', text: 'Сохранено.' })
  }

  const remove = async (limit: BudgetLimit) => {
    const key = rowKey(limit.category_id, limit.currency)
    const controller = begin(key)
    const result = await deleteBudgetLimit(limit.id, { signal: controller.signal })
    if (controller.signal.aborted || result.kind === 'aborted') return
    controllers.current.delete(key)
    // Already gone is what the person wanted.
    if (result.kind === 'error' && result.reason !== 'not_found') { setStatus(key, { kind: 'error', text: limitFailureMessage(result) }); return }
    setLimits((all) => withoutLimit(all, limit.id))
    clearDraft(key)
    setStatus(key, { kind: 'done', text: 'Лимит удалён.' })
  }

  return <LimitsView categories={load.data.categories} limits={limits} currencies={currencies} currency={selected} family={family}
    drafts={drafts} statuses={statuses} onCurrency={setCurrency}
    onAddCurrency={(input) => {
      const parsed = parseCurrency(input)
      if ('error' in parsed) return parsed.error
      if (!currencies.includes(parsed.currency)) setAdded((all) => [...all, parsed.currency])
      setCurrency(parsed.currency)
      return undefined
    }}
    onDraft={(key, value) => { setDrafts((all) => ({ ...all, [key]: value })); setStatus(key, idle) }}
    onSave={(category) => { void save(category) }} onDelete={(limit) => { void remove(limit) }} />
}
