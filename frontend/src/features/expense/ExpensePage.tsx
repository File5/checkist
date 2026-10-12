import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { getCategories } from '../../api/catalog'
import { createManualSpend, getManualDefaults, getReceipt, getReceiptLines, updateManualSpend } from '../../api/receipts'
import type { Line, ManualDefaults, Receipt } from '../../api/receipts'
import type { Category, LocalApiResult } from '../../api/types'
import RequestState from '../../components/RequestState'
import { formatAmount } from '../../lib/format'
import { Link, navigate } from '../../navigation'
import { errorMessage } from '../receipts/state'
import type { Failure } from '../receipts/state'
import { saveMessage } from './labels'
import {
  categoryChips, chipLabel, sentIndexes, draftBody, draftFromReceipt, emptyDraft, linesTotal, filledLines, LINES_MAX, newLine,
  savedNotice, serverErrors, setExpenseNotice, updatedNotice, visibleChips,
} from './expense-form'
import type { ExpenseDraft, ExpenseErrors, LineDraft } from './expense-form'
import './Expense.css'

type Loaded = { draft: ExpenseDraft; chips: Category[] }
type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'read-only' } | { kind: 'ok'; data: Loaded }

const dateField = 'date'
const fieldError = (errors: ExpenseErrors, name: string) => errors[name]
  ? <p className="receipt-field-error" id={`expense-${name.replaceAll('.', '-')}-error`}>{errors[name]}</p> : null
const describedBy = (errors: ExpenseErrors, name: string) => errors[name] ? `expense-${name.replaceAll('.', '-')}-error` : undefined

export type ExpenseFormProps = {
  draft: ExpenseDraft; chips: Category[]; errors: ExpenseErrors; saving: boolean; failure?: string
  /** `undefined` — a new spend; otherwise the page of the spend is where «Отмена» leads. */
  receiptId?: number
  onChange: (draft: ExpenseDraft) => void; onSubmit: () => void
}

