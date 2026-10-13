import type { CurrencyCode, Decimal, ISODate, ISODateTime, NamedObject, PageParams, Store, Unit } from './types.ts'
import type { Executor } from './recognition-types.ts'
import type { PaymentMethodValue } from '../lib/payment-methods.ts'

export type ReceiptOperation = 'sale' | 'refund'
/** `manual` — a spend without a receipt: no photo, may have no store, editable through the API. */
export type ReceiptSource = 'photo' | 'manual'
export type LineKind = 'product' | 'service' | 'deposit' | 'deposit_return'
export type MatchingStatus = 'matched' | 'unmatched'
export type TaxKind = 'vat' | 'exempt'
export type TaxRate = { id: number; country: string; kind: TaxKind; rate: Decimal | null }
export type Receipt = {
  /** `owner` — username of who added the receipt (family members see each other's), the key of the `owner` filter;
   * `owner_name` — their name to show (missing from an older server); `store: null` — «Без места», only for a manual spend. */
  id: number; owner: string; owner_name?: string; source: ReceiptSource; store: Store | null; note: string; currency: CurrencyCode; operation: ReceiptOperation; purchased_on: ISODate; purchased_at: ISODateTime
  total: Decimal; discount_total: Decimal; prices_include_tax: boolean; origin: 'recognized' | 'legacy/manual'; review_required: boolean
  lines_count: number; unmatched_products_count: number; receipt_images_count: number; preview_image_url: string | null
  /** WebP thumbnail (400 px) of the same crop, made on first request. */
  preview_thumb_url: string | null
  created_at: ISODateTime; updated_at: ISODateTime; lines_url: string; discounts_url: string; taxes_url: string; images_url: string
  /** A payment hidden by the family head: only the head ever gets one (detail, list with `hidden: '1'`); missing from an older server. */
  hidden?: boolean
  /** The family's base currency and the total in it at the rate of the National Bank on `purchased_on` (null — no rate);
   * only the list and the detail send them, an older server none. */
  base_currency?: CurrencyCode; base_total?: Decimal | null
  /** How it was paid, `''` — not said (2026-10-13); missing from an older server. */
  payment_method?: PaymentMethodValue
}
/** An item of `GET /api/receipts/` (the list only): the first line's name and the one top-level category of the lines.
 * Optional for an older server: a missing field reads as null. */
export type ReceiptListItem = Receipt & {
  first_line?: string | null; category?: NamedObject | null
  /** Every category of the lines, as precise as the lines name it, by name (2026-10-12). */
  categories?: NamedObject[] | null
}
export type Line = {
  id: number; position: number; kind: LineKind; parent_id: number | null; name: string; name_i18n: Record<string, string>
  store_item_code: string; barcode: string; quantity: Decimal; unit: Unit; unit_price: Decimal; amount: Decimal
  discount_amount: Decimal; paid_amount: Decimal; product: NamedObject | null
  /** The category of a line without a product (a manual spend); a line with a product takes the product's. */
  category: NamedObject | null; matching_status: MatchingStatus
  tax_rate: TaxRate | null; tax_code: string; tax_amount: Decimal | null; is_excise: boolean; is_marked: boolean
}
export type Discount = { id: number; position: number; line_id: number | null; name: string; amount: Decimal }
export type Tax = { id: number; tax_rate: TaxRate; tax_code: string; net: Decimal; tax: Decimal; gross: Decimal }
export type ReceiptParams = PageParams & {
  store?: number; product?: number; country?: string; currency?: CurrencyCode; operation?: ReceiptOperation
  date_from?: ISODate; date_to?: ISODate; q?: string; ordering?: 'purchased_at' | '-purchased_at'
  /** Username of who added the receipt; one outside the family gives an empty page. */
  owner?: string
  /** `'1'` — the family head also gets hidden payments; for anyone else it changes nothing. */
  hidden?: '1'
}
export type ReceiptLineParams = PageParams & { kind?: LineKind; matching?: MatchingStatus }

/** Defaults of the «Добавить трату» form: the currency of the last receipt and the categories of manual spends by use. */
export type ManualDefaults = { currency: CurrencyCode; frequent_categories: number[] }
/** A past manual spend of the family to repeat with one tap (`GET /api/receipts/manual/suggest/`): the last of its kind
 * (place, currency, category or names of positions) and how many there were. `lines` — positions of an itemized spend,
 * empty for one amount in `category`. */
export type ManualSuggestionLine = { name: string; amount: Decimal; category: number | null }
export type ManualSuggestion = {
  receipt_id: number; store_name: string | null; category: { id: number; name: string } | null; currency: CurrencyCode
  total: Decimal; note: string; purchased_on: ISODate; lines: ManualSuggestionLine[]; uses: number
}
export type ManualLineInput = { name: string; amount: Decimal; quantity?: Decimal; category?: number | null }
/** Body of `POST /api/receipts/manual/` and of `PATCH /api/receipts/{id}/`. Without lines `total` and `category` are required. */
export type ManualSpendInput = {
  total?: Decimal; currency?: CurrencyCode; category?: number | null; purchased_on?: ISODate
  store_name?: string | null; note?: string; lines?: ManualLineInput[]
  /** Not sent — the saved one stays (`PATCH`), `''` on a new spend. */
  payment_method?: PaymentMethodValue
}

/** «Трата словами»: the text waits for the worker; `draft` is a body of `POST /api/receipts/manual/` once `succeeded`. */
export type ManualParseStatus = 'queued' | 'running' | 'succeeded' | 'failed'
export type ManualParseLine = { name: string; amount: Decimal; quantity: Decimal | null; category: number | null }
export type ManualParseDraft = {
  total: Decimal | null; currency: CurrencyCode; category: number | null; purchased_on: ISODate
  store_name: string | null; note: string; lines: ManualParseLine[]
  /** «наличными», «с каспи», «картой форте»: `''` — the text does not say; never of an income. Missing from an older server. */
  payment_method?: PaymentMethodValue
  /** `income` — «зарплата 650 000»: `category` is a category of incomes, no place and no positions. Absent — a spend. */
  kind?: 'spend' | 'income'
}
export type ManualParse = {
  id: number; status: ManualParseStatus; draft: ManualParseDraft | null
  /** Only with `failed`; the message is a fixed server text, the client shows its own by `code`. */
  error: { code: string; message: string } | null
  created_at: ISODateTime; finished_at: ISODateTime | null; executor: Executor
}
