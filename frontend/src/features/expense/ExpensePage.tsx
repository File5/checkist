import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { CSSProperties, FormEvent, RefObject } from 'react'
import { getCategories } from '../../api/catalog'
import { announceIncome, createIncome, getIncome, getIncomeCategories, updateIncome } from '../../api/incomes'
import { createManualSpend, getManualDefaults, getReceipt, getReceiptLines, updateManualSpend } from '../../api/receipts'
import type { Line, ManualDefaults, Receipt } from '../../api/receipts'
import type { Category, LocalApiResult } from '../../api/types'
import RequestState from '../../components/RequestState'
import { usePageTitle } from '../../components/page-header'
import { Link, navigate } from '../../navigation'
import { isNetworkFailure } from '../../offline/pending'
import { clearHandoff, discardPending, draftFromPending, enqueueSpend, peekHandoff } from '../../offline/pending-store'
import { useSession } from '../../session'
import { errorMessage } from '../receipts/state'
import type { Failure } from '../receipts/state'
import { saveMessage } from './labels'
import { draftFromParse } from './parse-text'
import { draftFromSuggestion } from './suggestions'
import TextHint from './TextHint'
import { caretAfter, charsBefore, evaluateAmount, groupDigits, hasOperator, ungrouped } from './amount-calc'
import {
  categoryChips, categoryTree, chipParent, chipToneId, dateChoice, sumText, dayBefore, sentIndexes, draftBody, draftFromReceipt, emptyDraft, fieldScrollDelta,
  linesTotal, filledLines, LINES_MAX, newLine, saveLabel, savedNotice, serverErrors, setExpenseNotice, shortDay, todayISO, updatedNotice, visibleChips,
  draftFromIncome, incomeBody, incomeChip,
} from './expense-form'
import { setIncomeNotice } from '../incomes/incomes-state'
import Sheet from '../../components/Sheet'
import { categoryTone } from '../../lib/category-tone'
import { useNarrow } from '../../lib/cards'
import { currencySymbol } from '../../lib/money'
import { ownerName, personName } from '../../lib/people'
import { DeleteSpend } from './ManualSpendActions'
import type { ExpenseDraft, ExpenseErrors, LineDraft } from './expense-form'
import './Expense.css'

type Loaded = { draft: ExpenseDraft; chips: Category[]; incomeChips: Category[]; byline?: string }
/** «Трата / Доход»: what the form saves. */
export type FormKind = 'spend' | 'income'
type LoadState = { kind: 'loading' } | { kind: 'error'; message: string } | { kind: 'read-only' } | { kind: 'ok'; data: Loaded }

/** The keys of the amount calculator and their names for a screen reader. */
const CALC_KEYS = [['+', 'Плюс'], ['−', 'Минус'], ['×', 'Умножить'], ['÷', 'Разделить']] as const
/** A longer amount («12000+3500») takes a smaller figure: the hero size keeps about this many characters in sight. */
const AMOUNT_HERO_CHARS = 8
/** A name, not a literal: the guard of date fields (theme/date-fields-css.test.ts) counts a literal argument as a field. */
const dateField = 'date'
const errorId = (name: string) => `expense-${name.replaceAll('.', '-')}-error`
const fieldError = (errors: ExpenseErrors, name: string) => errors[name]
  ? <p className="expense-error" id={errorId(name)}>{errors[name]}</p> : null
const describedBy = (errors: ExpenseErrors, name: string) => errors[name] ? errorId(name) : undefined

export type ExpenseFormProps = {
  draft: ExpenseDraft; chips: Category[]; errors: ExpenseErrors; saving: boolean; failure?: string
  /** `undefined` — a new spend; otherwise the spend being changed: the form ends with «Удалить трату». */
  receiptId?: number
  onChange: (draft: ExpenseDraft) => void; onSubmit: () => void
  /** The calendar date of the device, for «Сегодня» and «Вчера». */
  today?: string
  /** Tests: «Все категории» already open. */
  initialSheet?: boolean
  /** «Добавит: Андрей · видна всей семье» under the fields; nothing when unknown. */
  byline?: string
  /** A phone: the deletion asks in a sheet. */
  narrow?: boolean
  /** `income` — the same amount, date and note, the chips of income categories, no place and no positions. */
  kind?: FormKind
  /** The income being changed: the form ends with «Удалить доход». */
  incomeId?: number
}

