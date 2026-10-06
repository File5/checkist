import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Ref } from 'react'
import { getProductClassification, getProductClassifications, getProductClassificationState } from '../../api/product-classifications'
import type { Classification, ClassificationState } from '../../api/product-classifications'
import type { LocalApiFailure, Page } from '../../api/types'
import { focusOwnerAttribute } from '../../components/local-request-focus'
import Pagination from '../../components/Pagination'
import RequestState from '../../components/RequestState'
import { Link } from '../../navigation'
import type { ClassificationQuery } from '../../navigation'
import type { ClassificationPageProps } from '../../pages/types'
import { counted } from '../merges/labels'
import type { RequestState as State } from '../recognition/polling'
import { useRequest } from '../recognition/useRequest'
import { keepsArea, retryable } from './actions'
import type { ActionLifecycle, ActionState, ClassificationAction } from './actions'
import ClassificationBlock from './ClassificationBlock'
import { filters } from './labels'
import { FlatList, GroupList } from './RecordList'
import type { RecordHandlers } from './RecordList'
import StatePanel, { RunButton } from './StatePanel'
import { applyRunRequest, areaKey, listParams, openArea, replaceRecords, runFinished, stateActive } from './state'
import type { OpenArea } from './state'
import { useActionFocus, useAreaFocus, useClassificationActions } from './useClassificationActions'
import './Classification.css'

const ownFocus = { [focusOwnerAttribute]: '' }
const apiOff = <T,>(state: State<T>) => (state.kind === 'error' && state.error.reason === 'permission_denied')
  || (state.kind === 'ok' && state.refreshError?.reason === 'permission_denied')

/** Pure markup of the screen: the page below only connects requests and actions to it. */
export function ClassificationView({ query, state, list, action, open, optionsReload = 0, onRun, onRetryAction, onRetryState, onRetryList, resultRef, rootRef, ...handlers }: {
  query: ClassificationQuery; state: State<ClassificationState>; list: State<Page<Classification>>
  action: ActionState; open?: OpenArea; optionsReload?: number
  onRun: () => void; onRetryAction: () => void; onRetryState: () => void; onRetryList: () => void
  resultRef?: Ref<HTMLParagraphElement>; rootRef?: Ref<HTMLDivElement>
} & RecordHandlers) {
  const pendingFilter = query.status === undefined
  const filter = filters.find((item) => item.value === (query.status ?? ''))!
  const unavailable = apiOff(state) || apiOff(list)
  const runAction = action.kind !== 'idle' && action.action.type === 'run'
  // The message of a record or group action lives in the list; the one of «Предложить категории» — next to its button.
  const shown = !runAction && (action.kind === 'done' || action.kind === 'failed') ? action : undefined
  const stateData = state.kind === 'ok' ? state.data : undefined
  const area = list.kind === 'ok' ? openArea(open, list.data.results) : undefined
  const title = `${query.product === undefined ? filter.label : `Записи товара №${query.product} · ${filter.label}`} · Страница ${query.page.toLocaleString('ru-RU')}`
  return <div className="ck-class" ref={rootRef}>
    <StatePanel state={state} action={action} unavailable={unavailable} onRun={onRun} onRetry={onRetryState} resultRef={runAction ? resultRef : undefined} />
    <nav className="ck-class-filter" aria-label="Состояние записей">
      <ul>{filters.map((item) => <li key={item.value}>
        <Link to={{ kind: 'classification', query: { ...(item.value && { status: item.value }), ...(query.product !== undefined && { product: query.product }), page: 1 } }}
          aria-current={item.value === filter.value ? 'true' : undefined}>{item.label}</Link>
      </li>)}</ul>
    </nav>
    <ClassificationBlock title={title} id="class-list-title" state={list} retry={onRetryList}
      recovery={list.kind === 'error' && list.error.reason === 'page_out_of_range'
        ? <Link className="action-link" to={{ kind: 'classification', query: { ...query, page: 1 } }}>На первую страницу</Link> : undefined}
      lead={<>
        {query.product !== undefined && <p><Link className="action-link" to={{ kind: 'classification', query: { ...(query.status && { status: query.status }), page: 1 } }}>Показать записи всех товаров</Link></p>}
        <div className={`ck-class-result-bar${shown ? ' ck-class-result-shown' : ''}`} {...ownFocus}>
          <p ref={runAction ? undefined : resultRef} tabIndex={-1} role="status" aria-live="polite" className={shown?.kind === 'failed' ? 'ck-class-error' : 'ck-class-result'}>
            {shown ? shown.message : ''}
          </p>
          {!runAction && retryable(action) && <button type="button" className="ck-class-secondary" disabled={unavailable} onClick={onRetryAction}>Повторить</button>}
        </div>
      </>}>
      {(data) => data.results.length === 0
        ? (pendingFilter
          ? <RequestState kind="empty" message="Товаров, ожидающих подтверждения категории, нет."
            action={query.product !== undefined ? <Link className="action-link" to={{ kind: 'classification', query: { page: 1 } }}>Показать все ожидающие</Link>
              : stateData && stateData.unclassified_count > 0 ? <RunButton state={stateData} action={action} unavailable={unavailable} onRun={onRun} /> : undefined} />
          : <RequestState kind="empty" message="Записей с таким состоянием нет."
            action={<Link className="action-link" to={{ kind: 'classification', query: { ...(query.product !== undefined && { product: query.product }), page: 1 } }}>Показать ожидающие</Link>} />)
        : <div className="ck-class-list" {...ownFocus}>
          <p>Всего: {counted(data.count, 'запись', 'записи', 'записей')}. Страница {data.page.toLocaleString('ru-RU')} из {(data.pages || 1).toLocaleString('ru-RU')}.</p>
          {pendingFilter
            ? <GroupList records={data.results} product={query.product !== undefined} action={action} open={area} unavailable={unavailable} optionsReload={optionsReload} {...handlers} />
            : <FlatList records={data.results} />}
          <Pagination page={data.page} pages={data.pages} buildPageHref={(page) => ({ kind: 'classification', query: { ...query, page } })} label="Страницы записей" />
        </div>}
    </ClassificationBlock>
  </div>
}