/** The form itself, without loading and saving: the markup tests render it directly. */
export function ExpenseForm({ draft, chips, errors, saving, failure, receiptId, onChange, onSubmit }: ExpenseFormProps) {
  const [expanded, setExpanded] = useState(false)
  const itemized = filledLines(draft.lines).length > 0
  const sum = linesTotal(draft.lines)
  // Errors name a position by its place among the sent ones: an untouched empty row is not sent.
  const sent = sentIndexes(draft.lines)
  const shown = visibleChips(chips, draft.category, expanded)
  const set = (patch: Partial<ExpenseDraft>) => onChange({ ...draft, ...patch })
  const setLine = (key: number, patch: Partial<LineDraft>) => set({ lines: draft.lines.map((line) => line.key === key ? { ...line, ...patch } : line) })
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit() }
  return <form className="expense-form" onSubmit={submit} noValidate aria-busy={saving}>
    {failure && <p className="expense-failure" role="alert">{failure}</p>}
    {errors.form && <p className="expense-failure" role="alert">{errors.form}</p>}
    <div className="expense-amount receipt-field">
      <label htmlFor="expense-amount">{itemized ? 'Сумма позиций' : 'Сумма'}</label>
      <div className="expense-amount-row">
        <input id="expense-amount" className="expense-amount-input" inputMode="decimal" autoComplete="off" enterKeyHint="done"
          placeholder="0" value={itemized ? (sum ?? '') : draft.amount} readOnly={itemized} aria-invalid={Boolean(errors.amount)}
          aria-describedby={describedBy(errors, 'amount')} onChange={(event) => set({ amount: event.target.value })} />
        <label className="expense-currency">
          <span className="expense-visually-hidden">Валюта</span>
          <input value={draft.currency} maxLength={3} autoCapitalize="characters" autoComplete="off" spellCheck={false}
            aria-invalid={Boolean(errors.currency)} aria-describedby={describedBy(errors, 'currency')}
            onChange={(event) => set({ currency: event.target.value.toUpperCase() })} />
        </label>
      </div>
      {itemized && <p className="receipt-note">Сумма считается по позициям.</p>}
      {fieldError(errors, 'amount')}
      {fieldError(errors, 'currency')}
    </div>

    <fieldset className="expense-categories" aria-describedby={describedBy(errors, 'category')}>
      <legend>Категория{itemized && ' позиций без своей'}</legend>
      <div className="expense-chips">
        {shown.map((category) => <button type="button" key={category.id} className="expense-chip"
          aria-pressed={draft.category === category.id} title={category.path.map((step) => step.name).join(' › ') || category.name}
          onClick={() => set({ category: draft.category === category.id && itemized ? null : category.id })}>{chipLabel(category)}</button>)}
        {chips.length > shown.length && <button type="button" className="expense-chip expense-more" aria-expanded={false}
          onClick={() => setExpanded(true)}>Все категории</button>}
      </div>
      {!chips.length && <p className="receipt-note">Категорий пока нет: их заводят в каталоге.</p>}
      {fieldError(errors, 'category')}
    </fieldset>

    <div className="expense-grid">
      <div className="receipt-field">
        <label htmlFor="expense-date">Дата</label>
        <input id="expense-date" type="date" value={draft.date} aria-invalid={Boolean(errors.date)} aria-describedby={describedBy(errors, dateField)}
          onChange={(event) => set({ date: event.target.value })} />
        {fieldError(errors, dateField)}
      </div>
      <div className="receipt-field">
        <label htmlFor="expense-place">Место <span className="receipt-note">необязательно</span></label>
        <input id="expense-place" autoComplete="off" value={draft.place} placeholder="Без места" aria-invalid={Boolean(errors.place)}
          aria-describedby={describedBy(errors, 'place')} onChange={(event) => set({ place: event.target.value })} />
        {fieldError(errors, 'place')}
      </div>
    </div>
    <div className="receipt-field">
      <label htmlFor="expense-note">Комментарий <span className="receipt-note">необязательно</span></label>
      <textarea id="expense-note" rows={2} value={draft.note} aria-invalid={Boolean(errors.note)} aria-describedby={describedBy(errors, 'note')}
        onChange={(event) => set({ note: event.target.value })} />
      {fieldError(errors, 'note')}
    </div>

    <section className="expense-lines" aria-labelledby="expense-lines-heading">
      <h3 id="expense-lines-heading">Позиции <span className="receipt-note">необязательно</span></h3>
      {draft.lines.length > 0 && <ol className="expense-line-list">{draft.lines.map((line, index) => <li key={line.key} className="expense-line">
        <div className="receipt-field">
          <label htmlFor={`expense-line-${line.key}-name`}>Позиция {index + 1}</label>
          <input id={`expense-line-${line.key}-name`} autoComplete="off" value={line.name} aria-invalid={Boolean(errors[`lines.${sent[index]}.name`])}
            aria-describedby={describedBy(errors, `lines.${sent[index]}.name`)} onChange={(event) => setLine(line.key, { name: event.target.value })} />
          {fieldError(errors, `lines.${sent[index]}.name`)}
        </div>
        <div className="receipt-field expense-line-amount">
          <label htmlFor={`expense-line-${line.key}-amount`}>Сумма</label>
          <input id={`expense-line-${line.key}-amount`} inputMode="decimal" autoComplete="off" value={line.amount}
            aria-invalid={Boolean(errors[`lines.${sent[index]}.amount`])} aria-describedby={describedBy(errors, `lines.${sent[index]}.amount`)}
            onChange={(event) => setLine(line.key, { amount: event.target.value })} />
          {fieldError(errors, `lines.${sent[index]}.amount`)}
        </div>
        <button type="button" className="expense-line-remove receipt-secondary" aria-label={`Убрать позицию ${index + 1}`}
          onClick={() => set({ lines: draft.lines.filter((other) => other.key !== line.key) })}>Убрать</button>
      </li>)}</ol>}
      {fieldError(errors, 'lines')}
      {draft.lines.length < LINES_MAX && <button type="button" className="receipt-secondary expense-add-line"
        onClick={() => set({ lines: [...draft.lines, newLine()] })}>Добавить позицию</button>}
    </section>

    <div className="expense-actions ck-action-bar">
      <button type="submit" className="expense-save" disabled={saving}>{saving ? 'Сохраняем…' : 'Сохранить'}</button>
      <Link className="action-link" to={receiptId === undefined ? '/receipts' : `/receipts/${receiptId}`}>Отмена</Link>
      {itemized && sum && <span className="expense-sum receipt-number">{formatAmount(sum, draft.currency)}</span>}
    </div>
  </form>
}