/** A focused field of the form stays above the save bar and the keyboard of a phone: after the focus and whenever the
 * visible part of the window shrinks (the keyboard opens), the page scrolls just enough. */
function useKeyboardSafeFields(form: RefObject<HTMLFormElement | null>) {
  useEffect(() => {
    const element = form.current
    if (!element || typeof window === 'undefined') return
    const fit = () => {
      const field = document.activeElement
      if (!(field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement) || !element.contains(field)) return
      const viewport = window.visualViewport
      const visible = viewport ? viewport.offsetTop + viewport.height : window.innerHeight
      const bar = element.querySelector('.expense-actions')?.getBoundingClientRect().height ?? 0
      const delta = fieldScrollDelta(field.getBoundingClientRect().bottom, visible, bar)
      if (delta > 0) window.scrollBy({ top: delta })
    }
    let timer: ReturnType<typeof setTimeout> | undefined
    // The keyboard of iOS comes up a moment after the focus.
    const later = () => { clearTimeout(timer); timer = setTimeout(fit, 300) }
    element.addEventListener('focusin', later)
    window.visualViewport?.addEventListener('resize', fit)
    return () => {
      clearTimeout(timer)
      element.removeEventListener('focusin', later)
      window.visualViewport?.removeEventListener('resize', fit)
    }
  }, [form])
}

/** After a refused save the first field with a message gets the focus: on a phone it may be far above the save bar. */
function useFocusFirstError(form: RefObject<HTMLFormElement | null>, errors: ExpenseErrors) {
  useEffect(() => {
    const element = form.current
    const message = element?.querySelector<HTMLElement>('.expense-error')
    if (!element || !message) return
    const owner = element.querySelector<HTMLElement>(`[aria-describedby~="${message.id}"]`)
    const target = owner instanceof HTMLInputElement || owner instanceof HTMLTextAreaElement ? owner : owner?.querySelector<HTMLElement>('button')
    target?.focus()
  }, [form, errors])
}

/** The calendar of «Когда»: a round button over the native date field, which stays the real, labelled control. A mouse
 * gets the picker from `showPicker`; a touch screen opens it by itself. */
function CalendarIcon() {
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false">
    <rect x="3" y="5" width="18" height="16" rx="2" /><path d="M16 3v4M8 3v4M3 10h18" />
  </svg>
}
const openPicker = (input: HTMLInputElement) => {
  if (typeof window === 'undefined' || window.matchMedia?.('(pointer: coarse)').matches) return
  try { input.showPicker?.() } catch { /* not allowed here: the field still takes the keyboard */ }
}

