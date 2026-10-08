import { useCallback, useMemo } from 'react'
import type { ChangeEvent, Ref } from 'react'
import { getProductMerges } from '../../api/product-merges'
import type { MergeGroupBrief } from '../../api/product-merges'
import type { Page } from '../../api/types'
import Pagination from '../../components/Pagination'
import RequestState from '../../components/RequestState'
import { formatObservedAt } from '../../lib/format'
import { numbered } from '../../lib/text'
import { Link, navigate } from '../../navigation'
import type { MergesQuery } from '../../navigation'
import type { MergesPageProps } from '../../pages/types'
import type { RequestState as State } from '../recognition/polling'
import { useRequest } from '../recognition/useRequest'
import type { ActionState } from './actions'
import { countedWhole, memberName, statusLabels } from './labels'
import MergeBlock from './MergeBlock'
import { activeMembers, apiStatus } from './state'
import { useActionFocus, useMergeActions } from './useMergeActions'
import './Merges.css'

const filters: { value: NonNullable<MergesQuery['status']> | ''; label: string }[] = [
  { value: '', label: 'Ожидают подтверждения' }, { value: 'confirmed', label: 'Подтверждённые' },
  { value: 'cancelled', label: 'Отменённые' }, { value: 'all', label: 'Все группы' },
]

function GroupCard({ group }: { group: MergeGroupBrief }) {
  const target = group.members.find((member) => member.product_id === group.target_product_id)
  const records = group.status === 'pending' ? activeMembers(group.members) : group.members
  return <li className="ck-merge-card">
    <h3><Link to={{ kind: 'merge', groupId: group.id }}>{numbered('Группа', group.id)}: {target ? memberName(target) : 'Не указано'}</Link></h3>
    <p className={`ck-merge-status ck-merge-status-${group.status}`}>
      {statusLabels[group.status]}
      {group.has_conflicts && <span className="ck-merge-flag"> · Есть конфликт данных: нужен выбор значения</span>}
    </p>
    <dl className="ck-merge-facts">
      <div><dt>Записей</dt><dd>{records.length.toLocaleString('ru-RU')}</dd></div>
      <div><dt>Покупок</dt><dd>{group.lines_count.toLocaleString('ru-RU')}{group.new_lines_count > 0 && ` · после слияния добавлено ${group.new_lines_count.toLocaleString('ru-RU')}`}</dd></div>
      <div><dt>Создана</dt><dd><time dateTime={group.created_at}>{formatObservedAt(group.created_at)}</time></dd></div>
      {group.resolved_at && <div><dt>Завершена</dt><dd><time dateTime={group.resolved_at}>{formatObservedAt(group.resolved_at)}</time></dd></div>}
    </dl>
    <ul className="ck-merge-names" aria-label={`Названия записей группы №${group.id}`}>
      {records.map((member) => <li key={member.product_id}>{memberName(member)}{member.product_id === group.target_product_id && <span className="ck-merge-note"> — оставляемая</span>}</li>)}
    </ul>
  </li>
}

/** Pure markup of the list screen: the page below only connects requests and actions to it. */
export function MergesView({ query, state, action, onDetect, onRetry, resultRef }: {
  query: MergesQuery; state: State<Page<MergeGroupBrief>>; action: ActionState
  onDetect: () => void; onRetry: () => void; resultRef?: Ref<HTMLParagraphElement>
}) {
  const pending = action.kind === 'pending'
  // Without the local API a search can only fail the same way; the list block explains why.
  const unavailable = state.kind === 'error' && state.error.reason === 'permission_denied'
  const detectButton = <button type="button" disabled={pending || unavailable} onClick={onDetect}>{pending ? 'Ищем дубли…' : 'Найти дубли'}</button>
  const changeStatus = (event: ChangeEvent<HTMLSelectElement>) => navigate({ kind: 'merges',
    query: { page: 1, ...(event.target.value && { status: event.target.value as MergesQuery['status'] }) } })
  const detected = action.kind === 'done' ? action.detected : undefined
  const filter = filters.find((item) => item.value === (query.status ?? ''))!
  return <div className="ck-merge">
    <div className="ck-merge-panel">
      <p className="ck-merge-note">Похожие названия одного продавца объединены предварительно: покупки уже показаны у оставляемого товара. Подтвердите слияние, отмените его или исключите лишнюю запись.</p>
      <div className="ck-merge-field">
        <label htmlFor="merge-status-filter">Состояние групп</label>
        <select id="merge-status-filter" value={query.status ?? ''} onChange={changeStatus}>
          {filters.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
        </select>
      </div>
      <div className="ck-merge-actions">{detectButton}</div>
      <p ref={resultRef} tabIndex={-1} role="status" aria-live="polite" className={action.kind === 'failed' ? 'ck-merge-error' : 'ck-merge-result'}>
        {action.kind === 'done' || action.kind === 'failed' ? action.message : ''}
      </p>
      {detected && detected.group_ids.length > 0 && <ul className="ck-merge-names" aria-label="Найденные группы">
        {detected.group_ids.map((id) => <li key={id}><Link to={{ kind: 'merge', groupId: id }}>{numbered('Группа', id)}</Link></li>)}
      </ul>}
    </div>
    <MergeBlock title={`${filter.label} · Страница ${query.page.toLocaleString('ru-RU')}`} id="merge-groups-title" state={state} retry={onRetry}
      recovery={state.kind === 'error' && state.error.reason === 'page_out_of_range'
        ? <Link className="action-link" to={{ kind: 'merges', query: { ...query, page: 1 } }}>На первую страницу</Link> : undefined}>
      {(data) => data.results.length === 0
        ? (query.status === undefined
          ? <RequestState kind="empty" message="Групп, требующих подтверждения, нет." action={detectButton} />
          : <RequestState kind="empty" message="Групп с таким состоянием нет." action={<Link className="action-link" to={{ kind: 'merges', query: { page: 1 } }}>Показать ожидающие</Link>} />)
        : <>
          <p>Всего: {countedWhole(data.count, 'группа', 'группы', 'групп')}. Страница {data.page.toLocaleString('ru-RU')} из {(data.pages || 1).toLocaleString('ru-RU')}.</p>
          <ul className="ck-merge-list">{data.results.map((group) => <GroupCard group={group} key={group.id} />)}</ul>
          <Pagination page={data.page} pages={data.pages} buildPageHref={(page) => ({ kind: 'merges', query: { ...query, page } })} label="Страницы групп" />
        </>}
    </MergeBlock>
  </div>
}

export default function MergesPage({ query }: MergesPageProps) {
  const { status, page } = query
  const load = useCallback((signal: AbortSignal) => getProductMerges({ status: apiStatus({ status, page }), page }, { signal }), [status, page])
  const { state, request } = useRequest(load)
  // Whatever the search answered, the list is read again: a refusal may hide a finished search.
  const lifecycle = useMemo(() => ({ pause: request.pause, success: () => request.resume(), failure: () => request.resume() }), [request])
  const actions = useMergeActions(lifecycle)
  const focus = useActionFocus<HTMLParagraphElement>(actions.state)
  const detect = () => { focus.remember(); void actions.run({ type: 'detect' }) }
  return <MergesView query={query} state={state} action={actions.state} onDetect={detect} onRetry={request.refresh} resultRef={focus.result} />
}
