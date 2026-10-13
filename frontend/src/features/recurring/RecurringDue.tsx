import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { announceIncome, createIncome } from '../../api/incomes'
import { decideRecurring, getRecurringMonth } from '../../api/recurring'
import type { RecurringDecisionKind, RecurringMonth, RecurringMonthPayment, RecurringQuestion } from '../../api/recurring'
import { formatMoney } from '../../lib/money'
import { Link } from '../../navigation'
import { capitalize, dayAndMonth, inMonth } from '../dashboard/dashboard-state'
import { amountValue, counted, decisionNotice, forMonth, foundText, incomeDue, isOpen, paymentsText, recurringFailure, stateText } from './recurring-state'
import type { Notice } from './recurring-state'
import '../incomes/Incomes.css'
import './Recurring.css'

export type Decide = (question: RecurringQuestion, decision: RecurringDecisionKind) => void
/** «Внести» of a regular income: the amount as typed in its field (the expected one unless corrected). */
export type AddIncome = (row: RecurringMonthPayment, amount: string) => void

/** One regular income of the month: «Зарплата 650 000 ₸ — внести?»; one tap enters it, the field corrects the amount. */
function IncomeDueItem({ row, busy, onAdd }: { row: RecurringMonthPayment; busy: boolean; onAdd: AddIncome }) {
  const [amount, setAmount] = useState(row.amount.replace(/\.00$/, ''))
  const valid = amountValue(amount) !== null
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!busy && valid) onAdd(row, amountValue(amount) as string)
  }
  return <li className="inc-due-row">
    <span className="inc-due-name">{row.name} {formatMoney(row.amount, row.currency)} — внести?</span>
    <span className="ck-row-meta">{dayAndMonth(row.due_date)}</span>
    <form className="inc-due-form" onSubmit={submit} noValidate>
      <input inputMode="decimal" autoComplete="off" value={amount} aria-label={`Сумма «${row.name}», ${row.currency}`} aria-invalid={!valid}
        onChange={(event) => setAmount(event.target.value)} />
      <button type="submit" aria-disabled={busy || !valid || undefined}>Внести</button>
    </form>
  </li>
}

export function IncomeDueCard({ rows, busy, onAdd }: { rows: RecurringMonthPayment[]; busy: boolean; onAdd: AddIncome }) {
  if (!rows.length) return null
  return <section className="ck-panel rec-card" aria-labelledby="inc-due-heading">
    <div className="ck-panel-head"><h2 id="inc-due-heading">Регулярный доход</h2></div>
    <ul className="ck-list">{rows.map((row) => <IncomeDueItem key={row.id} row={row} busy={busy} onAdd={onAdd} />)}</ul>
  </section>
}

/** The day of the due date in a badge; the colour says paid / open / overdue, the words of the row say it too. */
export function DueBadge({ row }: { row: Pick<RecurringMonthPayment, 'due_date' | 'state'> }) {
  return <span className={`ck-row-badge rec-day rec-day-${row.state}`} aria-hidden="true">{Number(row.due_date.slice(8, 10))}</span>
}

/** One payment of the month: the day, the name, its state in words and the amount (paid — what was paid). */
export function PaymentRow({ row, today }: { row: RecurringMonthPayment; today: string }) {
  return <li className="ck-row rec-row">
    <DueBadge row={row} />
    <span className="ck-row-main">
      <span className="ck-row-title">{row.name}</span>
      <span className={`ck-row-meta rec-meta-${row.state}`}>{stateText(row, today)}</span>
    </span>
    <span className="ck-row-amount ck-figures">{formatMoney(row.paid?.total ?? row.amount, row.currency)}</span>
  </li>
}

/** «За сентябрь не нашёл оплату»: one card for the open payments of the month before, three answers each.
 * The app never adds anything by itself: only «Добавить по средней» makes a spend. */
export function QuestionsCard({ questions, today, busy, onDecide }: { questions: RecurringQuestion[]; today: string; busy: boolean; onDecide: Decide }) {
  if (!questions.length) return null
  const month = questions[0].month
  return <section className="ck-panel rec-card rec-ask" aria-labelledby="rec-ask-heading">
    <div className="ck-panel-head"><h2 id="rec-ask-heading">{capitalize(forMonth(month, today))} не нашёл оплату</h2></div>
    <p className="rec-note">Сам ничего не добавлю — ответьте по каждому платежу.</p>
    <ul className="rec-ask-list">
      {questions.map((question) => <li key={`${question.payment_id}:${question.month}`} className="rec-ask-item">
        <div className="rec-ask-head">
          <span className="rec-ask-name">{question.name}</span>
          <span className="rec-ask-meta">срок {dayAndMonth(question.due_date)}</span>
        </div>
        <button type="button" className="rec-ask-add" aria-disabled={busy || undefined} onClick={busy ? undefined : () => onDecide(question, 'added')}>
          {question.from_history ? 'Добавить по средней' : 'Добавить'} <span className="ck-figures">{formatMoney(question.amount, question.currency)}</span>
        </button>
        <div className="rec-ask-other">
          <button type="button" className="ck-button-secondary" aria-disabled={busy || undefined} onClick={busy ? undefined : () => onDecide(question, 'skipped')}>Не было</button>
          <button type="button" className="ck-button-secondary" aria-disabled={busy || undefined} onClick={busy ? undefined : () => onDecide(question, 'elsewhere')}>Оплачено иначе</button>
        </div>
      </li>)}
    </ul>
  </section>
}

