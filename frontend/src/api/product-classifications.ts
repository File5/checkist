import { invalidIds } from './http.ts'
import type { Query } from './http.ts'
import { getLocalJson, mutate } from './local.ts'
import {
  isClassification, isClassificationConfirmMany, isClassificationRun, isClassificationRunRequest, isClassificationState,
} from './product-classifications-schema.ts'
import { classificationConfirmLimit } from './product-classifications-types.ts'
import { page } from './schema.ts'
import type { LocalApiFailure, LocalApiResult, Page, RequestOptions } from './types.ts'
import type {
  Classification, ClassificationConfirmInput, ClassificationConfirmItem, ClassificationConfirmMany, ClassificationParams,
  ClassificationRejectInput, ClassificationRun, ClassificationRunParams, ClassificationRunRequest, ClassificationState,
} from './product-classifications-types.ts'

export type * from './product-classifications-types.ts'
export {
  classificationConfirmLimit, classificationResolutions, classificationRunStatuses, classificationStatuses,
} from './product-classifications-types.ts'

/** The three 409 answers of a classification mutation; the mass confirmation may name `items.N`. */
export const classificationErrorReasons = ['classification_resolved', 'classification_changed', 'classification_busy'] as const
export type ClassificationErrorReason = typeof classificationErrorReasons[number]
export function isClassificationError(failure: LocalApiFailure): failure is LocalApiFailure & { reason: ClassificationErrorReason } {
  return (classificationErrorReasons as readonly string[]).includes(failure.reason)
}

const root = 'product-classifications/'

/** Records; without `status` — of every state. `ordering: 'generic'` keeps records of one suggested generic product together. */
export async function getProductClassifications(params: ClassificationParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Page<Classification>>> {
  return invalidIds({ product: params.product, generic: params.generic, run: params.run }, options.signal)
    ?? getLocalJson(root, params, page(isClassification), options)
}
export async function getProductClassification(id: number, options: RequestOptions = {}): Promise<LocalApiResult<Classification>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`${root}${id}/`, {}, isClassification, options)
}
export function getProductClassificationState(options: RequestOptions = {}): Promise<LocalApiResult<ClassificationState>> {
  return getLocalJson(`${root}status/`, {}, isClassificationState, options)
}
export function getProductClassificationRuns(params: ClassificationRunParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Page<ClassificationRun>>> {
  return getLocalJson(`${root}runs/`, params, page(isClassificationRun), options)
}
export async function getProductClassificationRun(id: number, options: RequestOptions = {}): Promise<LocalApiResult<ClassificationRun>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`${root}runs/${id}/`, {}, isClassificationRun, options)
}

/** None of the mutations is replayed implicitly: after network/timeout read the record before a new attempt. */
export async function confirmProductClassification(id: number, input: ClassificationConfirmInput, options: RequestOptions = {}): Promise<LocalApiResult<Classification>> {
  // The body is rebuilt from documented keys only: the server rejects unknown ones.
  const body = { version: input.version, generic_id: input.generic_id }
  // A missing key is refused here as well: confirm always carries both values.
  return invalidIds({ id, version: body.version ?? 0, generic_id: body.generic_id ?? 0 }, options.signal) ?? mutate(`${root}${id}/confirm/`, JSON.stringify(body), isClassification, options)
}
export async function rejectProductClassification(id: number, input: ClassificationRejectInput, options: RequestOptions = {}): Promise<LocalApiResult<Classification>> {
  const body = { version: input.version }
  return invalidIds({ id, version: body.version ?? 0 }, options.signal) ?? mutate(`${root}${id}/reject/`, JSON.stringify(body), isClassification, options)
}
/** All or nothing for 1–100 records, each confirmed with its own suggested generic product. */
export async function confirmProductClassifications(items: ClassificationConfirmItem[], options: RequestOptions = {}): Promise<LocalApiResult<ClassificationConfirmMany>> {
  if (options.signal?.aborted) return { kind: 'aborted' }
  if (!Array.isArray(items) || items.length < 1 || items.length > classificationConfirmLimit) return { kind: 'error', reason: 'invalid_parameter', fields: ['items'] }
  const body = items.map((item) => ({ id: item.id, version: item.version }))
  const ids: Query = {}
  const seen = new Set<number>()
  body.forEach((item, index) => {
    // A repeated id is reported under the server's own key and never sent.
    ids[`items.${index}.id`] = seen.has(item.id) ? 0 : item.id ?? 0
    ids[`items.${index}.version`] = item.version ?? 0
    seen.add(item.id)
  })
  return invalidIds(ids, options.signal) ?? mutate(`${root}confirm/`, JSON.stringify({ items: body }), isClassificationConfirmMany, options)
}
/** 202 — a run was queued; 200 — the active run is returned or there is nothing to classify. */
export function requestProductClassificationRun(options: RequestOptions = {}): Promise<LocalApiResult<ClassificationRunRequest>> {
  return mutate(`${root}runs/`, '{}', isClassificationRunRequest, options)
}
