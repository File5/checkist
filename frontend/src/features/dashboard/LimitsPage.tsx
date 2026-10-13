import { useEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent } from 'react'
import { createBudgetLimit, deleteBudgetLimit, getBudgetLimitBook, getBudgetLimitHistory, getBudgetLimits, getMonthBudget, saveMonthBudget, updateBudgetLimit } from '../../api/budget'
import type { BudgetLimit, BudgetLimitChange, MonthBudget } from '../../api/budget'
import { getCategories } from '../../api/catalog'
import { getManualDefaults } from '../../api/receipts'
import type { Category } from '../../api/types'
import Icon from '../../components/Icon'
import RequestState from '../../components/RequestState'
import { Link } from '../../navigation'
import { useSession } from '../../session'
import { categoryTone, dashboardErrorMessage, formatMoney } from './dashboard-state'
import { currencySymbol, formatMoneyWithBase } from '../../lib/money'
import {
  amountInput, changedRows, filterHistory, historyCategories, historyEntries, isDuplicateCreate, legacyLimit, limitCurrencies, limitFailureMessage, limitFor, parseLimitAmount,
  limitTree, openByDefault, parseCurrency, rowAction, saveBarLabel, subCategoriesText, visibleRows, withLimit, withoutLimit,
} from './limits-state'
import ChipScroller from '../../components/ChipScroller'
import './Dashboard.css'

export type RowStatus = { kind: 'idle' } | { kind: 'busy' } | { kind: 'done'; text: string } | { kind: 'error'; text: string }
const idle: RowStatus = { kind: 'idle' }
const rowKey = (categoryId: number, currency: string) => `${categoryId}:${currency}`

export type LimitsViewProps = {
  categories: Category[]; limits: BudgetLimit[]; currencies: string[]; currency: string; family: boolean
  /** The family's base currency (a newer server): limits are set in it only, no other currency is offered; a limit of
   * another currency set before is shown converted and moves to the base one when its row is saved. */
  base?: string
  drafts: Record<string, string>; statuses: Record<string, RowStatus>
  /** Top-level rows the person opened (`true`) or closed (`false`); the others follow `openByDefault`. */
  toggled?: Record<number, boolean>
  onToggle?: (rootId: number, open: boolean) => void
  onCurrency: (currency: string) => void
  onAddCurrency: (input: string) => string | undefined
  onDraft: (key: string, value: string) => void
  onSave: (category: Category) => void
  /** «Сохранить» of the bar: every changed row of this currency at once. */
  onSaveAll?: (categories: Category[]) => void
  onDelete: (limit: BudgetLimit) => void
  /** «История изменений»: left out — the section is not shown (the markup tests of the form). */
  history?: HistoryState
  historyCategory?: number | null
  onHistoryCategory?: (categoryId: number | null) => void
  onHistoryRetry?: () => void
  /** «Бюджет месяца» (a newer server, with `base`): left out — the panel is not shown. */
  budget?: { state: BudgetPanelState; onSave: (amount: string | null) => Promise<string | undefined> }
}

export type HistoryState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; changes: BudgetLimitChange[] }

/** «История изменений»: who changed which limit and when, newest first; a list that reads on a phone, a filter by category. */
export function LimitHistory({ state, category = null, onCategory = () => {}, onRetry = () => {} }: {
  state: HistoryState; category?: number | null; onCategory?: (categoryId: number | null) => void; onRetry?: () => void
}) {
  const entries = state.kind === 'ok' ? historyEntries(state.changes) : []
  const options = historyCategories(entries)
  const shown = filterHistory(entries, category)
  const selected = shown.length === entries.length ? null : category
  let body
  if (state.kind === 'loading') body = <p className="dash-note" role="status">Загружаем историю…</p>
  else if (state.kind === 'error') body = <RequestState kind="error" message={state.message} onRetry={onRetry} />
  else if (!entries.length) body = <p className="dash-note">Лимиты пока не менялись.</p>
  else {
    body = <>
      {options.length > 1 && <div className="limits-history-filter">
        <label htmlFor="limits-history-category">Категория</label>
        <select id="limits-history-category" value={selected ?? ''}
          onChange={(event) => onCategory(event.target.value ? Number(event.target.value) : null)}>
          <option value="">Все категории</option>
          {options.map((option) => <option key={option.id} value={option.id}>{option.name}</option>)}
        </select>
      </div>}
      <ol className="limits-history-list">
        {shown.map((entry) => <li key={entry.key} className="limits-history-item">
          <div className="limits-history-meta">
            <time dateTime={entry.dateTime}>{entry.date}</time>
            <span className="limits-history-who">{entry.who}</span>
          </div>
          <div className="limits-history-category">{entry.category}</div>
          <div className="limits-history-change">
            <span className="ck-figures">{entry.text}</span>
            {entry.badge && <span className={`limits-history-badge limits-history-${entry.direction}`}>
              <span className="dash-visually-hidden">{entry.direction === 'up' ? 'больше на ' : 'меньше на '}</span>
              <span className="ck-figures">{entry.badge}</span>
            </span>}
          </div>
        </li>)}
      </ol>
    </>
  }
  return <section className="ck-panel dash-card limits-history" aria-labelledby="limits-history-heading">
    <h2 id="limits-history-heading" className="limits-small-heading">История изменений</h2>
    {body}
  </section>
}

