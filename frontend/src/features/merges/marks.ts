import { useCallback, useMemo } from 'react'
import { getProductMerges } from '../../api/product-merges'
import type { MergeGroupBrief } from '../../api/product-merges'
import type { Page } from '../../api/types'
import type { RequestState } from '../recognition/polling'
import { useRequest } from '../recognition/useRequest'
import { mergedHint, pendingTargets } from './state'
import type { MergedHint, PendingMark } from './state'

const none: ReadonlyMap<number, PendingMark> = new Map()

/** Any refusal, the switched-off local API included, simply means «no marks»: the catalog never depends on them. */
export function marksOf(state: RequestState<Page<MergeGroupBrief>>): ReadonlyMap<number, PendingMark> {
  return state.kind === 'ok' ? pendingTargets(state.data.results) : none
}
export type ProductMergeLookup = { checking: boolean; mark?: PendingMark; hint?: MergedHint }
export function lookupOf(state: RequestState<Page<MergeGroupBrief>>, productId: number): ProductMergeLookup {
  if (state.kind !== 'ok') return { checking: state.kind === 'loading' }
  const mark = pendingTargets(state.data.results).get(productId)
  const hint = mergedHint(state.data.results, productId)
  return { checking: false, ...(mark && { mark }), ...(hint && { hint }) }
}

/** Kept products of pending groups for catalog lists. One page of up to 200 groups is read once per list. */
export function usePendingMergeMarks(): ReadonlyMap<number, PendingMark> {
  const load = useCallback((signal: AbortSignal) => getProductMerges({ status: 'pending', page_size: 200 }, { signal }), [])
  const { state } = useRequest(load)
  return useMemo(() => marksOf(state), [state])
}

/** Groups naming this product id in any role: the pending mark of a kept product or the trace of an absorbed one. */
export function useProductMergeLookup(productId: number): ProductMergeLookup {
  const load = useCallback((signal: AbortSignal) => getProductMerges({ product: productId, page_size: 200 }, { signal }), [productId])
  const { state } = useRequest(load)
  return useMemo(() => lookupOf(state, productId), [state, productId])
}
