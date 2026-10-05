import type { CurrencyCode, Decimal, ISODate, ISODateTime, NamedObject, PageParams, Store, Unit } from './types.ts'

export type ReceiptOperation = 'sale' | 'refund'
export type LineKind = 'product' | 'service' | 'deposit' | 'deposit_return'
export type MatchingStatus = 'matched' | 'unmatched'
export type TaxKind = 'vat' | 'exempt'
export type TaxRate = { id: number; country: string; kind: TaxKind; rate: Decimal | null }
export type Receipt = {
  id: number; store: Store; currency: CurrencyCode; operation: ReceiptOperation; purchased_on: ISODate; purchased_at: ISODateTime
  total: Decimal; discount_total: Decimal; prices_include_tax: boolean; origin: 'recognized' | 'legacy/manual'; review_required: boolean
  lines_count: number; unmatched_products_count: number; receipt_images_count: number; preview_image_url: string | null
  created_at: ISODateTime; updated_at: ISODateTime; lines_url: string; discounts_url: string; taxes_url: string; images_url: string
}
export type Line = {
  id: number; position: number; kind: LineKind; parent_id: number | null; name: string; name_i18n: Record<string, string>
  store_item_code: string; barcode: string; quantity: Decimal; unit: Unit; unit_price: Decimal; amount: Decimal
  discount_amount: Decimal; paid_amount: Decimal; product: NamedObject | null; matching_status: MatchingStatus
  tax_rate: TaxRate | null; tax_code: string; tax_amount: Decimal | null; is_excise: boolean; is_marked: boolean
}
export type Discount = { id: number; position: number; line_id: number | null; name: string; amount: Decimal }
export type Tax = { id: number; tax_rate: TaxRate; tax_code: string; net: Decimal; tax: Decimal; gross: Decimal }
export type ReceiptParams = PageParams & {
  store?: number; product?: number; country?: string; currency?: CurrencyCode; operation?: ReceiptOperation
  date_from?: ISODate; date_to?: ISODate; q?: string; ordering?: 'purchased_at' | '-purchased_at'
}
export type ReceiptLineParams = PageParams & { kind?: LineKind; matching?: MatchingStatus }