export type BudgetPanelState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; budget: MonthBudget }

/** «Бюджет месяца» over the limits (2026-10-13): one amount of the family in the base currency, from this month on.
 * `onSave` — `null` removes it; resolves to the text of a failure, or nothing. */
export function MonthBudgetPanel({ state, family, onSave }: {
  state: BudgetPanelState; family: boolean; onSave: (amount: string | null) => Promise<string | undefined>
}) {
  const [draft, setDraft] = useState<string>()
  const [status, setStatus] = useState<RowStatus>(idle)
  const heading = <h2 id="limits-budget-heading" className="limits-small-heading">Бюджет месяца</h2>
  if (state.kind === 'loading') return <section className="ck-panel dash-card" aria-labelledby="limits-budget-heading">{heading}<p className="dash-note" role="status">Загружаем бюджет…</p></section>
  if (state.kind === 'error') return <section className="ck-panel dash-card" aria-labelledby="limits-budget-heading">{heading}<p className="dash-note">{state.message}</p></section>
  const { amount, currency, base_currency: base } = state.budget
  const value = draft ?? (amount ? amountInput(amount) : '')
  const busy = status.kind === 'busy'
  const save = async (next: string | null) => {
    setStatus({ kind: 'busy' })
    const failure = await onSave(next)
    if (failure) { setStatus({ kind: 'error', text: failure }); return }
    setDraft(undefined)
    setStatus({ kind: 'done', text: next === null ? 'Бюджет убран.' : 'Сохранено.' })
  }
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const parsed = parseLimitAmount(value)
    if ('error' in parsed) { setStatus({ kind: 'error', text: parsed.error }); return }
    void save(parsed.amount)
  }
  return <section className="ck-panel dash-card limits-budget" aria-labelledby="limits-budget-heading">
    {heading}
    <p className="dash-note">{`Сколько ${family ? 'семья готова' : 'вы готовы'} потратить за месяц на всё. От него Главная считает «можно `
      + 'тратить в день»; без бюджета — от суммы лимитов. Прошлые месяцы сохраняют свой бюджет.'}</p>
    <form className="limits-form" noValidate aria-busy={busy} onSubmit={submit}>
      <div className="limits-row-head">
        <label className="limits-name" htmlFor="limits-budget">Сумма на месяц</label>
        <span className="limits-current ck-figures">{amount && currency ? formatMoney(amount, currency) : 'не задан'}</span>
      </div>
      <div className="limits-controls">
        <span className="limits-input">
          <input id="limits-budget" inputMode="decimal" autoComplete="off" enterKeyHint="done" placeholder="Сумма в месяц" value={value}
            aria-invalid={status.kind === 'error'} aria-describedby={status.kind === 'error' || status.kind === 'done' ? 'limits-budget-message' : undefined}
            onChange={(event) => { setDraft(event.target.value); setStatus(idle) }} />
          <span className="limits-input-currency" aria-hidden="true">{currencySymbol(base)}</span>
        </span>
        <button type="submit" className="limits-budget-save" disabled={busy}>Сохранить</button>
        {amount && <button type="button" className="ck-button-danger limits-delete" disabled={busy} onClick={() => { void save(null) }}>Убрать</button>}
      </div>
      {status.kind === 'error' && <p className="receipt-field-error" id="limits-budget-message" role="alert">{status.text}</p>}
      {status.kind === 'done' && <p className="limits-done" id="limits-budget-message" role="status">{status.text}</p>}
    </form>
  </section>
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
      <button type="submit" className="ck-button-secondary">Добавить</button>
    </div>
    {error && <p className="receipt-field-error" id="limits-new-currency-error">{error}</p>}
  </form>
}

