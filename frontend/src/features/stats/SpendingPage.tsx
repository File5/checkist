import { useCallback, useMemo, useState } from 'react'
import { getGenericProduct } from '../../api/catalog'
import { getCountries } from '../../api/countries'
import { getSpending } from '../../api/stats'
import { getStores } from '../../api/stores'
import type { ApiResult, GenericProduct } from '../../api/types'
import { buildSpendingQuery, parseSpendingQuery } from '../../navigation'
import type { SpendingQuery } from '../../navigation'
import type { SpendingPageProps } from '../../pages/types'
import { useProductRequest } from '../product/useProductRequest'
import { useReceiptRequest } from '../receipts/useReceiptRequest'
import SpendingFilters from './spending-filters'
import type { SpendingReference } from './spending-filters'
import SpendingResults from './spending-results'
import { localToday, spendingParams } from './spending-state'
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
}

export function SpendingView({ query, state, retry, last, reference, genericName, today }: SpendingViewProps) {
  return <div className="spending-page">
    <SpendingFilters query={query} failure={state.kind === 'error' ? state : undefined} reference={reference} today={today} />
    <SpendingResults query={query} state={state} retry={retry} last={last} genericName={genericName} />
  </div>
}

/** `/stats`: spending of a period. Every filter and the place in the drill-down live in the address. */
export default function SpendingPage({ query }: SpendingPageProps) {
  const search = buildSpendingQuery(query)
  // The same filters are one request, whatever object the shell passes on a re-render.
  const applied = useMemo(() => parseSpendingQuery(search).query, [search])
  const load = useCallback((signal: AbortSignal) => getSpending(spendingParams(applied), { signal }), [applied])
  const request = useReceiptRequest(load)
  const [last, setLast] = useState<Shown>()
  if (request.state.kind === 'ok' && last?.data !== request.state.data) setLast({ query: applied, data: request.state.data })
  if (request.state.kind === 'error' && last) setLast(undefined)

  const countries = useProductRequest(loadCountries)
  const stores = useProductRequest(loadStores)
  const generic = applied.generic
  const loadGeneric = useCallback((signal: AbortSignal): Promise<ApiResult<GenericProduct>> =>
    generic === undefined ? Promise.resolve({ kind: 'aborted' }) : getGenericProduct(generic, { signal }), [generic])
  const genericRequest = useProductRequest(loadGeneric)
  const genericName = genericRequest.state.kind === 'ok' && genericRequest.state.data.id === generic ? genericRequest.state.data.name : undefined
  const [today] = useState(() => localToday())

  return <SpendingView query={applied} state={request.state} retry={request.retry} last={last} genericName={genericName} today={today}
    reference={{ countries: countries.state, stores: stores.state, retry: () => { countries.retry(); stores.retry() } }} />
}
