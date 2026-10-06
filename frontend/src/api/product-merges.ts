import { invalidIds } from './http.ts'
import type { Query } from './http.ts'
import { getLocalJson, mutate } from './local.ts'
import { isMergeDetectResult, isMergeGroup, isMergeGroupBrief, isMergeLine } from './product-merges-schema.ts'
import { mergeConflictFields } from './product-merges-types.ts'
import { page } from './schema.ts'
import type { LocalApiFailure, LocalApiResult, Page, PageParams, RequestOptions } from './types.ts'
import type {
  MergeConfirmInput, MergeDetectResult, MergeExcludeInput, MergeGroup, MergeGroupBrief, MergeGroupParams, MergeLine,
} from './product-merges-types.ts'

export type * from './product-merges-types.ts'
export { mergeConflictFields, mergeStatuses } from './product-merges-types.ts'

/** The four 409 answers of a merge mutation; `merge_conflict` may carry field names. */
export const mergeErrorReasons = ['merge_conflict', 'merge_resolved', 'merge_changed', 'merge_busy'] as const
export type MergeErrorReason = typeof mergeErrorReasons[number]
export function isMergeError(failure: LocalApiFailure): failure is LocalApiFailure & { reason: MergeErrorReason } {
  return (mergeErrorReasons as readonly string[]).includes(failure.reason)
}

export async function getProductMerges(params: MergeGroupParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Page<MergeGroupBrief>>> {
  return invalidIds({ product: params.product }, options.signal) ?? getLocalJson('product-merges/', params, page(isMergeGroupBrief), options)
}
export async function getProductMerge(id: number, options: RequestOptions = {}): Promise<LocalApiResult<MergeGroup>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`product-merges/${id}/`, {}, isMergeGroup, options)
}
export async function getProductMergeLines(id: number, params: PageParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Page<MergeLine>>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`product-merges/${id}/lines/`, params, page(isMergeLine), options)
}

/** None of the mutations is replayed implicitly: after network/timeout read the group before a new attempt. */
export function detectProductMerges(options: RequestOptions = {}): Promise<LocalApiResult<MergeDetectResult>> {
  return mutate('product-merges/detect/', '{}', isMergeDetectResult, options)
}
export async function confirmProductMerge(id: number, input: MergeConfirmInput, options: RequestOptions = {}): Promise<LocalApiResult<MergeGroup>> {
  // The body is rebuilt from documented keys only: the server rejects unknown ones and a null name_product_id.
  const body: Record<string, unknown> = { version: input.version, target_product_id: input.target_product_id }
  const ids: Query = { id, version: input.version, target_product_id: input.target_product_id }
  if (input.name_product_id !== undefined) ids.name_product_id = body.name_product_id = input.name_product_id
  const resolutions: Record<string, unknown> = {}
  for (const [field, productId] of Object.entries(input.resolutions ?? {})) {
    if (productId === undefined) continue
    // An unknown disputed field is reported under the server's own key and never sent.
    ids[`resolutions.${field}`] = (mergeConflictFields as readonly string[]).includes(field) ? productId : 0
    resolutions[field] = productId
  }
  if (Object.keys(resolutions).length) body.resolutions = resolutions
  return invalidIds(ids, options.signal) ?? mutate(`product-merges/${id}/confirm/`, JSON.stringify(body), isMergeGroup, options)
}
export async function cancelProductMerge(id: number, options: RequestOptions = {}): Promise<LocalApiResult<MergeGroup>> {
  return invalidIds({ id }, options.signal) ?? mutate(`product-merges/${id}/cancel/`, '{}', isMergeGroup, options)
}
export async function excludeProductMerge(id: number, input: MergeExcludeInput, options: RequestOptions = {}): Promise<LocalApiResult<MergeGroup>> {
  const body = { version: input.version, product_id: input.product_id }
  return invalidIds({ id, ...body }, options.signal) ?? mutate(`product-merges/${id}/exclude/`, JSON.stringify(body), isMergeGroup, options)
}