/** The limits screen without loading: the markup tests render it directly. */
export function LimitsView({
  categories, limits, currencies, currency, family, base, drafts, statuses, toggled = {}, onToggle = () => {}, onCurrency, onAddCurrency, onDraft, onSave,
  onSaveAll = (changed) => changed.forEach(onSave), onDelete, history, historyCategory = null, onHistoryCategory, onHistoryRetry, budget,
}: LimitsViewProps) {
  const tree = limitTree(categories)
  const opened = openByDefault(tree, limits, currency, drafts)
  const isOpen = (rootId: number) => toggled[rootId] ?? opened.has(rootId)
  const changed = changedRows(categories, limits, currency, drafts)
  const saving = Object.entries(statuses).some(([key, status]) => key.endsWith(`:${currency}`) && status.kind === 'busy')
  return <div className="limits">
    <p className="limits-intro">{family
      ? 'Лимит — сколько семья готова потратить на категорию за месяц. Лимиты общие: их видят и меняют все члены семьи.'
      : 'Лимит — сколько вы готовы потратить на категорию за месяц.'} Лимит можно задать и подкатегории: её траты входят
      и в её лимит, и в лимит категории выше.</p>
    {base ? <section className="ck-panel dash-card limits-currencies" aria-labelledby="limits-currency-heading">
      <h2 id="limits-currency-heading" className="limits-small-heading">Валюта · {currencySymbol(base)}</h2>
      <p className="dash-note limits-base-note">{`Лимиты — в основной валюте${family ? ' семьи' : ''} (${base}): траты в других `
        + 'валютах пересчитываются по курсу Нацбанка на день покупки. Основную валюту '
        + `${family ? 'выбирает главный в семье' : 'вы выбираете'} в «`}<Link className="dash-inline-link" to="/account">Аккаунте</Link>».</p>
    </section> : <section className="ck-panel dash-card limits-currencies" aria-labelledby="limits-currency-heading">
      <h2 id="limits-currency-heading" className="limits-small-heading">Валюта</h2>
      <ChipScroller label="Валюта лимитов">
        {currencies.map((code) => <button key={code} type="button" className="dash-chip" aria-pressed={code === currency}
          onClick={() => onCurrency(code)}>{code}</button>)}
      </ChipScroller>
      <AddCurrency onAdd={onAddCurrency} />
    </section>}
    {base && budget && <MonthBudgetPanel state={budget.state} family={family} onSave={budget.onSave} />}
    {categories.length ? <ul className="limits-list" aria-label={`Лимиты в ${currency}`}>
      {visibleRows(tree, isOpen).map(({ category, depth, rootId, descendants }) => {
        const key = rowKey(category.id, currency)
        const limit = limitFor(limits, category.id, currency)
        const legacy = base ? legacyLimit(limits, category.id, base) : undefined
        const draft = drafts[key]
        const status = statuses[key] ?? idle
        const action = rowAction(draft, limit)
        const busy = status.kind === 'busy'
        const inputId = `limit-${category.id}`
        const messageId = `${inputId}-message`
        const invalid = status.kind === 'error'
        const open = isOpen(rootId)
        // The indent stops at four levels: deeper rows would leave no room for the amount on a phone.
        const indent = { '--limits-depth': Math.min(depth, 4) } as CSSProperties
        // A full-width row of one list; Enter in its field saves this row alone, the bar below saves every changed one.
        return <li key={key}
          className={`limits-row${depth ? ' limits-row-sub' : ''}${action.kind === 'none' ? '' : ' limits-row-changed'} dash-cat-${categoryTone(rootId)}`}
          style={depth ? indent : undefined}>
          <form className="limits-form" noValidate aria-busy={busy} onSubmit={(event) => { event.preventDefault(); onSave(category) }}>
            <div className="limits-row-head">
              <span className="dash-dot" aria-hidden="true" />
              <label className="limits-name" htmlFor={inputId}>
                {depth > 0 && <span className="dash-visually-hidden">{category.path.slice(0, -1).map((step) => step.name).join(' › ')} › </span>}
                {category.name}
              </label>
              <span className="limits-current ck-figures">{limit ? formatMoney(limit.amount, currency)
                : legacy ? formatMoneyWithBase(legacy.amount, legacy.currency, legacy.base_amount, base) : 'без лимита'}</span>
            </div>
            <div className="limits-controls">
              <span className="limits-input">
                <input id={inputId} inputMode="decimal" autoComplete="off" enterKeyHint="done" placeholder="Сумма в месяц"
                  value={draft ?? (limit ? amountInput(limit.amount) : '')} aria-invalid={invalid}
                  aria-describedby={status.kind === 'idle' || busy ? undefined : messageId}
                  onChange={(event) => onDraft(key, event.target.value)} />
                <span className="limits-input-currency" aria-hidden="true">{currencySymbol(currency)}</span>
              </span>
              {(limit ?? legacy) && <button type="button" className="ck-button-danger limits-delete" disabled={busy}
                aria-label={`Удалить лимит «${category.name}»`} onClick={() => onDelete((limit ?? legacy) as BudgetLimit)}>Удалить</button>}
            </div>
            {status.kind === 'error' && <p className="receipt-field-error" id={messageId} role="alert">{status.text}</p>}
            {status.kind === 'done' && <p className="limits-done" id={messageId} role="status">{status.text}</p>}
          </form>
          {depth === 0 && descendants > 0 && <button type="button" className="limits-toggle" aria-expanded={open}
            aria-label={`${open ? 'Скрыть' : 'Показать'} подкатегории «${category.name}»`}
            onClick={() => onToggle(rootId, !open)}><Icon name="forward" size={14} className={`ck-icon limits-toggle-chevron${open ? ' limits-toggle-open' : ''}`} />{open ? 'Скрыть' : 'Показать'} {subCategoriesText(descendants)}</button>}
        </li>
      })}
    </ul> : <RequestState kind="empty" message="Категорий пока нет: их заводят в каталоге." action={<Link className="action-link" to="/catalog">В каталог</Link>} />}
    {categories.length > 0 && <div className="limits-savebar ck-action-bar">
      <button type="button" className="limits-save" disabled={saving || !changed.length} onClick={() => onSaveAll(changed)}>
        {saving ? 'Сохраняем…' : saveBarLabel(changed.length)}</button>
    </div>}
    {history && <LimitHistory state={history} category={historyCategory} onCategory={onHistoryCategory} onRetry={onHistoryRetry} />}
    <p className="limits-back"><Link className="dash-link" to="/">На главную</Link></p>
  </div>
}