/** The shell owns h1. The filter, the product and the page come from the URL; only the list is read again when they change. */
export default function ClassificationPage({ query }: ClassificationPageProps) {
  const { status, product, page } = query
  const loadState = useCallback((signal: AbortSignal) => getProductClassificationState({ signal }), [])
  const loadList = useCallback((signal: AbortSignal) => getProductClassifications(listParams({ status, product, page }), { signal }), [status, product, page])
  // The state is polled every 2 seconds while its run is queued or running.
  const stateRequest = useRequest(loadState, stateActive)
  const listRequest = useRequest(loadList)
  const [open, setOpen] = useState<OpenArea>()
  const [optionsReload, setOptionsReload] = useState(0)
  const states = stateRequest.request
  const lists = listRequest.request

  // A run that was active and is not any more has put its suggestions into the list: read it once.
  const seen = useRef<ClassificationState | undefined>(undefined)
  useEffect(() => {
    if (stateRequest.state.kind !== 'ok') return
    const next = stateRequest.state.data
    if (seen.current !== next && runFinished(seen.current, next)) lists.queueRefresh()
    seen.current = next
  }, [stateRequest.state, lists])

  const lifecycle = useMemo<ActionLifecycle>(() => {
    const replace = (records: Classification[]) => {
      const current = lists.getSnapshot()
      if (records.length && current.kind === 'ok') lists.setData(replaceRecords(current.data, records))
    }
    return {
      pause: () => { states.pause(); lists.pause() },
      // The answered records are shown at once; the counters, the groups and the list are then read again.
      success: (outcome) => {
        replace(outcome.records)
        const current = states.getSnapshot()
        if (outcome.run && current.kind === 'ok') states.setData(applyRunRequest(current.data, outcome.run))
        setOpen(undefined)
        states.resume()
        lists.resume()
      },
      failure: (error: LocalApiFailure, action: ClassificationAction, records: Classification[]) => {
        replace(records)
        if (!keepsArea(error, action)) setOpen(undefined)
        else if (action.type === 'choose' && error.reason !== 'classification_busy' && error.reason !== 'csrf_failed') setOptionsReload((count) => count + 1)
        states.resume()
        lists.resume()
      },
      reread: async (action, signal) => {
        if (action.type === 'run') {
          const result = await loadState(signal)
          if (result.kind === 'ok') states.setData(result.data)
        } else if (action.type === 'confirmAll') {
          const result = await loadList(signal)
          if (result.kind === 'ok') lists.setData(result.data)
        } else {
          const result = await getProductClassification(action.id, { signal })
          if (result.kind === 'ok') replace([result.data])
        }
      },
    }
  }, [states, lists, loadState, loadList])
  const actions = useClassificationActions(lifecycle)
  const focus = useActionFocus<HTMLParagraphElement>(actions.state)
  const areas = useAreaFocus<HTMLDivElement>()
  const run = (action: ClassificationAction) => { focus.remember(); void actions.run(action) }
  const failed = retryable(actions.state) ? actions.state.action : undefined
  return <ClassificationView query={query} state={stateRequest.state} list={listRequest.state} action={actions.state} open={open} optionsReload={optionsReload}
    resultRef={focus.result} rootRef={areas.root} onRetryState={states.refresh} onRetryList={lists.refresh}
    onRun={() => run({ type: 'run' })} onRetryAction={() => { if (failed) run(failed) }} onAction={run}
    onOpen={(area) => { areas.opened(); setOpen(area) }}
    onClose={(area) => { areas.closed(areaKey(area)); setOpen(undefined) }} />
}
