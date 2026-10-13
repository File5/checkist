import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { getCategories } from '../../api/catalog'
import { getGoals } from '../../api/goals'
import type { Goal } from '../../api/goals'
import { assignStatementGoal, deleteStatement, getStatement, saveStatement } from '../../api/statements'
import type { StatementDetail, StatementRow } from '../../api/statements'
import type { Category } from '../../api/types'
import RequestState from '../../components/RequestState'
import Sheet from '../../components/Sheet'
import { usePageTitle } from '../../components/page-header'
import { Link, navigate } from '../../navigation'
import { formatMoney } from '../../lib/money'
import { glue } from '../../lib/text'
import { createPollingRequest } from '../recognition/polling'
import {
  asGoal, canBeGoal, categoryOptions, giftWord, isQuestionable, keepsPolling, missingCategory, periodText, reasonText, reviewNote,
  rowMeta, rowWord, ruleWord, saveable, saveLabel, saveRows, sections, setCategory, setStore, spendWord, syncEdits, toggleRow,
} from './statement-state'
import type { Edits } from './statement-state'
import { statementFailure, statementTexts } from './statement-texts'
import './Statements.css'

export type StatementViewProps = {
  detail: StatementDetail
  edits: Edits
  categories: Category[]
  /** Goals the person sees: «Это взнос в цель» of a transfer picks one. */
  goals?: Goal[]
  /** The row whose editor is open. */
  open: number | null
  saving: boolean
  /** «Сохранено 12 трат…» after a save, or the hint of a choice for the same payee. */
  notice: string | null
  failure: string | null
  onOpen: (id: number | null) => void
  onToggle: (id: number, checked: boolean) => void
  onCategory: (id: number, category: number | null) => void
  onStore: (id: number, store: string) => void
  /** «Это взнос в цель»: the transfers of this payee become contributions to the goal, now and in the next statements. */
  onGoal?: (id: number, goal: number) => void
  onSave: () => void
  onDelete: () => void
}

/** «18 450 ₸» of a spend, «+150 000 ₸» of an incoming. */
function amountText(row: StatementRow): string {
  if (!row.amount.startsWith('-')) return `+${formatMoney(row.amount, row.currency)}`
  // A purchase returned in full shows what the bank took; any other — what goes into the spend.
  return formatMoney(row.spend !== '0.00' ? row.spend : row.amount.slice(1), row.currency)
}

type RowProps = Pick<StatementViewProps, 'edits' | 'onOpen' | 'onToggle' | 'onCategory' | 'onStore' | 'onGoal'> & {
  row: StatementRow; open: boolean; options: { id: number; label: string }[]; byId: Map<number, Category>; goals: Goal[]
}

