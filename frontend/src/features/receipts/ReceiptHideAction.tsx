import { useState } from 'react'
import { setReceiptHidden } from '../../api/receipts'
import Sheet from '../../components/Sheet'
import { isHead, useSession } from '../../session'
import { hideTexts } from './hide-texts'


export type ReceiptHideViewProps = {
  hidden: boolean; open: boolean; busy: boolean; failure: string | null
  onOpen: () => void; onClose: () => void; onConfirm: () => void
}

/** The quiet «Скрыть платёж» / «Показать платёж» of the family head with its confirmation in a sheet. */
export function ReceiptHideView({ hidden, open, busy, failure, onOpen, onClose, onConfirm }: ReceiptHideViewProps) {
  const label = hidden ? hideTexts.show : hideTexts.hide
  return <>
    {hidden && <p className="receipt-note" data-receipt-hidden>{hideTexts.hiddenMark}</p>}
    <div className="receipt-actions">
      <button type="button" className="receipt-secondary" data-receipt-hide={hidden ? 'show' : 'hide'} onClick={onOpen}>{label}</button>
    </div>
    <Sheet open={open} onClose={onClose} title={label} id="receipt-hide-sheet">
      <p className="receipt-note">{hidden ? hideTexts.showHint : hideTexts.hideHint}</p>
      {failure && <p className="expense-failure" role="alert">{failure}</p>}
      <div className="receipt-actions">
        <button type="button" className="receipt-secondary" data-receipt-hide-confirm aria-disabled={busy || undefined}
          onClick={busy ? undefined : onConfirm}>{busy ? 'Сохраняем…' : label}</button>
        <button type="button" className="receipt-secondary" onClick={onClose}>Отмена</button>
      </div>
    </Sheet>
  </>
}

/** Only the family head sees it; anyone else gets nothing new. `onChanged` reloads the receipt. */
export function ReceiptHideAction({ receiptId, hidden, onChanged }: { receiptId: number; hidden: boolean; onChanged: () => void }) {
  const session = useSession()
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  if (!isHead(session)) return null
  const confirm = () => {
    setBusy(true)
    setFailure(null)
    void setReceiptHidden(receiptId, !hidden).then((result) => {
      setBusy(false)
      if (result.kind === 'ok') { setOpen(false); onChanged() } else if (result.kind === 'error') {
        setFailure(result.status === 403 ? hideTexts.headOnly : hideTexts.failed)
      }
    })
  }
  return <ReceiptHideView hidden={hidden} open={open} busy={busy} failure={failure}
    onOpen={() => { setFailure(null); setOpen(true) }} onClose={() => setOpen(false)} onConfirm={confirm} />
}
