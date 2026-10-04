import { invalidIds } from './http.ts'
import { getLocalJson } from './recognition.ts'
import { isDiscount, isLine, isReceipt, isTax } from './receipts-schema.ts'
import { page } from './schema.ts'
import type { LocalApiResult, Page, PageParams, RequestOptions } from './types.ts'
import type { Discount, Line, Receipt, ReceiptLineParams, ReceiptParams, Tax } from './receipts-types.ts'

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