/** «Это взнос в цель» of a transfer: a goal and one button; no goals yet — a link to make one. */
function GoalPick({ row, goals, onGoal }: { row: StatementRow; goals: Goal[]; onGoal?: (id: number, goal: number) => void }) {
  const [picked, setGoal] = useState(0)
  // The goals may arrive after the editor opened: until a pick, the first one.
  const goal = goals.some((item) => item.id === picked) ? picked : goals[0]?.id ?? 0
  if (!goals.length) {
    return <p className="statement-details">Перевод на свой депозит можно считать взносом в цель — <Link to="/goals">заведите цель</Link>.</p>
  }
  return <div className="statement-goal-pick">
    <label className="statement-field">
      <span>Это взнос в цель</span>
      <select value={goal} onChange={(event) => setGoal(Number(event.target.value))}>
        {goals.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select>
    </label>
    <button type="button" className="ck-button-secondary" onClick={() => onGoal?.(row.id, goal)}>Это взнос — запомнить</button>
  </div>
}

function RowItem({ row, open, edits, options, byId, goals, onOpen, onToggle, onCategory, onStore, onGoal }: RowProps) {
  const edit = edits[row.id]
  const title = edit?.store.trim() || row.store_name || row.merchant || row.operation
  const questionable = isQuestionable(row)
  const note = row.receipt_id !== null ? '' : questionable ? reviewNote(row, edit) : reasonText(row)
  const editable = saveable(row)
  const gift = asGoal(row)
  const editorId = `statement-row-${row.id}-edit`
  return <li className={`statement-row${questionable && !edit?.touched ? ' statement-row-review' : ''}`} data-state={row.state} data-kind={row.kind}>
    <div className="statement-row-line">
      {editable
        ? <label className="statement-check-box">
          <input type="checkbox" className="statement-check" checked={edit?.checked ?? false} aria-label={`${gift ? 'Сохранить взносом' : 'Сохранить тратой'}: ${title}, ${amountText(row)}`}
            onChange={(event) => onToggle(row.id, event.target.checked)} />
        </label>
        : <span className="statement-check-box" aria-hidden="true" />}
      <button type="button" className="statement-row-open" aria-expanded={open} aria-controls={open ? editorId : undefined}
        onClick={() => onOpen(open ? null : row.id)}>
        <span className="ck-row-main">
          <span className="ck-row-title">{title}</span>
          <span className="ck-row-meta">{rowMeta(row, edit, byId)}</span>
        </span>
        <span className={`ck-row-amount${row.amount.startsWith('-') ? '' : ' statement-income'}`}>{amountText(row)}</span>
      </button>
    </div>
    {note && <p className="statement-row-note">{note}</p>}
    {open && <div className="statement-row-edit" id={editorId}>
      <p className="statement-details"><span>{row.operation}</span> {row.details}{row.mcc ? ` · MCC ${row.mcc}` : ''}</p>
      {row.refund !== '0.00' && <p className="statement-details">С учётом возврата {formatMoney(row.refund, row.currency)}</p>}
      {row.receipt_id !== null && <Link className="statement-saved-link" to={`/receipts/${row.receipt_id}`}>Открыть трату</Link>}
      {row.goal && (gift || row.contribution_id) && <p className="statement-details">Взнос в цель{' '}
        <Link className="statement-saved-link" to={`/goals/${row.goal.id}`}>«{row.goal.name}»</Link> — не трата.</p>}
      {canBeGoal(row) && <GoalPick row={row} goals={goals} onGoal={onGoal} />}
      {editable && !gift && <>
        <label className="statement-field">
          <span>Категория</span>
          <select value={edit?.category ?? ''} onChange={(event) => onCategory(row.id, event.target.value ? Number(event.target.value) : null)}>
            <option value="">Выберите категорию</option>
            {options.map((option) => <option key={option.id} value={option.id}>{option.label}</option>)}
          </select>
        </label>
        <label className="statement-field">
          <span>Где</span>
          <input type="text" value={edit?.store ?? ''} maxLength={100} autoComplete="off" placeholder="Без места"
            onChange={(event) => onStore(row.id, event.target.value)} />
        </label>
      </>}
    </div>}
  </li>
}

function Rows({ rows, ...props }: Omit<RowProps, 'row' | 'open'> & { rows: StatementRow[]; openId: number | null }) {
  const { openId, ...rest } = props
  return <ul className="ck-list statement-rows">
    {rows.map((row) => <RowItem key={row.id} row={row} open={openId === row.id} {...rest} />)}
  </ul>
}

/** A collapsed group at the bottom: «Пропущено: 14», «Поступления: 6». */
function Group({ title, rows, children }: { title: string; rows: StatementRow[]; children: ReactNode }) {
  if (!rows.length) return null
  return <details className="ck-panel statement-group">
    <summary><span>{title}: {rows.length}</span><svg className="statement-chevron" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6" /></svg></summary>
    {children}
  </details>
}

/** The draft without the network: the markup tests render it directly. */
export function StatementView(props: StatementViewProps) {
  const { detail, edits, categories, open, saving, notice, failure, onSave, onDelete } = props
  const options = useMemo(() => categoryOptions(categories), [categories])
  const byId = useMemo(() => new Map(categories.map((category) => [category.id, category])), [categories])
  const parts = sections(detail.rows)
  const chosen = saveRows(detail.rows, edits)
  const missing = missingCategory(detail.rows, edits)
  const questionable = parts.toSave.filter(isQuestionable).length
  const rowProps = {
    edits, options, byId, goals: props.goals ?? [], openId: open, onOpen: props.onOpen, onToggle: props.onToggle,
    onCategory: props.onCategory, onStore: props.onStore, onGoal: props.onGoal,
  }
  const waiting = detail.ai.waiting > 0 && detail.ai.active
  return <div className="statements ck-stack">
    <section className="ck-panel statement-summary" aria-label="Выписка">
      <p className="statement-summary-period">За {periodText(detail)}</p>
      <ul className="statement-counts">
        {(parts.toSave.length > 0 || parts.saved.length === 0) && <li><strong>{parts.toSave.length}</strong> к сохранению</li>}
        {questionable > 0 && <li className="statement-count-review"><strong>{questionable}</strong> спорных</li>}
        {parts.goals.length > 0 && <li><strong>{parts.goals.length}</strong> в цели</li>}
        {parts.duplicates.length > 0 && <li><strong>{parts.duplicates.length}</strong> уже внесены</li>}
        {parts.saved.length > 0 && <li><strong>{parts.saved.length}</strong> сохранено</li>}
      </ul>
      {waiting && <p className="statement-model" role="status">
        {detail.ai.executor.state === 'absent' ? statementTexts.modelAbsent : statementTexts.modelWaiting(detail.ai.waiting)}
      </p>}
    </section>
    {notice && <p className="statement-notice" role="status">{notice}</p>}
    {parts.toSave.length > 0 && <section className="ck-panel" aria-labelledby="statement-spends-heading">
      <div className="ck-panel-head"><h2 id="statement-spends-heading">Траты</h2></div>
      <Rows rows={parts.toSave} {...rowProps} />
    </section>}
    {parts.goals.length > 0 && <section className="ck-panel" aria-labelledby="statement-goals-heading">
      <div className="ck-panel-head"><h2 id="statement-goals-heading">Взносы в цели</h2></div>
      <p className="statement-note statement-small">Переводы на свой депозит по вашему правилу: сохранятся взносами в цель, тратами не станут.</p>
      <Rows rows={parts.goals} {...rowProps} />
    </section>}
    {parts.duplicates.length > 0 && <section className="ck-panel" aria-labelledby="statement-duplicates-heading">
      <div className="ck-panel-head"><h2 id="statement-duplicates-heading">Уже внесены</h2></div>
      <p className="statement-note statement-small">Такие траты уже есть — строки не отмечены. Отметьте, если это другая покупка.</p>
      <Rows rows={parts.duplicates} {...rowProps} />
    </section>}
    <Group title="Сохранено" rows={parts.saved}><Rows rows={parts.saved} {...rowProps} /></Group>
    <Group title="Пропущено" rows={parts.skipped}>
      <p className="statement-note statement-small">Переводы, наличные и движения между своими счетами тратами не считаются. Строку можно сохранить, выбрав ей категорию.</p>
      <Rows rows={parts.skipped} {...rowProps} />
    </Group>
    <Group title="Поступления" rows={parts.incomes}>
      <p className="statement-note statement-small">Деньги, пришедшие на карту. Тратами не становятся.</p>
      <Rows rows={parts.incomes} {...rowProps} />
    </Group>
    <div className="statement-actions ck-action-bar">
      {failure && <p className="statement-status statement-status-error" role="alert">{failure}</p>}
      {!failure && missing.length > 0 && <p className="statement-status">{statementTexts.missing(missing.length)}</p>}
      <button type="button" className="statement-save" disabled={saving || chosen.length === 0} onClick={onSave}>
        {saving ? 'Сохраняю…' : saveLabel(detail.rows, edits)}
      </button>
    </div>
    <div className="statement-footer">
      <Link className="statement-rules-link" to="/statements/rules">Правила получателей</Link>
      <button type="button" className="ck-button-danger statement-delete" onClick={onDelete}>Убрать черновик</button>
    </div>
  </div>
}

/** The draft of one statement: polls while the model answers, saves the checked rows. */
export default function StatementPage({ statementId }: { statementId: number }) {
  const request = useMemo(() => createPollingRequest((signal) => getStatement(statementId, { signal }), keepsPolling), [statementId])
  const state = useSyncExternalStore(request.subscribe, request.getSnapshot, request.getServerSnapshot)
  const [edits, setEdits] = useState<Edits>({})
  const [categories, setCategories] = useState<Category[]>([])
  const [goals, setGoals] = useState<Goal[]>([])
  const [open, setOpen] = useState<number | null>(null)
  const [saving, setSaving] = useState(false)
  const [notice, setNotice] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const [confirm, setConfirm] = useState(false)
  const [seen, setSeen] = useState<StatementDetail | undefined>(undefined)

  useEffect(() => { request.start(); return () => request.dispose() }, [request])
  useEffect(() => {
    const abort = new AbortController()
    void getCategories({}, { signal: abort.signal }).then((result) => { if (result.kind === 'ok') setCategories(result.data.results) })
    void getGoals({ signal: abort.signal }).then((result) => { if (result.kind === 'ok') setGoals(result.data.results) })
    return () => abort.abort()
  }, [])
  const detail = state.kind === 'ok' ? state.data : undefined
  // A new reading of the draft: rows the person did not touch follow it (the model answered, a save went through).
  if (detail && detail !== seen) {
    setSeen(detail)
    setEdits((previous) => syncEdits(detail.rows, previous))
  }
  usePageTitle(detail ? `Выписка ${detail.bank_name}` : undefined)

  if (state.kind === 'loading') return <RequestState kind="loading" message="Загружаем черновик выписки…" />
  if (state.kind === 'error') return <RequestState kind="error" message={statementFailure(state.error)} onRetry={() => request.refresh()} />
  const current = state.data

  const save = async () => {
    const rows = saveRows(current.rows, edits)
    if (!rows.length || saving) return
    setSaving(true)
    setFailure(null)
    request.pause()
    const result = await saveStatement(current.id, rows)
    setSaving(false)
    if (result.kind === 'ok') {
      const { created, learned, contributed } = result.data
      const saved = [created || !contributed ? glue(created, spendWord(created)) : '', contributed ? glue(contributed, giftWord(contributed)) : '']
      setNotice(`Сохранено: ${saved.filter(Boolean).join(' и ')}.${learned ? ` Запомнил ${glue(learned, ruleWord(learned))} для следующих выписок.` : ''}`)
      setOpen(null)
      request.setData(result.data.statement)
      request.resume(false)
      return
    }
    request.resume()
    if (result.kind === 'error') setFailure(statementFailure(result))
  }
  const assign = async (id: number, goal: number) => {
    if (saving) return
    const row = current.rows.find((item) => item.id === id)
    setSaving(true)
    setFailure(null)
    request.pause()
    const result = await assignStatementGoal(current.id, id, goal)
    setSaving(false)
    if (result.kind === 'ok') {
      const name = goals.find((item) => item.id === goal)?.name ?? ''
      setNotice(`Запомнил: переводы «${row?.merchant ?? ''}» — взносы в цель «${name}». В этой выписке — ${glue(result.data.applied, rowWord(result.data.applied))}.`)
      setOpen(null)
      request.setData(result.data.statement)
      request.resume(false)
      return
    }
    request.resume()
    if (result.kind === 'error') setFailure(statementFailure(result))
  }
  const remove = async () => {
    setConfirm(false)
    const result = await deleteStatement(current.id)
    if (result.kind === 'ok') navigate('/statements/new', { replace: true })
    else if (result.kind === 'error') setFailure(statementFailure(result))
  }
  const choose = (id: number, category: number | null) => {
    const { edits: next, followers } = setCategory(edits, current.rows, id, category)
    setEdits(next)
    setNotice(followers ? `Та же категория — ещё у ${glue(followers, rowWord(followers))} этого получателя.` : null)
  }
  return <>
    <StatementView detail={current} edits={edits} categories={categories} goals={goals} onGoal={(id, goal) => { void assign(id, goal) }} open={open} saving={saving} notice={notice} failure={failure}
      onOpen={setOpen} onToggle={(id, checked) => setEdits((previous) => toggleRow(previous, id, checked))}
      onCategory={choose} onStore={(id, store) => setEdits((previous) => setStore(previous, id, store))}
      onSave={() => { void save() }} onDelete={() => setConfirm(true)} />
    <Sheet open={confirm} onClose={() => setConfirm(false)} title="Убрать черновик">
      <div className="statement-confirm">
        <p>{statementTexts.deleteQuestion}</p>
        <button type="button" className="ck-button-danger" onClick={() => { void remove() }}>Убрать</button>
        <button type="button" className="ck-button-secondary" onClick={() => setConfirm(false)}>Оставить</button>
      </div>
    </Sheet>
  </>
}