/** The form itself, without loading and saving: the markup tests render it directly. */
export function ExpenseForm({ draft, chips, errors, saving, failure, receiptId, onChange, onSubmit, today = todayISO(), initialSheet = false, byline, narrow = false, kind = 'spend', incomeId }: ExpenseFormProps) {
  const [sheet, setSheet] = useState(initialSheet)
  const [search, setSearch] = useState('')
  const formRef = useRef<HTMLFormElement>(null)
  const added = useRef<number | undefined>(undefined)
  const income = kind === 'income'
  const itemized = filledLines(draft.lines).length > 0
  const sum = linesTotal(draft.lines)
  // Errors name a position by its place among the sent ones: an untouched empty row is not sent.
  const sent = sentIndexes(draft.lines)
  // The short list of income categories is shown whole.
  const shown = income ? chips : visibleChips(chips, draft.category, false)
  const choice = dateChoice(draft.date, today)
  const symbol = currencySymbol(draft.currency)
  // «₸ KZT»: the sign before the code, where the currency has one.
  const signed = symbol !== '' && symbol !== draft.currency
  const set = (patch: Partial<ExpenseDraft>) => onChange({ ...draft, ...patch })
  // The amount is kept without the spaces of grouping; the caret is put back after the same characters.
  const amountInput = useRef<HTMLInputElement>(null)
  const caret = useRef<number | undefined>(undefined)
  const counted = !itemized && hasOperator(draft.amount) ? evaluateAmount(draft.amount) : undefined
  const typeAmount = (value: string, at: number | null) => {
    caret.current = charsBefore(value, at ?? value.length)
    set({ amount: ungrouped(value) })
  }
  const insertOperator = (key: string) => {
    const input = amountInput.current
    const shown = groupDigits(draft.amount)
    const focused = input !== null && document.activeElement === input
    const start = focused ? input.selectionStart ?? shown.length : shown.length
    const end = focused ? input.selectionEnd ?? start : start
    typeAmount(shown.slice(0, start) + key + shown.slice(end), start + key.length)
    input?.focus()
  }
  useLayoutEffect(() => {
    const input = amountInput.current
    if (caret.current === undefined || !input || document.activeElement !== input) return
    const at = caretAfter(input.value, caret.current)
    input.setSelectionRange(at, at)
    caret.current = undefined
  })
  const setLine = (key: number, patch: Partial<LineDraft>) => set({ lines: draft.lines.map((line) => line.key === key ? { ...line, ...patch } : line) })
  const addLine = () => { const line = newLine(); added.current = line.key; set({ lines: [...draft.lines, line] }) }
  const submit = (event: FormEvent) => { event.preventDefault(); onSubmit() }
  useKeyboardSafeFields(formRef)
  useFocusFirstError(formRef, errors)
  // A new position is typed right away.
  useEffect(() => {
    if (added.current === undefined) return
    document.getElementById(`expense-line-${added.current}-name`)?.focus()
    added.current = undefined
  }, [draft.lines])
  return <form ref={formRef} className="expense-form" onSubmit={submit} noValidate aria-busy={saving}>
    <section className="expense-card expense-amount">
      <label htmlFor="expense-amount" className="expense-label">{itemized ? 'Сумма позиций' : 'Сумма'}</label>
      <div className="expense-amount-row">
        <input ref={amountInput} id="expense-amount" className={`expense-amount-input ck-hero-figure${draft.amount.length > AMOUNT_HERO_CHARS ? ' expense-amount-long' : ''}`}
          inputMode="decimal" autoComplete="off" enterKeyHint="done"
          placeholder="0" value={itemized ? (sum === undefined ? '' : sumText(sum)) : groupDigits(draft.amount)} readOnly={itemized} aria-invalid={Boolean(errors.amount)}
          aria-describedby={describedBy(errors, 'amount')} onChange={(event) => typeAmount(event.target.value, event.target.selectionStart)}
          onBlur={() => { if (counted) set({ amount: counted }) }} />
        <label className={`expense-currency${signed ? ' expense-currency-signed' : ''}`}>
          {signed && <span className="expense-currency-sign" aria-hidden="true">{symbol}</span>}
          <span className="expense-visually-hidden">Валюта</span>
          <input value={draft.currency} maxLength={3} autoCapitalize="characters" autoComplete="off" spellCheck={false}
            aria-invalid={Boolean(errors.currency)} aria-describedby={describedBy(errors, 'currency')}
            onChange={(event) => set({ currency: event.target.value.toUpperCase() })} />
        </label>
      </div>
      {itemized && <p className="expense-hint-note">Сумма считается по позициям.</p>}
      {!itemized && draft.amount !== '' && <div className="expense-calc">
        {/* «1200+350» on a phone, whose number keyboard has no «+»: the keys keep the field focused. */}
        <div className="expense-calc-keys" role="group" aria-label="Посчитать сумму">
          {CALC_KEYS.map(([key, label]) => <button key={key} type="button" className="expense-calc-key" aria-label={label}
            onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()}
            onClick={() => insertOperator(key)}>{key}</button>)}
        </div>
        {counted && <output className="expense-calc-result" htmlFor="expense-amount">= {sumText(counted)}</output>}
      </div>}
      {fieldError(errors, 'amount')}
      {fieldError(errors, 'currency')}
    </section>

    <fieldset className="expense-card expense-categories" aria-describedby={describedBy(errors, 'category')}>
      <legend className="expense-label">Категория{itemized && ' позиций без своей'}</legend>
      {chips.length > 0 && <div className="expense-chips">
        {shown.map((category) => <button type="button" key={category.id} className="expense-chip"
          aria-pressed={draft.category === category.id} title={category.path.map((step) => step.name).join(' › ') || category.name}
          onClick={() => set({ category: draft.category === category.id && itemized ? null : category.id })}>
          <span className="expense-dot" style={{ '--expense-tone': `var(--ck-cat-${categoryTone(chipToneId(category))})` } as CSSProperties} aria-hidden="true" />
          {chipParent(category) && <span className="expense-visually-hidden">{chipParent(category)} › </span>}
          <span className="expense-chip-name">{category.name}</span>
        </button>)}
        {!income && <button type="button" className="expense-chip expense-more" aria-haspopup="dialog" aria-expanded={sheet}
          onClick={() => setSheet(true)}>Все категории…</button>}
      </div>}
      {!chips.length && <p className="expense-hint-note">Категорий пока нет: их заводят в каталоге.</p>}
      {fieldError(errors, 'category')}
    </fieldset>
    <Sheet open={sheet} onClose={() => setSheet(false)} title="Все категории">
      <div className="expense-search">
        <label htmlFor="expense-category-search">Найти категорию</label>
        <input id="expense-category-search" type="search" autoComplete="off" value={search} onChange={(event) => setSearch(event.target.value)} />
      </div>
      {(() => {
        const rows = categoryTree(chips, search)
        return rows.length ? <ul className="expense-tree" aria-label="Категории">{rows.map(({ category, depth, label }) => <li key={category.id}
          style={{ '--expense-depth': depth } as CSSProperties}>
          <button type="button" className="expense-tree-item" aria-pressed={draft.category === category.id}
            onClick={() => { set({ category: category.id }); setSheet(false) }}>
            <span className="expense-dot" style={{ '--expense-tone': `var(--ck-cat-${categoryTone(chipToneId(category))})` } as CSSProperties} aria-hidden="true" />
            {label}
          </button>
        </li>)}</ul> : <p className="expense-hint-note" role="status">Ничего не нашлось.</p>
      })()}
    </Sheet>

    <section className="expense-card expense-details">
      <div className="expense-row-block">
        <div className="expense-row" role="group" aria-labelledby="expense-when-label" aria-describedby={describedBy(errors, dateField)}>
          <span id="expense-when-label" className="expense-row-label">Когда</span>
          <div className="expense-when">
            <button type="button" className="expense-chip expense-day" aria-pressed={choice === 'today'} onClick={() => set({ date: today })}>Сегодня</button>
            <button type="button" className="expense-chip expense-day" aria-pressed={choice === 'yesterday'} onClick={() => set({ date: dayBefore(today) })}>Вчера</button>
            <label className={`expense-date-pick${choice === 'other' ? ' expense-date-pick-chosen' : ''}`}>
              <CalendarIcon />
              {choice === 'other' && /^\d{4}-\d{2}-\d{2}$/.test(draft.date) && <time dateTime={draft.date}>{shortDay(draft.date, today)}</time>}
              <span className="expense-visually-hidden">Дата покупки</span>
              <input id="expense-date" type="date" value={draft.date} aria-invalid={Boolean(errors.date)} aria-describedby={describedBy(errors, dateField)}
                onClick={(event) => openPicker(event.currentTarget)} onChange={(event) => set({ date: event.target.value })} />
            </label>
          </div>
        </div>
        {fieldError(errors, dateField)}
      </div>
      {!income && <div className="expense-row-block">
        <label className="expense-row" htmlFor="expense-place">
          <span className="expense-row-label">Где</span>
          <input id="expense-place" className="expense-row-input" autoComplete="off" value={draft.place} placeholder="Без места" aria-invalid={Boolean(errors.place)}
            aria-describedby={describedBy(errors, 'place')} onChange={(event) => set({ place: event.target.value })} />
        </label>
        {fieldError(errors, 'place')}
      </div>}
      <div className="expense-row-block">
        <label className="expense-row" htmlFor="expense-note">
          <span className="expense-row-label">Комментарий</span>
          <textarea id="expense-note" className="expense-row-input" rows={1} value={draft.note} placeholder="Необязательно" aria-invalid={Boolean(errors.note)}
            aria-describedby={describedBy(errors, 'note')} onChange={(event) => set({ note: event.target.value })} />
        </label>
        {fieldError(errors, 'note')}
      </div>
      {!income && <div className="expense-row-block expense-lines" role="group" aria-labelledby="expense-lines-heading">
        <div className="expense-row">
          <span id="expense-lines-heading" className="expense-row-label">Позиции</span>
          {draft.lines.length < LINES_MAX && <button type="button" className="expense-add-line" onClick={addLine}>
            <span aria-hidden="true">+</span> Добавить<span className="expense-visually-hidden"> позицию</span></button>}
        </div>
        {draft.lines.length > 0 && <ol className="expense-line-list">{draft.lines.map((line, index) => <li key={line.key} className="expense-line">
          <div className="expense-line-fields">
            <label className="expense-visually-hidden" htmlFor={`expense-line-${line.key}-name`}>Позиция {index + 1}</label>
            <input id={`expense-line-${line.key}-name`} className="expense-line-name" autoComplete="off" placeholder="Название" value={line.name}
              aria-invalid={Boolean(errors[`lines.${sent[index]}.name`])} aria-describedby={describedBy(errors, `lines.${sent[index]}.name`)}
              onChange={(event) => setLine(line.key, { name: event.target.value })} />
            <label className="expense-visually-hidden" htmlFor={`expense-line-${line.key}-amount`}>Сумма позиции {index + 1}</label>
            <input id={`expense-line-${line.key}-amount`} className="expense-line-amount" inputMode="decimal" autoComplete="off" placeholder="0" value={line.amount}
              aria-invalid={Boolean(errors[`lines.${sent[index]}.amount`])} aria-describedby={describedBy(errors, `lines.${sent[index]}.amount`)}
              onChange={(event) => setLine(line.key, { amount: event.target.value })} />
            <button type="button" className="expense-line-remove" aria-label={`Убрать позицию ${index + 1}`}
              onClick={() => set({ lines: draft.lines.filter((other) => other.key !== line.key) })}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true" focusable="false"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
          </div>
          {fieldError(errors, `lines.${sent[index]}.name`)}
          {fieldError(errors, `lines.${sent[index]}.amount`)}
        </li>)}</ol>}
        {fieldError(errors, 'lines')}
      </div>}
    </section>

    {byline && <p className="expense-byline">{byline}</p>}
    {receiptId !== undefined && <DeleteSpend receiptId={receiptId} narrow={narrow} />}
    {incomeId !== undefined && <DeleteSpend receiptId={incomeId} narrow={narrow} income />}

    <div className="expense-actions ck-action-bar">
      {failure && <p className="expense-failure" role="alert">{failure}</p>}
      {errors.form && <p className="expense-failure" role="alert">{errors.form}</p>}
      <button type="submit" className="expense-save" disabled={saving}>{saving ? 'Сохраняем…' : saveLabel(draft)}</button>
    </div>
  </form>
}

