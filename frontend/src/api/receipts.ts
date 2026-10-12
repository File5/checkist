import { invalidIds } from './http.ts'
import { mutate } from './local.ts'
import { getLocalJson } from './recognition.ts'
import { isDiscount, isLine, isManualDefaults, isReceipt, isTax } from './receipts-schema.ts'
import { isManualParse } from './recognition-schema.ts'
import { page } from './schema.ts'
import type { LocalApiResult, Page, PageParams, RequestOptions } from './types.ts'
import type { Discount, Line, ManualDefaults, ManualParse, ManualSpendInput, Receipt, ReceiptLineParams, ReceiptParams, Tax } from './receipts-types.ts'

export type * from './receipts-types.ts'

export async function getReceipts(params: ReceiptParams = {}, options: RequestOptions = {}): Promise<LocalApiResult<Page<Receipt>>> {
  return invalidIds({ store: params.store, product: params.product }, options.signal)
    ?? getLocalJson('receipts/', params, page(isReceipt), options)
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
/** A new spend without a receipt; `201` with the receipt. Never replayed implicitly. */
export function createManualSpend(input: ManualSpendInput, options: RequestOptions = {}): Promise<LocalApiResult<Receipt>> {
  return mutate('receipts/manual/', JSON.stringify(input), isReceipt, options)
}
/** Only a manual spend: a photo receipt answers `409 receipt_read_only`. */
export async function updateManualSpend(id: number, input: ManualSpendInput, options: RequestOptions = {}): Promise<LocalApiResult<Receipt>> {
  return invalidIds({ id }, options.signal) ?? mutate(`receipts/${id}/`, JSON.stringify(input), isReceipt, options, false, undefined, { method: 'PATCH' })
}
export async function deleteManualSpend(id: number, options: RequestOptions = {}): Promise<LocalApiResult<null>> {
  return invalidIds({ id }, options.signal)
    ?? mutate(`receipts/${id}/`, '', (value): value is null => value === null, options, false, undefined, { method: 'DELETE' })
}

/** «Трата словами»: `202` with the queued request; `today` — the local date of the device for «вчера» and the like.
 * More than three unfinished requests (or 30 an hour) — `429 parse_limit`. */
export function requestManualParse(text: string, today: string, options: RequestOptions = {}): Promise<LocalApiResult<ManualParse>> {
  return mutate('receipts/manual/parse/', JSON.stringify({ text, today }), isManualParse, options)
}
export async function getManualParse(id: number, options: RequestOptions = {}): Promise<LocalApiResult<ManualParse>> {
  return invalidIds({ id }, options.signal) ?? getLocalJson(`receipts/manual/parse/${id}/`, {}, isManualParse, options)
}
