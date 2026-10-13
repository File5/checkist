import { formatPurchasedOn } from '../lib/format'
import { formatMoney } from '../lib/money'
import { navigate } from '../navigation'
import { spendAmount } from './pending'
import type { PendingSpend } from './pending'
import { discardPending, handOff, sendPendingNow, usePendingSpends } from './pending-store'
import type { PendingState } from './pending-store'
import './Offline.css'

export const pendingSavedText = 'Сохранено на телефоне — отправим, когда появится сеть.'
export const photosOnlineText = 'Фото можно отправить только при сети.'

export type PendingSpendsViewProps = {
  state: Pick<PendingState, 'items' | 'syncing' | 'note'>
  onSend: () => void
  onFix: (spend: PendingSpend) => void
  onDelete: (spend: PendingSpend) => void
}

const place = (spend: PendingSpend) => spend.body.store_name?.trim() || spend.body.note?.trim() || 'Без места'

/** A cloud with a slash: saved on the phone, not on the server yet. */
const offlineIcon = ['M22 16.6A5 5 0 0 0 18 10h-1.3A8 8 0 0 0 5.3 6.3', 'M5 7.5A8 8 0 0 0 9 22h9a5 5 0 0 0 1.7-.3', 'M2 2l20 20']

/** The spends waiting on the phone, at the top of «Траты», laid out as a day of the list: a quiet heading, a card of rows
 * (a badge, the place and the date, the amount), the actions of each spend under its row; nothing while there are none. */
export function PendingSpendsView({ state, onSend, onFix, onDelete }: PendingSpendsViewProps) {
  if (!state.items.length) return null
  return <section className="pending-spends" aria-labelledby="pending-spends-heading">
    <div className="pending-spends-head">
      <h2 id="pending-spends-heading">Ждут отправки: {state.items.length.toLocaleString('ru-RU')}</h2>
      <p>{pendingSavedText} {photosOnlineText}</p>
    </div>
    <div className="pending-spends-card">
      <ul className="pending-spend-list">{state.items.map((spend) => {
        const amount = spendAmount(spend.body)
        return <li key={spend.id} className="pending-spend">
          <span className="pending-spend-badge" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" focusable="false">{offlineIcon.map((d) => <path key={d} d={d} />)}</svg>
          </span>
          <span className="pending-spend-main">
            <span className="pending-spend-place">{place(spend)}</span>
            <time dateTime={spend.body.purchased_on}>{formatPurchasedOn(spend.body.purchased_on ?? null)}</time>
          </span>
          <span className="pending-spend-amount ck-figures">{amount ? formatMoney(amount, spend.body.currency ?? '') : '—'}</span>
          <span className="pending-spend-actions">
            <button type="button" className="receipt-secondary" onClick={() => onFix(spend)}>Исправить</button>
            <button type="button" className="receipt-secondary pending-spend-delete" onClick={() => onDelete(spend)}>Удалить</button>
          </span>
          {spend.error && <p className="pending-spend-error" role="alert">Не отправлено: {spend.error}</p>}
        </li>
      })}</ul>
      <button type="button" className="pending-spends-send" onClick={onSend} disabled={state.syncing}>{state.syncing ? 'Отправляем…' : 'Отправить сейчас'}</button>
      {state.note && <p className="pending-spends-note" role="status">{state.note}</p>}
    </div>
  </section>
}

export default function PendingSpends() {
  const state = usePendingSpends()
  return <PendingSpendsView state={state} onSend={() => { void sendPendingNow() }}
    onFix={(spend) => { handOff(spend); navigate('/receipts/new') }}
    onDelete={(spend) => {
      if (window.confirm('Удалить трату с телефона? На сервер она не попадёт.')) void discardPending(spend.id)
    }} />
}
