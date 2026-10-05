import RequestState from '../../components/RequestState'
import { Link } from '../../navigation'
import { counted } from './labels'
import type { MergedHint, PendingMark } from './state'
import './Merges.css'

/** Catalog list: the product is the kept record of a group still waiting for a decision. */
export function MergeBadge({ mark }: { mark: PendingMark }) {
  return <p className="ck-merge-badge"><Link to={{ kind: 'merge', groupId: mark.groupId }}>Дубли: требует подтверждения</Link></p>
}

/** Product card of a kept record. */
export function ProductMergeNotice({ mark }: { mark: PendingMark }) {
  return <div className="ck-merge-warning ck-merge-notice">
    <p>Предварительно объединено {counted(mark.records, 'написание', 'написания', 'написаний')} — требует подтверждения. Покупки всех написаний уже показаны в этой карточке.</p>
    <Link className="action-link" to={{ kind: 'merge', groupId: mark.groupId }}>Открыть группу дублей №{mark.groupId}</Link>
  </div>
}

/** Replaces «Товар не найден» for an absorbed id: old bookmarks keep leading somewhere. */
export function MergedProductHint({ hint }: { hint: MergedHint }) {
  const name = hint.target.name.trim() || 'Не указано'
  return <RequestState kind="empty"
    message={hint.pending ? `Товар объединён с «${name}». Слияние ещё ждёт подтверждения: его можно проверить или отменить в группе дублей.`
      : `Товар объединён с «${name}». Его покупки и написания принадлежат этому товару.`}
    action={hint.pending
      ? <Link className="action-link" to={{ kind: 'merge', groupId: hint.groupId }}>Открыть группу дублей №{hint.groupId}</Link>
      : <Link className="action-link" to={{ kind: 'product', productId: hint.target.id, query: { page: 1 } }}>Открыть товар «{name}»</Link>} />
}
