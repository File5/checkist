import { useEffect, useRef, useState } from 'react'
import { deleteReceipt } from '../../api/receipts'
import { navigate } from '../../navigation'
import {
  askDelete, deletedNotice, deleteFailureMessage, deleteQuestion, setReceiptsNotice, toggleWithPhoto, withPhotoHint,
  withPhotoLabel,
} from './delete-receipt'
import type { ReceiptDeleteStep } from './delete-receipt'
import '../expense/Expense.css'

/**
 * «Удалить чек» of a photo receipt on its page. Asks inline, never with a browser dialog; «Удалить и фото» is on by
 * default. After the deletion — «Чеки» with a notice.
 */
export function ReceiptDeleteActions({ receiptId, initial = { kind: 'idle' } }: { receiptId: number; initial?: ReceiptDeleteStep }) {
  const [step, setStep] = useState<ReceiptDeleteStep>(initial)
  const controller = useRef<AbortController | undefined>(undefined)
  const confirmButton = useRef<HTMLButtonElement>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const asking = step.kind === 'confirm'
  useEffect(() => { if (asking) confirmButton.current?.focus() }, [asking])

  if (step.kind === 'idle') return <div className="receipt-actions">
    <button type="button" className="receipt-secondary" onClick={() => setStep(askDelete())}>Удалить чек</button>
  </div>

  const { withPhoto } = step
  const deleting = step.kind === 'deleting'
  const remove = async () => {
    setStep({ kind: 'deleting', withPhoto })
    const current = new AbortController()
    controller.current = current
    const result = await deleteReceipt(receiptId, { withPhoto }, { signal: current.signal })
    if (current.signal.aborted || result.kind === 'aborted') return
    if (result.kind === 'ok' || result.reason === 'not_found') {
      setReceiptsNotice(result.kind === 'ok' ? deletedNotice(withPhoto) : 'Чек уже удалён.')
      navigate('/receipts')
      return
    }
    setStep({ kind: 'failed', withPhoto, message: deleteFailureMessage(result) })
  }
  const labelId = `receipt-delete-${receiptId}`
  return <div className="expense-confirm" role="group" aria-labelledby={labelId}>
    <p id={labelId}>{deleteQuestion}</p>
    <label className="receipt-delete-photo">
      <input type="checkbox" checked={withPhoto} disabled={deleting} aria-describedby={`${labelId}-hint`}
        onChange={(event) => setStep(toggleWithPhoto(step, event.target.checked))} />
      {withPhotoLabel}
    </label>
    <p className="receipt-note" id={`${labelId}-hint`}>{withPhotoHint}</p>
    {step.kind === 'failed' && <p className="expense-failure" role="alert">{step.message}</p>}
    <div className="receipt-actions">
      <button ref={confirmButton} type="button" className="expense-danger" disabled={deleting} onClick={() => { void remove() }}>
        {deleting ? 'Удаляем…' : 'Удалить чек'}</button>
      <button type="button" className="receipt-secondary" disabled={deleting} onClick={() => setStep({ kind: 'idle' })}>Отмена</button>
    </div>
  </div>
}
