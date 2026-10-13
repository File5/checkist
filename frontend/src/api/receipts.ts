import { invalidIds } from './http.ts'
import { mutate } from './local.ts'
import { getLocalJson } from './recognition.ts'
import { isDiscount, isLine, isManualDefaults, isManualSuggestions, isReceipt, isReceiptListItem, isTax } from './receipts-schema.ts'
import { isManualParse } from './recognition-schema.ts'
import { page } from './schema.ts'
import type { LocalApiResult, Page, PageParams, RequestOptions } from './types.ts'
import type { Discount, Line, ManualDefaults, ManualParse, ManualSpendInput, ManualSuggestion, Receipt, ReceiptLineParams, ReceiptListItem, ReceiptParams, Tax } from './receipts-types.ts'

export type * from './receipts-types.ts'

export async function getReceipts(params: ReceiptParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Page<ReceiptListItem>>> {
  return invalidIds({ store: params.store, product: params.product }, options.signal)
    ?? getLocalJson('receipts/', params, page(isReceiptListItem), options)
}
export async function getReceipt(id: number, options: RequestOptions = {}): Promise<LocalApiResult<Receipt>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`receipts/${id}/`, {}, isReceipt, options)
}
export async function getReceiptLines(id: number, params: ReceiptLineParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Page<Line>>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`receipts/${id}/lines/`, params, page(isLine), options)
}
export async function getReceiptDiscounts(id: number, params: PageParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Page<Discount>>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`receipts/${id}/discounts/`, params, page(isDiscount), options)
}
export async function getReceiptTaxes(id: number, params: PageParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Page<Tax>>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`receipts/${id}/taxes/`, params, page(isTax), options)
}

/** Defaults of the «Добавить трату» form. */
export function getManualDefaults(options: RequestOptions = {}): Promise<LocalApiResult<ManualDefaults>> {
  return getLocalJson('receipts/manual/', {}, isManualDefaults, options)
}
/** Past manual spends of the family to repeat, without the model: with words in `q` — up to 5 that have every word in
 * the place (its other spellings too), the note or the positions; without words — up to 4 repeated ones, the most
 * frequent first. Hidden payments never come. */
export async function getManualSuggestions(q: string, options: RequestOptions = {}): Promise<LocalApiResult<ManualSuggestion[]>> {
  const result = await getLocalJson('receipts/manual/suggest/', q ? { q } : {}, isManualSuggestions, options)
  return result.kind === 'ok' ? { kind: 'ok', data: result.data.results } : result
}
/** A new spend without a receipt; `201` with the receipt. Never replayed implicitly. */
export function createManualSpend(input: ManualSpendInput, options: RequestOptions = {}): Promise<LocalApiResult<Receipt>> {
  return mutate('receipts/manual/', JSON.stringify(input), isReceipt, options)
}
/** Any visible spend — a photo receipt, a manual spend, a spend from a statement — by one path (2026-10-13). */
export async function updateManualSpend(id: number, input: ManualSpendInput, options: RequestOptions = {}): Promise<LocalApiResult<Receipt>> {
  return invalidIds({ id }, options.signal) ?? mutate(`receipts/${id}/`, JSON.stringify(input), isReceipt, options, false, undefined, { method: 'PATCH' })
}
/**
 * Deletes any visible receipt: a manual spend, or a photo receipt with its lines. The crops of a photo receipt stay
 * without the link; `withPhoto` also deletes the source photo with its jobs, crops and files. Refusals:
 * `409 job_active` (the photo is still being recognized), `409 photo_shared` (another receipt comes from the photo).
 */
export async function deleteReceipt(id: number, { withPhoto = false, keepalive = false }: { withPhoto?: boolean; keepalive?: boolean } = {}, options: RequestOptions = {}): Promise<LocalApiResult<null>> {
  return invalidIds({ id }, options.signal)
    ?? mutate(`receipts/${id}/`, '', (value): value is null => value === null, options, false, undefined,
      { method: 'DELETE', ...(withPhoto && { query: { with_photo: '1' } }), ...(keepalive && { keepalive }) })
}
export async function deleteManualSpend(id: number, options: RequestOptions = {}): Promise<LocalApiResult<null>> {
  return deleteReceipt(id, {}, options)
}

/** The family head hides (`hidden: true`) or shows a payment. Refusals: `403 head_only`, `404` for an outsider. */
export async function setReceiptHidden(id: number, hidden: boolean, options: RequestOptions = {}): Promise<LocalApiResult<Receipt>> {
  return invalidIds({ id }, options.signal) ?? mutate(`receipts/${id}/${hidden ? 'hide' : 'unhide'}/`, '{}', isReceipt, options)
}

/** «Трата словами»: `202` with the queued request; `today` — the local date of the device for «вчера» and the like.
 * More than three unfinished requests (or 30 an hour) — `429 parse_limit`. */
export function requestManualParse(text: string, today: string, options: RequestOptions = {}): Promise<LocalApiResult<ManualParse>> {
  return mutate('receipts/manual/parse/', JSON.stringify({ text, today }), isManualParse, options)
}
export async function getManualParse(id: number, options: RequestOptions = {}): Promise<LocalApiResult<ManualParse>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`receipts/manual/parse/${id}/`, {}, isManualParse, options)
}
