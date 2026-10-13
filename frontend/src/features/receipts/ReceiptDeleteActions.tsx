import { useEffect, useRef, useState } from 'react'
import { deleteReceipt } from '../../api/receipts'
import { Link, navigate } from '../../navigation'
import {
  askDelete, deletedNotice, deleteFailureMessage, deleteQuestion, setReceiptsNotice, toggleWithPhoto, withPhotoHint,
  withPhotoLabel,
} from './delete-receipt'
import type { ReceiptDeleteStep } from './delete-receipt'
import Sheet from '../../components/Sheet'
import '../expense/Expense.css'

/**
 * «Удалить чек» of a photo receipt on its page. Asks inline, never with a browser dialog; «Удалить и фото» is on by
 * default. After the deletion — «Чеки» with a notice.
 */
export function ReceiptDeleteActions({ receiptId, initial = { kind: 'idle' }, narrow = false }: { receiptId: number; initial?: ReceiptDeleteStep; narrow?: boolean }) {
  const [step, setStep] = useState<ReceiptDeleteStep>(initial)
  const controller = useRef<AbortController | undefined>(undefined)
  const confirmButton = useRef<HTMLButtonElement>(null)
  useEffect(() => () => controller.current?.abort(), [])
  const asking = step.kind === 'confirm'
  useEffect(() => { if (asking) confirmButton.current?.focus() }, [asking])

  // «Изменить» — та же форма траты, что у траты вручную (единая форма, 2026-10-13); фото остаётся рядом для сверки.
  const bar = <div className="receipt-actions receipt-delete-bar ck-action-bar">
    <Link className="action-link receipt-primary" to={`/receipts/${receiptId}/edit`}>Изменить</Link>
    <button type="button" className="receipt-secondary" aria-label="Удалить чек" onClick={() => setStep(askDelete())}>Удалить</button>
  </div>
  if (step.kind === 'idle') return bar

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
  const confirm = <div className="expense-confirm" role="group" aria-labelledby={labelId}>
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
  // A wide screen asks in place of the button; a phone keeps the bottom bar and asks in a sheet over it.
  if (!narrow) return confirm
  return <>
    {bar}
    <Sheet open title="Удалить чек?" onClose={() => { if (!deleting) setStep({ kind: 'idle' }) }}>{confirm}</Sheet>
  </>
}
