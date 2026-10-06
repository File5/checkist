import { useCallback, useMemo } from 'react'
import { getProductClassifications } from '../../api/product-classifications'
import type { Classification, ClassificationCategory } from '../../api/product-classifications'
import type { Page } from '../../api/types'
import type { RequestState } from '../recognition/polling'
import { useRequest } from '../recognition/useRequest'

/** A pending suggestion of one product: what the catalog list and the product card say about it. */
export type ClassificationMark = { productId: number; generic: { id: number; name: string }; category: ClassificationCategory | null }

/** Products with a pending record: product id → its suggestion. */
export function pendingMarks(records: Classification[]): Map<number, ClassificationMark> {
  const marks = new Map<number, ClassificationMark>()
  for (const { status, product, suggested } of records) {
    if (status !== 'pending' || marks.has(product.id)) continue
    marks.set(product.id, { productId: product.id, generic: { id: suggested.generic.id, name: suggested.generic.name }, category: suggested.category })
  }
  return marks
}

/**
 * The mark of a catalog product. It is shown only while the product still has the suggested generic product:
 * a record not yet closed by the server's reconciliation must not claim a category the product no longer has.
 */
export function markFor(marks: ReadonlyMap<number, ClassificationMark> | undefined, product: { id: number; generic: { id: number } }): ClassificationMark | undefined {
  const mark = marks?.get(product.id)
  return mark && mark.generic.id === product.generic.id ? mark : undefined
}

const none: ReadonlyMap<number, ClassificationMark> = new Map()

/** Loading and any refusal, the switched-off local API included, simply mean «no marks»: the catalog never depends on them. */
export function marksOf(state: RequestState<Page<Classification>>): ReadonlyMap<number, ClassificationMark> {
  return state.kind === 'ok' ? pendingMarks(state.data.results) : none
}

/** Pending suggestions for catalog lists. One page of up to 200 records is read once per list. */
export function usePendingClassificationMarks(): ReadonlyMap<number, ClassificationMark> {
  const load = useCallback((signal: AbortSignal) => getProductClassifications({ status: 'pending', page_size: 200 }, { signal }), [])
  const { state } = useRequest(load)
  return useMemo(() => marksOf(state), [state])
}

/** The pending suggestion of one product for its card; check it against the card with `markFor`. */
export function useProductClassificationMarks(productId: number): ReadonlyMap<number, ClassificationMark> {
  const load = useCallback((signal: AbortSignal) => getProductClassifications({ product: productId, status: 'pending' }, { signal }), [productId])
  const { state } = useRequest(load)
  return useMemo(() => marksOf(state), [state])
}
