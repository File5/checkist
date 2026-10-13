import { useEffect, useRef, useState } from 'react'
import { deleteIncome } from '../../api/incomes'
import { deleteManualSpend } from '../../api/receipts'
import { Link, navigate } from '../../navigation'
import { setIncomeNotice } from '../incomes/incomes-state'
import { setReceiptsNotice } from '../receipts/delete-receipt'
import { saveMessage } from './labels'
import Sheet from '../../components/Sheet'
import './Expense.css'

export type DeleteStep = { kind: 'idle' } | { kind: 'confirm' } | { kind: 'deleting' } | { kind: 'failed'; message: string }

/** What is deleted: a spend (back to «Траты») or an income (back to «Доходы»). */
const SPEND = { remove: deleteManualSpend, notice: setReceiptsNotice, to: '/receipts', question: 'Удалить эту трату?',
  button: 'Удалить трату', title: 'Удалить трату?', done: 'Трата удалена.', gone: 'Трата уже удалена.' }
const INCOME = { remove: deleteIncome, notice: setIncomeNotice, to: '/incomes', question: 'Удалить этот доход?',
  button: 'Удалить доход', title: 'Удалить доход?', done: 'Доход удалён.', gone: 'Доход уже удалён.' }

/** The deletion of a manual spend: the step, the inline question and the request. Both the page of the spend
 * («Удалить») and its edit form («Удалить трату») ask the same way; an income — the same, with its words. */
function useSpendDeletion(receiptId: number, initial: DeleteStep, what = SPEND) {
  const [step, setStep] = useState<DeleteStep>(initial)
  const controller = useRef<AbortController | undefined>(undefined)
  const confirmButton = useRef<HTMLButtonElement>(null)
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => { if (step.kind === 'confirm') confirmButton.current?.focus() }, [step.kind])

  const remove = async () => {
    setStep({ kind: 'deleting' })
    const current = new AbortController()
    controller.current = current
    const result = await what.remove(receiptId, { signal: current.signal })
    if (current.signal.aborted || result.kind === 'aborted') return
    if (result.kind === 'ok' || result.reason === 'not_found') {
      what.notice(result.kind === 'ok' ? what.done : what.gone)
      navigate(what.to)
      return
    }
    setStep({ kind: 'failed', message: saveMessage(result) })
  }

  const asking = step.kind === 'confirm' || step.kind === 'deleting'
  const confirm = <div className="expense-confirm" role="group" aria-labelledby={`expense-confirm-${receiptId}`}>
    <p id={`expense-confirm-${receiptId}`}>{what.question} Отменить удаление нельзя.</p>
    <div className="receipt-actions">
      <button ref={confirmButton} type="button" className="expense-danger" disabled={step.kind === 'deleting'} onClick={() => { void remove() }}>
        {step.kind === 'deleting' ? 'Удаляем…' : what.button}</button>
      <button type="button" className="receipt-secondary" disabled={step.kind === 'deleting'} onClick={() => setStep({ kind: 'idle' })}>Отмена</button>
    </div>
  </div>
  const close = () => { if (step.kind !== 'deleting') setStep({ kind: 'idle' }) }
  return { step, setStep, asking, confirm, close, what }
}

/** «Изменить», «Повторить» (a new spend like this one, dated today) and «Удалить» of a manual spend on its page. The deletion asks inline on a wide screen and in a sheet on
 * a phone (`narrow`), never with a browser dialog. */
export function ManualSpendActions({ receiptId, initial = { kind: 'idle' }, narrow = false }: { receiptId: number; initial?: DeleteStep; narrow?: boolean }) {
  const { step, setStep, asking, confirm, close } = useSpendDeletion(receiptId, initial)
  // A wide screen asks in place of the buttons; a phone keeps the bottom bar and asks in a sheet over it.
  if (asking && !narrow) return confirm
  return <>
    <div className="receipt-actions expense-manual-actions ck-action-bar">
      <Link className="action-link receipt-primary" to={`/receipts/${receiptId}/edit`}>Изменить</Link>
      <Link className="action-link receipt-secondary expense-repeat" to={`/receipts/new?repeat=${receiptId}`}>Повторить</Link>
      <button type="button" className="receipt-secondary" onClick={() => setStep({ kind: 'confirm' })}>Удалить</button>
      {step.kind === 'failed' && <p className="expense-failure" role="alert">{step.message}</p>}
    </div>
    {narrow && <Sheet open={asking} title="Удалить трату?" onClose={close}>{confirm}</Sheet>}
  </>
}

/** «Удалить трату» at the end of the edit form: a quiet danger button; the question comes inline on a wide screen and
 * in a sheet on a phone (`narrow`), like on the page of the spend. Never submits the form around it. */
export function DeleteSpend({ receiptId, initial = { kind: 'idle' }, narrow = false, income = false }: { receiptId: number; initial?: DeleteStep; narrow?: boolean; income?: boolean }) {
  const { step, setStep, asking, confirm, close, what } = useSpendDeletion(receiptId, initial, income ? INCOME : SPEND)
  return <div className="expense-delete">
    {asking && !narrow ? confirm
      : <button type="button" className="expense-danger expense-delete-button" onClick={() => setStep({ kind: 'confirm' })}>{what.button}</button>}
    {step.kind === 'failed' && <p className="expense-failure" role="alert">{step.message}</p>}
    {narrow && <Sheet open={asking} title={what.title} onClose={close}>{confirm}</Sheet>}
  </div>
}