type Loaded = { categories: Category[]; currency: string; base?: string }
type Load = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'ok'; data: Loaded }

/** `/budget/limits`: a limit per category (any level) and currency, saved and deleted row by row. */
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
  const [toggled, setToggled] = useState<Record<number, boolean>>({})
  const [history, setHistory] = useState<HistoryState>({ kind: 'loading' })
  const [historyCategory, setHistoryCategory] = useState<number | null>(null)
  // Bumped after every saved or deleted limit: the journal gains an entry.
  const [historyAttempt, setHistoryAttempt] = useState(0)
  const [budget, setBudget] = useState<BudgetPanelState>({ kind: 'loading' })

  useEffect(() => {
    const controller = new AbortController()
    // Read apart from the form, like the journal: when it fails, the limits can still be changed.
    void getMonthBudget({ signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || result.kind === 'aborted') return
      setBudget(result.kind === 'ok' ? { kind: 'ok', budget: result.data } : { kind: 'error', message: dashboardErrorMessage(result) })
    })
    return () => controller.abort()
  }, [attempt])

  const saveBudget = async (amount: string | null): Promise<string | undefined> => {
    const result = await saveMonthBudget(amount)
    if (result.kind === 'aborted') return undefined
    if (result.kind === 'error') return limitFailureMessage(result)
    setBudget((before) => before.kind !== 'ok' ? before
      : { kind: 'ok', budget: result.data ?? { ...before.budget, amount: null, currency: null } })
    return undefined
  }
  const controllers = useRef(new Map<string, AbortController>())

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    void Promise.all([getCategories({}, { signal }), getBudgetLimitBook({ signal }), getManualDefaults({ signal })]).then(([categories, saved, defaults]) => {
      if (signal.aborted) return
      for (const result of [categories, saved, defaults]) {
        if (result.kind === 'aborted') return
        if (result.kind === 'error') { setLoad({ kind: 'error', message: dashboardErrorMessage(result) }); return }
      }
      if (categories.kind !== 'ok' || saved.kind !== 'ok' || defaults.kind !== 'ok') return
      setLimits(saved.data.limits)
      const base = saved.data.baseCurrency
      setLoad({ kind: 'ok', data: { categories: categories.data.results, currency: base ?? defaults.data.currency, base } })
    })
    return () => controller.abort()
  }, [attempt])

  useEffect(() => {
    const controller = new AbortController()
    // The journal is read apart from the form: when it fails, the limits can still be changed.
    void getBudgetLimitHistory({}, { signal: controller.signal }).then((result) => {
      if (controller.signal.aborted || result.kind === 'aborted') return
      setHistory(result.kind === 'ok' ? { kind: 'ok', changes: result.data.changes } : { kind: 'error', message: dashboardErrorMessage(result) })
    })
    return () => controller.abort()
  }, [historyAttempt])

  useEffect(() => {
    const running = controllers.current
    return () => running.forEach((controller) => controller.abort())
  }, [])

  if (load.kind === 'loading') return <RequestState kind="loading" message="Загружаем лимиты…" />
  if (load.kind === 'error') return <RequestState kind="error" message={load.message}
    onRetry={() => { setLoad({ kind: 'loading' }); setAttempt((value) => value + 1) }} />

  const { base } = load.data
  const currencies = base ? [base] : limitCurrencies(load.data.currency, limits, added)
  const selected = base ?? currency ?? currencies[0]
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
    // A limit of another currency set before: saving the row moves it to the base currency with the new amount.
    const legacy = base && action.kind === 'create' ? legacyLimit(limits, category.id, base) : undefined
    const result = legacy
      ? await updateBudgetLimit(legacy.id, action.amount, { signal: controller.signal }, base)
      : action.kind === 'create'
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
    setHistoryAttempt((value) => value + 1)
    clearDraft(key)
    setStatus(key, { kind: 'done', text: 'Сохранено.' })
  }

  const remove = async (limit: BudgetLimit) => {
    // A converted limit of another currency stands in the row of the base currency.
    const key = rowKey(limit.category_id, base ?? limit.currency)
    const controller = begin(key)
    const result = await deleteBudgetLimit(limit.id, { signal: controller.signal })
    if (controller.signal.aborted || result.kind === 'aborted') return
    controllers.current.delete(key)
    // Already gone is what the person wanted.
    if (result.kind === 'error' && result.reason !== 'not_found') { setStatus(key, { kind: 'error', text: limitFailureMessage(result) }); return }
    setLimits((all) => withoutLimit(all, limit.id))
    setHistoryAttempt((value) => value + 1)
    clearDraft(key)
    setStatus(key, { kind: 'done', text: 'Лимит удалён.' })
  }

  return <LimitsView categories={load.data.categories} limits={limits} currencies={currencies} currency={selected} family={family} base={base}
    drafts={drafts} statuses={statuses} toggled={toggled} onToggle={(rootId, open) => setToggled((all) => ({ ...all, [rootId]: open }))}
    onCurrency={setCurrency}
    onAddCurrency={(input) => {
      const parsed = parseCurrency(input)
      if ('error' in parsed) return parsed.error
      if (!currencies.includes(parsed.currency)) setAdded((all) => [...all, parsed.currency])
      setCurrency(parsed.currency)
      return undefined
    }}
    onDraft={(key, value) => { setDrafts((all) => ({ ...all, [key]: value })); setStatus(key, idle) }}
    onSave={(category) => { void save(category) }} onDelete={(limit) => { void remove(limit) }}
    budget={{ state: budget, onSave: saveBudget }}
    history={history} historyCategory={historyCategory} onHistoryCategory={setHistoryCategory}
    onHistoryRetry={() => { setHistory({ kind: 'loading' }); setHistoryAttempt((value) => value + 1) }} />
}
