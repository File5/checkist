import { Fragment, useId, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import type { RecurringMonthPayment, RecurringPayInput } from '../../api/recurring'
import Icon from '../../components/Icon'
import MethodChips from '../../components/MethodChips'
import { formatMoney } from '../../lib/money'
import { lastMethod } from '../../lib/payment-methods'
import { Link } from '../../navigation'
import type { PaymentMethodValue } from '../../lib/payment-methods'
import { monthTitle } from '../dashboard/dashboard-state'
import { evaluateAmount, groupDigits, hasOperator, ungrouped } from '../expense/amount-calc'
import { amountText, normalizeAmount, sumText } from '../expense/expense-form'
import { isOpen, methodName, payExpected, yearMonthText } from './recurring-state'
// The keys of the calculator look as in the form of a spend.
import '../expense/Expense.css'
import './Recurring.css'

/** A field as a row of the sheet: the words on the left, the control on the right; its error under the row. */
export function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: ReactNode }) {
  return <div className="rec-field-wrap">
    <label className="rec-field" htmlFor={id}><span>{label}</span>{children}</label>
    {error && <p className="rec-field-error" id={`${id}-error`}>{error}</p>}
  </div>
}

const CALC_KEYS = [['+', 'Плюс'], ['−', 'Минус'], ['×', 'Умножить'], ['÷', 'Разделить']] as const

export type PayValues = Omit<RecurringPayInput, 'month'>
/** «Оплатил» of the month shown: the server makes the spend and closes the month. */
export type Pay = (row: RecurringMonthPayment, values: PayValues) => void

/** «Оплатил»: the amount (the expected one; «1200+350» is counted like in the form of a spend), the way of payment (the
 * last chosen on this device) and the day (today). */
export function PayForm({ row, today, busy, failure = null, onSubmit, onCancel }: {
  row: RecurringMonthPayment; today: string; busy: boolean; failure?: string | null
  onSubmit: (values: PayValues) => void; onCancel: () => void
}) {
  const id = useId()
  const [amount, setAmount] = useState(() => amountText(row.amount))
  const [method, setMethod] = useState<PaymentMethodValue>(() => lastMethod())
  const [day, setDay] = useState(today)
  const [error, setError] = useState<{ field: 'amount' | 'day'; text: string } | null>(null)
  const value = normalizeAmount(amount)
  const counted = hasOperator(amount) ? evaluateAmount(amount) : undefined
  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    if (value === undefined) setError({ field: 'amount', text: 'Введите сумму больше нуля.' })
    else if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || day > today) setError({ field: 'day', text: 'Укажите день оплаты, не позже сегодня.' })
    else {
      setError(null)
      onSubmit({ amount: value, payment_method: method, purchased_on: day })
    }
  }
  return <form className="rec-form rec-pay-form" onSubmit={submit} noValidate>
    <div className="rec-fields">
      <div className="rec-field-wrap">
        <label className="rec-field" htmlFor={`${id}-amount`}><span>Сумма, {row.currency}</span>
          <input id={`${id}-amount`} className="ck-figures" inputMode="decimal" autoComplete="off" enterKeyHint="done" placeholder="0"
            value={groupDigits(amount)} aria-invalid={error?.field === 'amount'} aria-describedby={error?.field === 'amount' ? `${id}-error` : undefined}
            onChange={(event) => setAmount(ungrouped(event.target.value))} onBlur={() => { if (counted) setAmount(counted) }} />
        </label>
        {amount !== '' && <div className="rec-pay-calc">
          {/* «220000+1500» on a phone, whose number keyboard has no «+»: the keys keep the field focused. */}
          <div className="expense-calc-keys" role="group" aria-label="Посчитать сумму">
            {CALC_KEYS.map(([key, label]) => <button key={key} type="button" className="expense-calc-key" aria-label={label}
              onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()}
              onClick={() => setAmount((before) => before + key)}>{key}</button>)}
          </div>
          {counted && <output className="expense-calc-result" htmlFor={`${id}-amount`}>= {sumText(counted)}</output>}
        </div>}
      </div>
      <Field id={`${id}-day`} label="Дата">
        <input id={`${id}-day`} type="date" value={day} max={today} aria-invalid={error?.field === 'day'}
          aria-describedby={error?.field === 'day' ? `${id}-error` : undefined} onChange={(event) => setDay(event.target.value)} />
      </Field>
    </div>
    <div className="rec-pay-method">
      <span id={`${id}-method`} className="rec-pay-label">Способ оплаты</span>
      <MethodChips value={method} onChange={setMethod} labelledBy={`${id}-method`} />
    </div>
    {error && <p className="rec-field-error" id={`${id}-error`} role="alert">{error.text}</p>}
    {failure && <p className="rec-field-error" role="alert">{failure}</p>}
    <button type="submit" className="rec-save" aria-disabled={busy || undefined}>Сохранить · {formatMoney(value ?? row.amount, row.currency)}</button>
    <button type="button" className="ck-button-secondary" onClick={onCancel}>Отмена</button>
  </form>
}