function unwrap<T>(result: LocalApiResult<T>): T | Failure | undefined {
  if (result.kind === 'ok') return result.data
  return result.kind === 'error' ? result : undefined
}
const isFailure = (value: unknown): value is Failure => typeof value === 'object' && value !== null && (value as Failure).kind === 'error'

/** `/receipts/new` and `/receipts/{id}/edit`: loads what the form needs, saves, then opens the page of the spend.
 * The shell keys it by the spend, so another spend starts from «loading» again. A new form switches «Трата / Доход»
 * (`income` — it opens on «Доход»); `/incomes/{id}/edit` (`incomeId`) changes an income and goes back to «Доходы». */
export default function ExpensePage({ receiptId, repeat, income = false, incomeId }: { receiptId?: number; repeat?: number; income?: boolean; incomeId?: number }) {
  const isNew = receiptId === undefined && incomeId === undefined
  const [kind, setKind] = useState<FormKind>(income || incomeId !== undefined ? 'income' : 'spend')
  usePageTitle(isNew ? (kind === 'income' ? 'Новый доход' : 'Новая трата') : undefined)
  const [load, setLoad] = useState<LoadState>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)
  const [draft, setDraft] = useState<ExpenseDraft | undefined>()
  const [errors, setErrors] = useState<ExpenseErrors>({})
  const [saving, setSaving] = useState(false)
  const [failure, setFailure] = useState<string>()
  const saveController = useRef<AbortController | undefined>(undefined)
  // «Исправить» of a spend waiting on the phone: the form starts from it and replaces it once saved.
  const [handed] = useState(() => isNew ? peekHandoff() : undefined)
  const session = useSession()
  const owner = session.kind === 'user' ? session.user.username : undefined
  const family = session.kind === 'user' && session.household !== null
  const narrow = useNarrow()
  useEffect(() => () => clearHandoff(), [])

  useEffect(() => {
    const controller = new AbortController()
    const { signal } = controller
    void (async () => {
      if (incomeId !== undefined) {
        const found = await Promise.all([getIncomeCategories({ signal }), getIncome(incomeId, { signal })])
        if (signal.aborted) return
        const failed = found.find(isFailure)
        if (failed) { setLoad({ kind: 'error', message: errorMessage(failed) }); return }
        const [categoryList, saved] = found
        if (categoryList.kind !== 'ok' || saved.kind !== 'ok') return
        const next = draftFromIncome(saved.data)
        setDraft(next)
        setLoad({ kind: 'ok', data: { draft: next, chips: [], incomeChips: categoryList.data.map(incomeChip),
          byline: `Внёс: ${saved.data.owner_name} · запись видят автор и главный в семье` } })
        return
      }
      // The categories of incomes for «Трата / Доход» of a new form; without them the form stays a spend form.
      const incomeCategories = receiptId === undefined ? getIncomeCategories({ signal }) : undefined
      const categories = getCategories({}, { signal })
      // «Повторить» (`?repeat=`): the spend to copy is read like the one to change; if it cannot be read, the form is empty.
      const source = receiptId ?? (handed ? undefined : repeat)
      const copied = source === undefined ? undefined
        : Promise.all([getReceipt(source, { signal }), getReceiptLines(source, { page_size: 200 }, { signal })])
      const loaded = receiptId === undefined
        ? Promise.all([categories, getManualDefaults({ signal })])
        : Promise.all([categories, getReceipt(receiptId, { signal }), getReceiptLines(receiptId, { page_size: 200 }, { signal })])
      const [categoryResult, ...rest] = await loaded
      const [copiedReceipt, copiedLines] = receiptId === undefined && copied ? await copied : []
      const incomeResult = incomeCategories ? await incomeCategories : undefined
      if (signal.aborted) return
      const values = [unwrap(categoryResult), ...rest.map((result) => unwrap(result as LocalApiResult<unknown>))]
      if (values.some((value) => value === undefined)) return
      const failed = values.find(isFailure)
      if (failed) { setLoad({ kind: 'error', message: errorMessage(failed) }); return }
      const [categoryData] = values as [{ results: Category[] }]
      let next: ExpenseDraft
      let frequent: number[] = []
      let byline: string | undefined
      if (receiptId === undefined) {
        const defaults = values[1] as ManualDefaults
        next = handed ? draftFromPending(handed.body, categoryData.results) : emptyDraft(defaults.currency)
        if (copiedReceipt?.kind === 'ok' && copiedLines?.kind === 'ok' && copiedReceipt.data.source === 'manual') {
          next = { ...draftFromReceipt(copiedReceipt.data, copiedLines.data.results), date: todayISO() }
        }
        frequent = defaults.frequent_categories
      } else {
        const receipt = values[1] as Receipt
        if (receipt.source !== 'manual') { setLoad({ kind: 'read-only' }); return }
        next = draftFromReceipt(receipt, (values[2] as { results: Line[] }).results)
        byline = `Добавил: ${ownerName(receipt)} · ${receipt.hidden ? 'скрыта от семьи' : 'видна всей семье'}`
      }
      setDraft(next)
      setLoad({ kind: 'ok', data: { draft: next, chips: categoryChips(categoryData.results, frequent),
        incomeChips: incomeResult?.kind === 'ok' ? incomeResult.data.map(incomeChip) : [], byline } })
    })()
    return () => controller.abort()
  }, [receiptId, incomeId, repeat, attempt, handed])

  useEffect(() => () => saveController.current?.abort(), [])

  const saveIncome = async (current: ExpenseDraft) => {
    const checked = incomeBody(current)
    if ('errors' in checked) { setErrors(checked.errors); setFailure(undefined); return }
    setErrors({})
    setFailure(undefined)
    setSaving(true)
    const controller = new AbortController()
    saveController.current = controller
    const result = incomeId === undefined
      ? await createIncome(checked.body, { signal: controller.signal })
      : await updateIncome(incomeId, checked.body, { signal: controller.signal })
    if (controller.signal.aborted || result.kind === 'aborted') return
    setSaving(false)
    if (result.kind === 'ok') {
      announceIncome()
      setIncomeNotice(incomeId === undefined ? 'Доход сохранён.' : updatedNotice)
      navigate({ kind: 'incomes', month: result.data.received_on.slice(0, 7) })
      return
    }
    if (result.reason === 'invalid_parameter' && result.fields?.length) setErrors(serverErrors(result.fields))
    setFailure(saveMessage(result))
  }

  const save = async () => {
    if (!draft || saving) return
    if (kind === 'income') { await saveIncome(draft); return }
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
    if (receiptId === undefined && owner !== undefined && isNetworkFailure(result)) {
      // No network: the spend waits on the phone and is sent from «Чеки» (src/offline).
      await enqueueSpend(checked.body, owner)
      if (handed) await discardPending(handed.id)
      navigate('/receipts')
      return
    }
    setSaving(false)
    if (result.kind === 'ok') {
      if (handed) await discardPending(handed.id)
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
  const { chips: spendChips, incomeChips } = load.data
  const chips = kind === 'income' ? incomeChips : spendChips
  const me = session.kind === 'user' ? personName(session.user.username, session.user.display_name) : undefined
  // Who adds the spend, said only in a family: a person alone adds everything themselves. An income is private.
  const byline = !family ? undefined : !isNew || me === undefined ? load.data.byline
    : kind === 'income' ? `Внесёт: ${me} · запись видят вы и главный в семье` : `Добавит: ${me} · видна всей семье`
  // «Трата / Доход»: the amount, the date and the note stay; the category belongs to its own list.
  const switchKind = (next: FormKind) => {
    if (next === kind) return
    setKind(next)
    setDraft((before) => before && { ...before, category: null, ...(next === 'income' && { place: '', lines: [] }) })
    setErrors({})
    setFailure(undefined)
  }
  const fill = (next: FormKind, filled: ExpenseDraft) => { setKind(next); setDraft(filled); setErrors({}); setFailure(undefined) }
  return <div className="expense-page">
    {isNew && incomeChips.length > 0 && <div className="expense-kind" role="group" aria-label="Что вносим">
      <button type="button" aria-pressed={kind === 'spend'} onClick={() => switchKind('spend')}>Трата</button>
      <button type="button" aria-pressed={kind === 'income'} onClick={() => switchKind('income')}>Доход</button>
    </div>}
    {isNew && <TextHint income={kind === 'income'} onFill={(parsed) => parsed.kind === 'income' ? fill('income', draftFromParse(parsed, incomeChips)) : fill('spend', draftFromParse(parsed, spendChips))}
      onRepeat={(spend) => fill('spend', draftFromSuggestion(spend, spendChips, todayISO()))} />}
    <ExpenseForm kind={kind} draft={draft ?? load.data.draft} chips={chips} errors={errors} saving={saving} failure={failure}
      receiptId={receiptId} incomeId={incomeId} onChange={setDraft} onSubmit={() => { void save() }} byline={byline} narrow={narrow} />
  </div>
}
