import { useEffect, useRef, useState } from 'react'
import { deleteManualSpend } from '../../api/receipts'
import { Link, navigate } from '../../navigation'
import { setReceiptsNotice } from '../receipts/delete-receipt'
import { saveMessage } from './labels'
import './Expense.css'

export type DeleteStep = { kind: 'idle' } | { kind: 'confirm' } | { kind: 'deleting' } | { kind: 'failed'; message: string }

/** «Изменить» and «Удалить» of a manual spend on its page. The deletion asks inline, never with a browser dialog. */
export function ManualSpendActions({ receiptId, initial = { kind: 'idle' } }: { receiptId: number; initial?: DeleteStep }) {
  const [step, setStep] = useState<DeleteStep>(initial)
  const controller = useRef<AbortController | undefined>(undefined)
  const confirmButton = useRef<HTMLButtonElement>(null)
  useEffect(() => () => controller.current?.abort(), [])
  useEffect(() => { if (step.kind === 'confirm') confirmButton.current?.focus() }, [step.kind])

  const remove = async () => {
    setStep({ kind: 'deleting' })
    const current = new AbortController()
    controller.current = current
    const result = await deleteManualSpend(receiptId, { signal: current.signal })
    if (current.signal.aborted || result.kind === 'aborted') return
    if (result.kind === 'ok' || result.reason === 'not_found') {
      setReceiptsNotice(result.kind === 'ok' ? 'Трата удалена.' : 'Трата уже удалена.')
      navigate('/receipts')
      return
    }
    setStep({ kind: 'failed', message: saveMessage(result) })
  }

  if (step.kind === 'confirm' || step.kind === 'deleting') return <div className="expense-confirm" role="group" aria-labelledby={`expense-confirm-${receiptId}`}>
    <p id={`expense-confirm-${receiptId}`}>Удалить эту трату? Отменить удаление нельзя.</p>
    <div className="receipt-actions">
      <button ref={confirmButton} type="button" className="expense-danger" disabled={step.kind === 'deleting'} onClick={() => { void remove() }}>
        {step.kind === 'deleting' ? 'Удаляем…' : 'Удалить трату'}</button>
      <button type="button" className="receipt-secondary" disabled={step.kind === 'deleting'} onClick={() => setStep({ kind: 'idle' })}>Отмена</button>
    </div>
  </div>
  return <div className="receipt-actions expense-manual-actions">
    <Link className="action-link receipt-primary" to={`/receipts/${receiptId}/edit`}>Изменить</Link>
    <button type="button" className="receipt-secondary" onClick={() => setStep({ kind: 'confirm' })}>Удалить</button>
    {step.kind === 'failed' && <p className="expense-failure" role="alert">{step.message}</p>}
  </div>
}