/** «Как и сколько оплатил»: twelve months up to this one — the total and the ways of payment, then a row a month,
 * newest first (the months before the payment began are left out). Nothing for a regular income or a switched off one. */
export function PaymentYear({ row, today }: { row: RecurringMonthPayment; today: string }) {
  const id = useId()
  const months = row.year?.months.filter((item) => item.state !== 'before') ?? []
  if (!row.year || row.kind === 'income' || !months.length) return null
  const { total, methods } = row.year
  return <section className="rec-year" aria-labelledby={`${id}-heading`}>
    <h3 id={`${id}-heading`}>История оплат</h3>
    <p className="rec-year-total">{total === null ? 'За год оплат не нашёл'
      : <>За год оплачено <span className="ck-figures rec-sum-value">{formatMoney(total, row.currency)}</span></>}</p>
    {methods.length > 0 && <p className="rec-year-methods">{methods.map((item, index) => <Fragment key={item.payment_method}>
      {index > 0 && ' · '}<span className="rec-year-method">{methodName(item.payment_method)} <span className="ck-figures">
        {formatMoney(item.total, row.currency)}</span></span></Fragment>)}</p>}
    <ul className="ck-list rec-year-list">{months.map((item) => {
      const body = <>
        <span className="ck-row-main">
          <span className="ck-row-title">{monthTitle(item.month)}</span>
          <span className={`ck-row-meta rec-meta-${item.state}`}>{yearMonthText(item, today)}</span>
        </span>
        <span className="ck-row-amount ck-figures">{item.paid ? formatMoney(item.paid.total, row.currency) : '—'}</span>
      </>
      const receipt = item.paid?.receipt_id
      // The spend of a month opens from here: a manual one straight on its form (the way of payment, the amount), a receipt
      // with a photo on its page.
      return receipt ? <li key={item.month}>
        <Link className="ck-row rec-year-row rec-year-link" to={item.paid?.source === 'manual' ? `/receipts/${receipt}/edit` : `/receipts/${receipt}`}>
          {body}<Icon name="forward" size={18} className="ck-icon rec-year-go" /></Link>
      </li> : <li key={item.month} className="ck-row rec-year-row">{body}</li>
    })}</ul>
  </section>
}

/** The top of the sheet of a payment: «Оплатил» while the month is open (it opens the small form in place), the history
 * of a year, then the heading of the fields of the payment under it. */
export function PaySection({ row, month, today, busy, failure, onPay }: {
  row: RecurringMonthPayment; month: string; today: string; busy: boolean; failure?: string | null; onPay: Pay
}) {
  const [open, setOpen] = useState(false)
  if (row.kind === 'income') return null
  const payable = isOpen(row) && month <= today.slice(0, 7)
  return <div className="rec-pay">
    {payable && (open
      ? <PayForm row={row} today={today} busy={busy} failure={failure} onSubmit={(values) => onPay(row, values)} onCancel={() => setOpen(false)} />
      : <>
        <button type="button" className="rec-pay-main" onClick={() => setOpen(true)}>Оплатил</button>
        <p className="rec-note">{payExpected(row, today)}</p>
      </>)}
    <PaymentYear row={row} today={today} />
    <h3 className="rec-pay-heading">Изменить платёж</h3>
  </div>
}
