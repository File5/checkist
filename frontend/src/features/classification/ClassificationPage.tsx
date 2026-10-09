import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Ref } from 'react'
import { getProductClassifications, getProductClassificationState } from '../../api/product-classifications'
import type { Classification, ClassificationState } from '../../api/product-classifications'
import type { Page } from '../../api/types'
import { focusOwnerAttribute } from '../../components/local-request-focus'
import Pagination from '../../components/Pagination'
import RequestState from '../../components/RequestState'
import { numbered } from '../../lib/text'
import { Link } from '../../navigation'
import type { ClassificationQuery } from '../../navigation'
import type { ClassificationPageProps } from '../../pages/types'
import { countedWhole } from '../merges/labels'
import type { RequestState as State } from '../recognition/polling'
import { useRequest } from '../recognition/useRequest'
import { retryable } from './actions'
import type { ActionState, ClassificationAction } from './actions'
import ClassificationBlock from './ClassificationBlock'
import { areaNotice, filters } from './labels'
import { FlatList, GroupList } from './RecordList'
import type { RecordHandlers } from './RecordList'
import StatePanel, { RunButton } from './StatePanel'
import { createReadSync } from './list-sync'
import { createPageLifecycle } from './page-lifecycle'
import type { ListReads } from './page-lifecycle'
import { areaFate, areaKey, listParams, openArea, openedArea, stateActive } from './state'
import type { OpenArea, Opened } from './state'
import { useActionFocus, useAreaFocus, useClassificationActions, useNoticeFocus } from './useClassificationActions'
import './Classification.css'

const ownFocus = { [focusOwnerAttribute]: '' }
const apiOff = <T,>(state: State<T>) => (state.kind === 'error' && state.error.reason === 'permission_denied')
  || (state.kind === 'ok' && state.refreshError?.reason === 'permission_denied')

/** Pure markup of the screen: the page below only connects requests and actions to it. */
export function ClassificationView({ query, state, list, action, open, notice, optionsReload = 0, onRun, onRetryAction, onRetryState, onRetryList, resultRef, rootRef, ...handlers }: {
  query: ClassificationQuery; state: State<ClassificationState>; list: State<Page<Classification>>
  action: ActionState; open?: OpenArea; optionsReload?: number
  /** A read of the list closed the open area: said where the results of record actions are. */
  notice?: string
  onRun: () => void; onRetryAction: () => void; onRetryState: () => void; onRetryList: () => void
  resultRef?: Ref<HTMLParagraphElement>; rootRef?: Ref<HTMLDivElement>
} & RecordHandlers) {
  const pendingFilter = query.status === undefined
  const filter = filters.find((item) => item.value === (query.status ?? ''))!
  const unavailable = apiOff(state) || apiOff(list)
  const runAction = action.kind !== 'idle' && action.action.type === 'run'
  // The message of a record or group action lives in the list; the one of «Предложить категории» — next to its button.
  const shown = !runAction && (action.kind === 'done' || action.kind === 'failed') ? action : undefined
  const listText = notice ?? shown?.message ?? ''
  const panelResult = runAction && notice === undefined
  const stateData = state.kind === 'ok' ? state.data : undefined
  const area = list.kind === 'ok' ? openArea(open, list.data.results) : undefined
  const title = `${query.product === undefined ? filter.label : `${numbered('Записи товара', query.product)} · ${filter.label}`} · Страница ${query.page.toLocaleString('ru-RU')}`
  return <div className="ck-class" ref={rootRef}>
    <StatePanel state={state} action={action} unavailable={unavailable} onRun={onRun} onRetry={onRetryState} resultRef={panelResult ? resultRef : undefined} />
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
        <div className={`ck-class-result-bar${listText ? ' ck-class-result-shown' : ''}`} {...ownFocus}>
          <p ref={panelResult ? undefined : resultRef} tabIndex={-1} role="status" aria-live="polite"
            className={notice !== undefined || shown?.kind === 'failed' ? 'ck-class-error' : 'ck-class-result'}>
            {listText}
          </p>
          {notice === undefined && !runAction && retryable(action) && <button type="button" className="ck-class-secondary" disabled={unavailable} onClick={onRetryAction}>Повторить</button>}
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
          <p>Всего: {countedWhole(data.count, 'запись', 'записи', 'записей')}. Страница {data.page.toLocaleString('ru-RU')} из {(data.pages || 1).toLocaleString('ru-RU')}.</p>
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
  // An area belongs to the list it was opened in: another filter, product or page starts without it.
  const place = `${status ?? ''}/${product ?? ''}/${page}`
  const [openedAt, setOpened] = useState<Opened & { place: string }>()
  const opened = openedAt?.place === place ? openedAt : undefined
  const [optionsReload, setOptionsReload] = useState(0)
  const states = stateRequest.request
  const lists = listRequest.request

  // The two requests are read independently: every state either of them publishes is checked against the other one,
  // so the list follows the batches of an active run and the counters never contradict it for long.
  const reads = useMemo(() => createReadSync(states, lists, { status, product }), [states, lists, status, product])
  useEffect(() => reads.start(), [reads])

  // An action outlives its list when the person goes on during its POST: the answer then concerns the list shown now.
  const shown = useRef<ListReads>({ lists, reads })
  useEffect(() => { shown.current = { lists, reads } }, [lists, reads])
  const lifecycle = useMemo(() => createPageLifecycle({
    states, own: { lists, reads }, shown: () => shown.current, loadState, loadList,
    area: {
      close: () => setOpened(undefined),
      keep: (records) => setOpened((area) => {
        const kept = area && openedArea(area.area, records)
        return kept && { ...kept, place: area.place }
      }),
      reloadOptions: () => setOptionsReload((count) => count + 1),
    },
  }), [states, lists, reads, loadState, loadList])
  const actions = useClassificationActions(lifecycle)
  const focus = useActionFocus<HTMLParagraphElement>(actions.state)
  const areas = useAreaFocus<HTMLDivElement>()
  // A read of the list leaves the open area alone while its record is what the person saw; otherwise it closes with a message.
  const records = listRequest.state.kind === 'ok' ? listRequest.state.data.results : undefined
  const fate = opened && records && actions.state.kind !== 'pending' ? areaFate(opened, records) : 'open'
  const notice = opened && fate !== 'open' ? areaNotice(fate, opened.area) : undefined
  useNoticeFocus(notice, focus.result)
  const run = (action: ClassificationAction) => { focus.remember(); if (notice !== undefined) setOpened(undefined); void actions.run(action) }
  const failed = retryable(actions.state) ? actions.state.action : undefined
  return <ClassificationView query={query} state={stateRequest.state} list={listRequest.state} action={actions.state}
    open={notice === undefined ? opened?.area : undefined} notice={notice} optionsReload={optionsReload}
    resultRef={focus.result} rootRef={areas.root} onRetryState={states.refresh} onRetryList={lists.refresh}
    onRun={() => run({ type: 'run' })} onRetryAction={() => { if (failed) run(failed) }} onAction={run}
    onOpen={(area) => {
      const next = records && openedArea(area, records)
      areas.opened()
      setOpened(next && { ...next, place })
    }}
    onClose={(area) => { areas.closed(areaKey(area)); setOpened(undefined) }} />
}
