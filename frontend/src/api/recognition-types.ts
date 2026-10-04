import type { Decimal, ISODate, ISODateTime, PageParams, Unit } from './types.ts'
import type { LineKind, ReceiptOperation, TaxKind } from './receipts-types.ts'

export type ImageFormat = 'image/jpeg' | 'image/png' | 'image/webp'
export const jobStatuses = ['queued', 'running', 'cancel_requested', 'cancelled', 'succeeded', 'partial_succeeded', 'failed'] as const
export type JobStatus = typeof jobStatuses[number]
export type JobStage = 'waiting' | 'prepare' | 'detect' | 'crop' | 'recognize' | 'validate' | 'import' | 'finished'
export type ReceiptImageStatus = 'pending' | 'running' | 'imported' | 'reused' | 'updated' | 'needs_review' | 'failed' | 'cancelled'
export type RecognitionCode =
  | 'missing_required' | 'invalid_value' | 'total_mismatch' | 'tax_mismatch' | 'timezone_unknown' | 'time_ambiguous'
  | 'weak_identity' | 'identity_conflict' | 'product_unmatched' | 'product_ambiguous' | 'product_conflict'
  | 'geometry_requires_review' | 'clipped' | 'overlap' | 'timeout' | 'worker_lost' | 'storage_unavailable'
  | 'provider_error' | 'invalid_output' | 'auth_required' | 'rate_limited' | 'provider_unavailable'
  | 'network_unavailable' | 'configuration_error' | 'invalid_input' | 'cancelled' | 'no_receipts' | 'too_many_receipts'
/** An idle worker has no public heartbeat. False does not prohibit upload/retry. */
export type Executor = { available: boolean; last_seen_at: ISODateTime | null }
export type RecognitionLimits = { formats: ImageFormat[]; max_bytes: number; max_pixels: number; max_receipts: number }
export type RecognitionCsrf = { csrf_token: string; limits: RecognitionLimits; executor: Executor }
export type Photo = {
  id: number; created_at: ISODateTime; content_type: ImageFormat; bytes: number
  raw_width: number; raw_height: number; width: number; height: number
  original_url: string | null; preview_url: string | null; latest_job_id: number | null; receipt_images_count: number
}
export type JobProgress = {
  detected: number | null; current_position: number | null
  completed: number; imported: number; reused: number; review: number; failed: number; cancelled: number
}
export type JobActions = { can_cancel: boolean; can_retry: boolean }
export type RecognitionError = { code: RecognitionCode; message: string }
export type RecognitionIssue = RecognitionError & { field: string }
export type JobItem = { image_id: number; position: number; status: ReceiptImageStatus; receipt_id: number | null }
/** List projection. The detail and mutation responses add items. */
export type Job = {
  id: number; photo_id: number; retry_of: number | null; status: JobStatus; stage: JobStage; version: number
  created_at: ISODateTime; started_at: ISODateTime | null; finished_at: ISODateTime | null
  cancel_requested_at: ISODateTime | null; heartbeat_at: ISODateTime | null; stalled: boolean; executor: Executor
  progress: JobProgress; review_required: boolean; error: RecognitionError | null; actions: JobActions; items_count: number
}
export type JobDetail = Job & { items: JobItem[] }
export type PhotoUpload = { reused: boolean; photo: Photo; job: JobDetail }
export type Bbox = { x_min: number; x_max: number; y_min: number; y_max: number }
export type QuadPoint = { x: number; y: number }
export type NormalizedTaxRate = { kind: TaxKind | null; rate: Decimal | null }
/** Safe, incomplete observation for needs_review; no draft or editing API. */
export type ProposedReceipt = {
  store: null; store_display_name: string | null; address_display: string | null
  currency: string | null; operation: ReceiptOperation | null; purchased_on: ISODate | null; local_time: string | null
  total: Decimal | null; discount_total: Decimal | null; prices_include_tax: boolean | null
}
export type NormalizedLine = {
  position: number | null; parent_position: number | null; kind: LineKind | null; name: string | null; unit: Unit | null
  quantity: Decimal | null; unit_price: Decimal | null; amount: Decimal | null; discount_amount: Decimal | null
  tax_amount: Decimal | null; store_item_code: string | null; barcode: string | null; tax_code: string | null
  is_excise: boolean | null; is_marked: boolean | null; tax_rate: NormalizedTaxRate
}
export type NormalizedDiscount = { position: number | null; line_position: number | null; name: string | null; amount: Decimal | null }
export type NormalizedTax = { tax_rate: NormalizedTaxRate; tax_code: string | null; net: Decimal | null; tax: Decimal | null; gross: Decimal | null }
export type NormalizedResult = { proposed_receipt: ProposedReceipt; lines: NormalizedLine[]; discounts: NormalizedDiscount[]; taxes: NormalizedTax[] }
export type ReceiptImage = {
  id: number; photo_id: number; job_id: number; position: number; created_at: ISODateTime; status: ReceiptImageStatus
  receipt_id: number | null; receipt_deleted: boolean; image_url: string | null; width: number; height: number
  bbox: Bbox | null; clipped: boolean; issues: RecognitionIssue[]; normalized_result: NormalizedResult | null
}
export type ReceiptImageDetail = ReceiptImage & { quad: QuadPoint[] | null; rotation_degrees: number | null }
export type PhotoParams = PageParams & { ordering?: 'created_at' | '-created_at' }
export type JobParams = PhotoParams & { photo?: number; status?: JobStatus }
export type ReceiptImageParams = PhotoParams & { photo?: number; job?: number; receipt?: number }