function unwrap<T>(result: LocalApiResult<T>): T | Failure | undefined {
  if (result.kind === 'ok') return result.data
  return result.kind === 'error' ? result : undefined
}
const isFailure = (value: unknown): value is Failure => typeof value === 'object' && value !== null && (value as Failure).kind === 'error'

/** `/receipts/new` and `/receipts/{id}/edit`: loads what the form needs, saves, then opens the page of the spend.
 * The shell keys it by the spend, so another spend starts from «loading» again. */
export default function ExpensePage({ receiptId }: { receiptId?: number }) {
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [draft, setDraft] = useState<ExpenseDraft | undefined>()
  const [errors, setErrors] = useState<ExpenseErrors>({})
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string>()
  const saveController = useRef<AbortController | undefined>(undefined)

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    void (async () => {
      const categories = getCategories({}, { signal })
      const loaded = receiptId === undefined
        ? Promise.all([categories, getManualDefaults({ signal })])
        : Promise.all([categories, getReceipt(receiptId, { signal }), getReceiptLines(receiptId, { page_size: 200 }, { signal })])
      const [categoryResult, ...rest] = await loaded
      if (signal.aborted) return
      const values = [unwrap(categoryResult), ...rest.map((result) => unwrap(result as LocalApiResult<unknown>))]
      if (values.some((value) => value === undefined)) return
      const failed = values.find(isFailure)
      if (failed) { setLoad({ kind: 'error', message: errorMessage(failed) }); return }
      const [categoryData] = values as [{ results: Category[] }]
      let next: ExpenseDraft
      let frequent: number[] = []
      if (receiptId === undefined) {
        const defaults = values[1] as ManualDefaults
        next = emptyDraft(defaults.currency)
        frequent = defaults.frequent_categories
      } else {
        const receipt = values[1] as Receipt
        if (receipt.source !== 'manual') { setLoad({ kind: 'read-only' }); return }
        next = draftFromReceipt(receipt, (values[2] as { results: Line[] }).results)
      }
      setDraft(next)
      setLoad({ kind: 'ok', data: { draft: next, chips: categoryChips(categoryData.results, frequent) } })
    })()
    return () => controller.abort()
  }, [receiptId, attempt])

  useEffect(() => () => saveController.current?.abort(), [])

  const save = async () => {
    if (!draft || saving) return
    const checked = draftBody(draft)
    if ('errors' in checked) { setErrors(checked.errors); setFailure(undefined); return }
    setErrors({})
    setFailure(undefined)
    setSaving(true)
    const controller = new AbortController()
    saveController.current = controller
    const result = receiptId === undefined
      ? await createManualSpend(checked.body, { signal: controller.signal })
      : await updateManualSpend(receiptId, checked.body, { signal: controller.signal })
    if (controller.signal.aborted || result.kind === 'aborted') return
    setSaving(false)
    if (result.kind === 'ok') {
      setExpenseNotice(result.data.id, receiptId === undefined ? savedNotice : updatedNotice)
      navigate({ kind: 'receipt', receiptId: result.data.id })
      return
    }
    if (result.reason === 'invalid_parameter' && result.fields?.length) setErrors(serverErrors(result.fields))
    setFailure(saveMessage(result))
  }

  if (load.kind === 'loading') return <RequestState kind="loading" message="Загружаем форму…" />
  if (load.kind === 'error') return <RequestState kind="error" message={load.message}
    onRetry={() => { setLoad({ kind: 'loading' }); setAttempt((value) => value + 1) }} />
  if (load.kind === 'read-only') return <RequestState kind="empty" message="Чек с фото не меняется: править можно только трату, внесённую вручную."
    action={<Link className="action-link" to={`/receipts/${receiptId}`}>К чеку</Link>} />
  return <div className="receipts-page expense-page">
    <ExpenseForm draft={draft ?? load.data.draft} chips={load.data.chips} errors={errors} saving={saving} failure={failure}
      receiptId={receiptId} onChange={setDraft} onSubmit={() => { void save() }} />
  </div>
}
