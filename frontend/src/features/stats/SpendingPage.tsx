import { useCallback, useMemo, useState } from 'react'
import { getGenericProduct } from '../../api/catalog'
import { getCountries } from '../../api/countries'
import { getSpending } from '../../api/stats'
import { getStores } from '../../api/stores'
import type { Spending } from '../../api/stats'
import type { ApiResult, GenericProduct, LocalApiResult } from '../../api/types'
import { buildSpendingQuery, parseSpendingQuery } from '../../navigation'
import type { SpendingQuery } from '../../navigation'
import type { SpendingPageProps } from '../../pages/types'
import { useProductRequest } from '../product/useProductRequest'
import { useReceiptRequest } from '../receipts/useReceiptRequest'
import SpendingFilters from './spending-filters'
import type { SpendingReference } from './spending-filters'
import SpendingResults from './spending-results'
import { localToday, needsTail, requestKey, spendingParams, spendingTailParams } from './spending-state'
import type { Shown, SpendingRequestState } from './spending-state'
import './Spending.css'

const loadCountries = (signal: AbortSignal) => getCountries({}, { signal })
// One page of the reference is the whole list for a personal base; a longer one is announced by the form.
const loadStores = (signal: AbortSignal) => getStores({ page_size: 200 }, { signal })

export interface SpendingViewProps {
  query: SpendingQuery
  state: SpendingRequestState
  retry: () => void
  last?: Shown
  reference: SpendingReference
  /** Name of the generic product of the filter, once known. */
  genericName?: string
  /** Calendar date of the browser, `ГГГГ-ММ-ДД`: the presets count from it. */
  today: string
  /** The answer with the long list for the shown one: the composition of «Прочее». */
  tail?: SpendingRequestState
  retryTail?: () => void
}

export function SpendingView({ query, state, retry, last, reference, genericName, today, tail, retryTail }: SpendingViewProps) {
  return <div className="spending-page">
    <SpendingFilters query={query} failure={state.kind === 'error' ? state : undefined} reference={reference} today={today} />
    <SpendingResults query={query} state={state} retry={retry} last={last} genericName={genericName} tail={tail} retryTail={retryTail} />
  </div>
}

/** The long answer together with the short one it was asked for. */
type ShownTail = { base: Spending; data: Spending }
const notAsked = (): Promise<LocalApiResult<Spending>> => Promise.resolve({ kind: 'aborted' })

/** `/stats`: spending of a period. Every filter and the place in the drill-down live in the address. */
export default function SpendingPage({ query }: SpendingPageProps) {
  const search = buildSpendingQuery(query)
  // The same filters are one request, whatever object the shell passes on a re-render.
  const applied = useMemo(() => parseSpendingQuery(search).query, [search])
  // Showing or hiding the composition of «Прочее» is the same request: the block is not loaded again and keeps the focus.
  const requestSearch = requestKey(applied)
  const requested = useMemo(() => parseSpendingQuery(requestSearch).query, [requestSearch])
  const load = useCallback((signal: AbortSignal) => getSpending(spendingParams(requested), { signal }), [requested])
  const request = useReceiptRequest(load)
  const [last, setLast] = useState<Shown>()
  if (request.state.kind === 'ok' && (last?.data !== request.state.data || last.query !== applied)) setLast({ query: applied, data: request.state.data })
  if (request.state.kind === 'error' && last) setLast(undefined)

  // The long list is asked only for an open «Прочее» of a shown answer; once it came, hiding and showing does not ask again.
  const data = request.state.kind === 'ok' ? request.state.data : undefined
  const [lastTail, setLastTail] = useState<ShownTail>()
  const tailAsked = needsTail(applied, data, lastTail?.base)
  const loadTail = useCallback((signal: AbortSignal) => tailAsked ? getSpending(spendingTailParams(requested), { signal }) : notAsked(),
    [requested, tailAsked])
  const tailRequest = useReceiptRequest(loadTail)
  if (data && tailAsked && tailRequest.state.kind === 'ok' && lastTail?.data !== tailRequest.state.data) setLastTail({ base: data, data: tailRequest.state.data })
  // While new filters load, the previous answer stays on screen with the composition it had.
  const staleTail: SpendingRequestState | undefined = lastTail && lastTail.base === last?.data ? { kind: 'ok', data: lastTail.data } : undefined
  const tail = data ? (tailAsked ? tailRequest.state : undefined) : staleTail

  const countries = useProductRequest(loadCountries)
  const stores = useProductRequest(loadStores)
  const generic = applied.generic
  const loadGeneric = useCallback((signal: AbortSignal): Promise<ApiResult<GenericProduct>> =>
    generic === undefined ? Promise.resolve({ kind: 'aborted' }) : getGenericProduct(generic, { signal }), [generic])
  const genericRequest = useProductRequest(loadGeneric)
  const genericName = genericRequest.state.kind === 'ok' && genericRequest.state.data.id === generic ? genericRequest.state.data.name : undefined
  const [today] = useState(() => localToday())

  return <SpendingView query={applied} state={request.state} retry={request.retry} last={last} genericName={genericName} today={today}
    tail={tail} retryTail={tailRequest.retry}
    reference={{ countries: countries.state, stores: stores.state, retry: () => { countries.retry(); stores.retry() } }} />
}
