import RequestState from '../../components/RequestState'
import { Link } from '../../navigation'
import { canModerate, useSession } from '../../session'
import { countedWhole } from './labels'
import type { MergedHint, PendingMark } from './state'
import './Merges.css'

/** The screens of duplicate groups belong to the moderator of the catalog: everyone else reads the mark as plain text. */
const useModerator = () => canModerate(useSession())

/** Catalog list: the product is the kept record of a group still waiting for a decision. */
export function MergeBadge({ mark }: { mark: PendingMark }) {
  const moderator = useModerator()
  return <p className="ck-merge-badge">{moderator
    ? <Link to={{ kind: 'merge', groupId: mark.groupId }}>Дубли: требует подтверждения</Link> : <span>Дубли: требует подтверждения</span>}</p>
}

/** Product card of a kept record. */
export function ProductMergeNotice({ mark }: { mark: PendingMark }) {
  const moderator = useModerator()
  return <div className="ck-merge-warning ck-merge-notice">
    <p>Предварительно объединено {countedWhole(mark.records, 'написание', 'написания', 'написаний')} — требует подтверждения. Покупки всех написаний уже показаны в этой карточке.</p>
    {moderator && <Link className="action-link" to={{ kind: 'merge', groupId: mark.groupId }}>Открыть группу дублей №{mark.groupId}</Link>}
  </div>
}

/** Replaces «Товар не найден» for an absorbed id: old bookmarks keep leading somewhere.
 * Without the right of the moderator a pending merge leads to the kept product instead of the group.
 */
export function MergedProductHint({ hint }: { hint: MergedHint }) {
  const moderator = useModerator()
  const name = hint.target.name.trim() || 'Не указано'
  return <RequestState kind="empty"
    message={!hint.pending ? `Товар объединён с «${name}». Его покупки и написания принадлежат этому товару.`
      : moderator ? `Товар объединён с «${name}». Слияние ещё ждёт подтверждения: его можно проверить или отменить в группе дублей.`
        : `Товар объединён с «${name}». Слияние ещё ждёт подтверждения.`}
    action={hint.pending && moderator
      ? <Link className="action-link" to={{ kind: 'merge', groupId: hint.groupId }}>Открыть группу дублей №{hint.groupId}</Link>
      : <Link className="action-link" to={{ kind: 'product', productId: hint.target.id, query: { page: 1 } }}>Открыть товар «{name}»</Link>} />
}