export function NoticeLine({ notice }: { notice: Notice | null }) {
  if (!notice) return null
  return <p className="rec-notice" role="status">{notice.text}
    {notice.receiptId ? <> <Link className="rec-inline-link" to={`/receipts/${notice.receiptId}`}>Открыть трату</Link></> : null}</p>
}

export type RecurringDueViewProps = { data: RecurringMonth; busy?: boolean; notice?: Notice | null; onDecide?: Decide; onAddIncome?: AddIncome }

/** The block of «Главная» without loading: the markup tests render it directly. Nothing without payments and
 * suggestions; only a quiet line with suggestions alone. A regular income of the month asks to be entered on top. */
export function RecurringDueView({ data, busy = false, notice = null, onDecide = () => {}, onAddIncome = () => {} }: RecurringDueViewProps) {
  const rows = counted(data)
  const open = rows.filter(isOpen)
  const closed = rows.filter((row) => !isOpen(row))
  const incomes = incomeDue(data)
  const hint = data.suggestions.length > 0 && <Link className="rec-hint-link" to="/recurring">{foundText(data.suggestions.length)} — посмотреть</Link>
  if (!rows.length && !data.questions.length) {
    return <>
      <IncomeDueCard rows={incomes} busy={busy} onAdd={onAddIncome} />
      <NoticeLine notice={notice} />
      {hint ? <p className="ck-panel rec-card rec-hint">{hint}</p> : null}
    </>
  }
  const past = data.month < data.today.slice(0, 7)
  const heading = open.length ? (past ? `Не оплачено ${inMonth(data.month)}` : 'Осталось оплатить') : 'Регулярные платежи'
  const left = data.totals.filter((total) => total.left !== null)
  return <>
    <IncomeDueCard rows={incomes} busy={busy} onAdd={onAddIncome} />
    <QuestionsCard questions={data.questions} today={data.today} busy={busy} onDecide={onDecide} />
    <NoticeLine notice={notice} />
    {rows.length > 0 && <section className="ck-panel rec-card rec-due" aria-labelledby="rec-due-heading">
      <div className="ck-panel-head">
        <h2 id="rec-due-heading">{heading}</h2>
        <Link className="rec-card-link" to="/recurring">Все</Link>
      </div>
      {open.length > 0
        ? <>
          {left.length > 0 && <p className="rec-sum">{paymentsText(open.length)} · {left.map((total, index) => <span key={total.currency}>
            {index > 0 && ' + '}<span className="ck-figures rec-sum-value">{formatMoney(total.left, total.currency)}</span></span>)}</p>}
          <ul className="ck-list rec-list">{open.map((row) => <PaymentRow key={row.id} row={row} today={data.today} />)}</ul>
        </>
        : <p className="rec-all-paid">Всё оплачено</p>}
      {closed.length > 0 && <details className="rec-closed">
        <summary>Оплачено {closed.length} из {rows.length}</summary>
        <ul className="ck-list rec-list">{closed.map((row) => <PaymentRow key={row.id} row={row} today={data.today} />)}</ul>
      </details>}
      {hint && <p className="rec-more">{hint}</p>}
    </section>}
  </>
}

/** «Осталось оплатить» on «Главная» for the month shown there; it loads by itself, so the dashboard stays as it was.
 * From the 1st of a month it also asks about the payments of the month before that were not found. */
export default function RecurringDue({ month }: { month: string }) {
  const [loaded, setLoaded] = useState<{ month: string; data: RecurringMonth } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<Notice | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    void getRecurringMonth(month, { signal: controller.signal }).then((result) => {
      if (result.kind === 'ok') setLoaded({ month, data: result.data })
    })
    return () => controller.abort()
  }, [month, attempt])
  const decide: Decide = (question, decision) => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    void decideRecurring(question.payment_id, question.month, decision).then((result) => {
      setBusy(false)
      if (result.kind === 'ok') setNotice(decisionNotice(question, decision, result.data.receipt_id, loaded?.data.today ?? question.month))
      else if (result.kind === 'error') setNotice({ text: recurringFailure(result) })
      setAttempt((value) => value + 1)
    })
  }
  const addIncome: AddIncome = (row, amount) => {
    if (busy) return
    setBusy(true)
    setNotice(null)
    void createIncome({ amount, currency: row.currency, category: row.category.id, note: row.name }).then((result) => {
      setBusy(false)
      if (result.kind === 'ok') {
        announceIncome()
        setNotice({ text: `Внёс доход «${row.name}» — ${formatMoney(result.data.amount, result.data.currency)}.` })
      } else if (result.kind === 'error') setNotice({ text: recurringFailure(result) })
      setAttempt((value) => value + 1)
    })
  }
  // Another month on «Главная»: the block of the month before goes away until its own answer comes.
  if (!loaded || loaded.month !== month) return null
  return <RecurringDueView data={loaded.data} busy={busy} notice={notice} onDecide={decide} onAddIncome={addIncome} />
}
