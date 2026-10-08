import { useCallback, useMemo, useState } from 'react'
import { getProductMerge, getProductMergeLines } from '../../api/product-merges'
import type { MergeGroup } from '../../api/product-merges'
import type { LocalApiFailure } from '../../api/types'
import { formatObservedAt } from '../../lib/format'
import { numbered } from '../../lib/text'
import { Link } from '../../navigation'
import type { MergePageProps } from '../../pages/types'
import { useRequest } from '../recognition/useRequest'
import { outcomeGroup } from './actions'
import type { MergeOutcome } from './actions'
import { countedWhole, memberName, statusLabels } from './labels'
import MergeBlock from './MergeBlock'
import MergeGroupView from './MergeGroupView'
import MergeLines from './MergeLines'
import { activeMembers, confirmInput, initialSelection, normalizeSelection } from './state'
import type { MergeSelection } from './state'
import { useActionFocus, useMergeActions } from './useMergeActions'
import './Merges.css'

/** Final or current state of the group, said in words: what happened to the records and their purchases. */
export function MergeSummary({ group }: { group: MergeGroup }) {
  const target = group.members.find((member) => member.product_id === group.target_product_id)
  const product = target && target.exists
    ? <Link to={{ kind: 'product', productId: target.product_id, query: { page: 1 } }}>{memberName(target)}</Link> : 'Не указано'
  return <>
    <p className={`ck-merge-status ck-merge-status-${group.status}`} role="status">{statusLabels[group.status]}</p>
    {group.status === 'pending' && <p>Покупки и написания уже перенесены на товар «{product}» предварительно. Остальные записи скрыты из каталога, пока вы не подтвердите или не отмените слияние.</p>}
    {group.status === 'confirmed' && <p>Слияние подтверждено: остался товар «{product}», остальные записи удалены.</p>}
    {group.status === 'cancelled' && <p>Слияние отменено: записи снова отдельные товары, каждая со своими покупками.</p>}
    {group.conflicts.length > 0 && <p className="ck-merge-warning">Есть конфликт данных: у записей разные значения. Перед подтверждением выберите нужное значение ниже.</p>}
    <dl className="ck-merge-facts">
      <div><dt>Записей</dt><dd>{(group.status === 'pending' ? activeMembers(group.members) : group.members).length.toLocaleString('ru-RU')}</dd></div>
      <div><dt>Покупок</dt><dd>{group.lines_count.toLocaleString('ru-RU')}{group.new_lines_count > 0 && ` · ${countedWhole(group.new_lines_count, 'добавлена', 'добавлены', 'добавлено')} после слияния`}</dd></div>
      <div><dt>Создана</dt><dd><time dateTime={group.created_at}>{formatObservedAt(group.created_at)}</time></dd></div>
      {group.resolved_at && <div><dt>Завершена</dt><dd><time dateTime={group.resolved_at}>{formatObservedAt(group.resolved_at)}</time></dd></div>}
    </dl>
  </>
}

function MergeScreen({ groupId, returnTo }: MergePageProps) {
  const load = useCallback((signal: AbortSignal) => getProductMerge(groupId, { signal }), [groupId])
  const { state, request } = useRequest(load)
  // A finished action reads the purchases again from the first page: their set and owners have changed.
  const [lines, setLines] = useState({ page: 1, reload: 0 })
  const loadLines = useCallback((signal: AbortSignal) => getProductMergeLines(groupId, { page: lines.page }, { signal }), [groupId, lines])
  const linesRequest = useRequest(loadLines)
  const [resets, setResets] = useState(0)
  const [choice, setChoice] = useState<{ key: string; value: MergeSelection }>()
  const lifecycle = useMemo(() => ({
    pause: request.pause,
    success: (outcome: MergeOutcome) => {
      const group = outcomeGroup(outcome)
      if (group) request.setData(group)
      request.resume(false)
      setLines((previous) => ({ page: 1, reload: previous.reload + 1 }))
    },
    // Every refusal reads the group again; a changed member set also drops the person's choice.
    failure: (error: LocalApiFailure) => {
      if (error.reason === 'merge_changed') setResets((count) => count + 1)
      request.resume()
      setLines((previous) => ({ ...previous, reload: previous.reload + 1 }))
    },
  }), [request])
  const actions = useMergeActions(lifecycle)
  const focus = useActionFocus<HTMLParagraphElement>(actions.state)
  const group = state.kind === 'ok' ? state.data : undefined
  // The choice belongs to one read state of the group: a new version or status starts from the defaults.
  const key = group ? `${group.version}:${group.status}:${resets}` : ''
  const selection = group ? normalizeSelection(group, choice?.key === key ? choice.value : initialSelection(group)) : undefined
  const run = (action: Parameters<typeof actions.run>[0]) => { focus.remember(); void actions.run(action) }
  const missing = state.kind === 'error' && state.error.reason === 'not_found'
  return <div className="ck-merge">
    <div className="ck-merge-actions"><Link className="action-link" to={returnTo ?? '/catalog/merges'}>К списку групп</Link></div>
    <MergeBlock title={numbered('Группа', groupId)} id="merge-group-title" state={state} retry={request.refresh}
      recovery={missing ? <Link className="action-link" to="/catalog/merges">К списку групп</Link> : undefined}>
      {(data) => <MergeSummary group={data} />}
    </MergeBlock>
    {group && selection && <>
      <MergeGroupView group={group} selection={selection} action={actions.state} resultRef={focus.result}
        onSelection={(value) => setChoice({ key, value })}
        onConfirm={() => run({ type: 'confirm', id: group.id, input: confirmInput(group, selection) })}
        onCancel={() => run({ type: 'cancel', id: group.id })}
        onExclude={(productId) => run({ type: 'exclude', id: group.id, input: { version: group.version, product_id: productId } })} />
      <MergeBlock title="Покупки группы" id="merge-lines-title" state={linesRequest.state} retry={linesRequest.request.refresh}
        recovery={linesRequest.state.kind === 'error' && linesRequest.state.error.reason === 'page_out_of_range'
          ? <button type="button" onClick={() => setLines((previous) => ({ ...previous, page: 1 }))}>На первую страницу</button> : undefined}>
        {(data) => <MergeLines group={group} lines={data} onPage={(page) => setLines((previous) => ({ ...previous, page }))} />}
      </MergeBlock>
    </>}
  </div>
}

/** The shell owns h1; a new group id starts every request and choice afresh. */
export default function MergePage(props: MergePageProps) {
  return <MergeScreen key={props.groupId} {...props} />
}
