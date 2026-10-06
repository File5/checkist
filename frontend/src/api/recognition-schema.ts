import { amount, array, bool, choice, isId, isISODate, isISODateTime, nonNegativeInteger, nullable, object, price, quantity, text, unit } from './schema.ts'
import type { Check, Guard } from './schema.ts'
import { lineKind, mediaPath, receiptOperation, taxKind } from './receipts-schema.ts'
import { issueSeverities, jobStatuses } from './recognition-types.ts'
import type {
  Bbox, Executor, IssueContext, Job, JobActions, JobDetail, JobItem, JobProgress, NormalizedDiscount, NormalizedLine,
  NormalizedResult, NormalizedTax, NormalizedTaxRate, Photo, PhotoUpload, ProposedReceipt, QuadPoint,
  ReceiptImage, ReceiptImageDetail, RecognitionCsrf, RecognitionError, RecognitionIssue, RecognitionLimits, ReviewConfirmInput, ReviewConfirmResult,
  ReviewDiscountInput, ReviewLineInput, ReviewReceiptInput, ReviewTaxInput,
} from './recognition-types.ts'

export const jobStages = ['waiting', 'prepare', 'detect', 'crop', 'recognize', 'validate', 'import', 'finished'] as const
export const imageStatuses = ['pending', 'running', 'imported', 'reused', 'updated', 'needs_review', 'failed', 'cancelled'] as const
const format = choice('image/jpeg', 'image/png', 'image/webp')
const count = (max: number): Check => (value) => nonNegativeInteger(value) && (value as number) <= max
const position: Check = (value) => isId(value) && value <= 10
const finiteRange = (min: number, max: number): Check => (value) => typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max
const boundedArray = (check: Check, max: number): Check => (value) => array(check)(value) && (value as unknown[]).length <= max
export const isExecutor = object<Executor>({ available: bool, last_seen_at: nullable(isISODateTime) })
export const isRecognitionLimits = object<RecognitionLimits>({
  formats: (value) => Array.isArray(value) && value.length > 0 && value.length <= 3 && value.every(format),
  max_bytes: isId, max_pixels: isId, max_receipts: position,
})
export const isRecognitionCsrf = object<RecognitionCsrf>({
  // The fixture has a marker instead of Django's random token. Never render this value.
  csrf_token: (value) => typeof value === 'string' && /^[A-Za-z0-9_]{1,128}$/.test(value),
  limits: isRecognitionLimits, executor: isExecutor,
})
export const isPhoto = object<Photo>({
  id: isId, created_at: isISODateTime, content_type: format, bytes: isId,
  raw_width: isId, raw_height: isId, width: isId, height: isId,
  original_url: nullable(mediaPath), preview_url: nullable(mediaPath), latest_job_id: nullable(isId), receipt_images_count: nonNegativeInteger,
})
export const isJobProgress = object<JobProgress>({
  detected: nullable(count(10)), current_position: nullable(position), completed: count(10), imported: count(10),
  reused: count(10), review: count(10), failed: count(10), cancelled: count(10),
})
export const isJobActions = object<JobActions>({ can_cancel: bool, can_retry: bool })
const recognitionCode = choice(
  'missing_required', 'invalid_value', 'total_mismatch', 'tax_mismatch', 'timezone_unknown', 'time_ambiguous',
  'weak_identity', 'identity_conflict', 'product_unmatched', 'product_ambiguous', 'product_conflict',
  'geometry_requires_review', 'clipped', 'overlap', 'timeout', 'worker_lost', 'storage_unavailable',
  'provider_error', 'invalid_output', 'auth_required', 'rate_limited', 'provider_unavailable',
  'network_unavailable', 'configuration_error', 'invalid_input', 'cancelled', 'no_receipts', 'too_many_receipts',
)
export const isRecognitionError = object<RecognitionError>({ code: recognitionCode, message: text })
export const publicPointer = /^\/(?:|identity|geometry|bbox|quad|rotation_degrees|clipped|merchant|store|operation|currency(?:_code)?|purchased_on|local_time|total|discount_total|prices_include_tax|merchant\/(?:country_code|brand_name)|store\/(?:country_code|name|address_raw|city)|(?:lines|discounts|taxes)(?:\/[0-9]{1,4}(?:\/(?:position|kind|parent_position|raw_name|name|product|quantity|unit|unit_price|amount|discount_amount|tax_amount|tax_code|tax_rate|net|tax|gross|line_position|barcode|store_item_code|is_excise|is_marked))?)?)$/
const integerRange = (min: number, max: number): Check => (value) => Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max
const slug = (max: number): Check => (value) => typeof value === 'string' && new RegExp(`^[a-z_]{1,${max}}$`).test(value)
const issueContext = object<IssueContext>({ entity: slug(32), index: nullable(integerRange(0, 9999)), position: nullable(integerRange(1, 32767)), attribute: nullable(slug(32)) })
const issueBase = object<Pick<RecognitionIssue, 'code' | 'field' | 'message'>>({ code: recognitionCode, field: (value) => typeof value === 'string' && publicPointer.test(value), message: text })
const issueDetails = object<Required<Pick<RecognitionIssue, 'reason' | 'severity' | 'context'>>>({ reason: slug(64), severity: choice(...issueSeverities), context: issueContext })
// An older server sends none of the three keys; a partial set is a contract violation.
export const isRecognitionIssue: Guard<RecognitionIssue> = (value): value is RecognitionIssue => issueBase(value)
  && (!['reason', 'severity', 'context'].some((key) => Object.hasOwn(value, key)) || issueDetails(value))
export const isJobItem = object<JobItem>({ image_id: isId, position, status: choice(...imageStatuses), receipt_id: nullable(isId) })
export const isJob = object<Job>({
  id: isId, photo_id: isId, retry_of: nullable(isId), status: choice(...jobStatuses), stage: choice(...jobStages), version: isId,
  created_at: isISODateTime, started_at: nullable(isISODateTime), finished_at: nullable(isISODateTime),
  cancel_requested_at: nullable(isISODateTime), heartbeat_at: nullable(isISODateTime), stalled: bool, executor: isExecutor,
  progress: isJobProgress, review_required: bool, error: nullable(isRecognitionError), actions: isJobActions, items_count: count(10),
})
export const isJobDetail: Guard<JobDetail> = (value): value is JobDetail => isJob(value)
  && object<{ items: JobItem[] }>({ items: boundedArray(isJobItem, 10) })(value)
export const isPhotoUpload = object<PhotoUpload>({ reused: bool, photo: isPhoto, job: isJobDetail })
const bboxShape = object<Bbox>({ x_min: finiteRange(0, 1), x_max: finiteRange(0, 1), y_min: finiteRange(0, 1), y_max: finiteRange(0, 1) })
export const isBbox: Guard<Bbox> = (value): value is Bbox => bboxShape(value) && value.x_min < value.x_max && value.y_min < value.y_max
const quadPoint = object<QuadPoint>({ x: finiteRange(0, 1), y: finiteRange(0, 1) })
const quad: Check = (value) => Array.isArray(value) && value.length === 4 && value.every(quadPoint)
export const isNormalizedTaxRate = object<NormalizedTaxRate>({ kind: nullable(taxKind), rate: nullable(amount) })
export const isProposedReceipt = object<ProposedReceipt>({
  store: (value) => value === null, store_display_name: nullable(text), address_display: nullable(text),
  // The recognized code is not checked against the reference by the server either.
  country: nullable(text), currency: nullable(text),
  operation: nullable(receiptOperation),
  // Invalid printed dates/times can be precisely why this observation needs review.
  purchased_on: nullable(text), local_time: nullable(text), total: nullable(amount), discount_total: nullable(amount), prices_include_tax: nullable(bool),
})
export const isNormalizedLine = object<NormalizedLine>({
  position: nullable(count(32767)), parent_position: nullable(count(32767)), kind: nullable(lineKind), name: nullable(text), unit: nullable(unit),
  quantity: nullable(quantity), unit_price: nullable(price), amount: nullable(amount), discount_amount: nullable(amount), tax_amount: nullable(amount),
  store_item_code: nullable(text), barcode: nullable(text), tax_code: nullable(text), is_excise: nullable(bool), is_marked: nullable(bool), tax_rate: isNormalizedTaxRate,
})
export const isNormalizedDiscount = object<NormalizedDiscount>({ position: nullable(count(32767)), line_position: nullable(count(32767)), name: nullable(text), amount: nullable(amount) })
export const isNormalizedTax = object<NormalizedTax>({ tax_rate: isNormalizedTaxRate, tax_code: nullable(text), net: nullable(amount), tax: nullable(amount), gross: nullable(amount) })
export const isNormalizedResult = object<NormalizedResult>({
  proposed_receipt: isProposedReceipt, lines: boundedArray(isNormalizedLine, 1000), discounts: boundedArray(isNormalizedDiscount, 1000), taxes: boundedArray(isNormalizedTax, 100),
})
const imageShape = object<ReceiptImage>({
  id: isId, photo_id: isId, job_id: isId, position, created_at: isISODateTime, status: choice(...imageStatuses),
  receipt_id: nullable(isId), receipt_deleted: bool, image_url: nullable(mediaPath), width: isId, height: isId,
  bbox: nullable(isBbox), clipped: bool, issues: boundedArray(isRecognitionIssue, 1000), normalized_result: nullable(isNormalizedResult),
  confirmed_at: nullable(isISODateTime),
})
export const isReceiptImage: Guard<ReceiptImage> = (value): value is ReceiptImage => imageShape(value)
  && (value.status === 'needs_review' || value.normalized_result === null)
export const isReceiptImageDetail: Guard<ReceiptImageDetail> = (value): value is ReceiptImageDetail => isReceiptImage(value)
  && object<{ quad: QuadPoint[] | null; rotation_degrees: number | null }>({ quad: nullable(quad), rotation_degrees: nullable(finiteRange(-180, 180)) })(value)
export const isReviewConfirmResult = object<ReviewConfirmResult>({ image: isReceiptImageDetail, job: isJobDetail })

// Request body of the confirmation: the client's executable copy of the contract table. Unknown keys are forbidden there.
const exact = <T>(shape: { [K in keyof T]-?: Check }, optional: readonly string[] = []): Guard<T> => {
  const known = object<T>(shape)
  return (value): value is T => known(value) && Object.keys(value as object).every((key) => Object.hasOwn(shape, key) || optional.includes(key))
}
const pattern = (expression: RegExp): Check => (value) => typeof value === 'string' && expression.test(value)
const bodyText = (max: number): Check => (value) => typeof value === 'string' && value.trim().length > 0 && Array.from(value).length <= max
const bodyPosition = integerRange(1, 32767)
const bodyAmount = pattern(/^-?\d{1,12}\.\d{2}$/)
const bodyRate = exact<NormalizedTaxRate>({ kind: nullable(taxKind), rate: nullable(pattern(/^\d{1,3}\.\d{2}$/)) })
const receiptShape = exact<Omit<ReviewReceiptInput, 'utc_offset'>>({
  store_id: nullable(isId), store_name: nullable(bodyText(100)), address: nullable(bodyText(4096)),
  country: nullable(pattern(/^[A-Za-z]{2}$/)), currency: nullable(pattern(/^[A-Za-z]{3}$/)), operation: nullable(receiptOperation),
  purchased_on: isISODate, local_time: pattern(/^\d{2}:\d{2}(?::\d{2})?$/), total: bodyAmount, prices_include_tax: nullable(bool),
}, ['utc_offset'])
// The only optional key: absent keeps the recognized offset, null clears it.
const bodyReceipt: Check = (value) => receiptShape(value)
  && (!Object.hasOwn(value, 'utc_offset') || nullable(pattern(/^[+-]\d{2}:\d{2}$/))((value as ReviewReceiptInput).utc_offset))
const bodyLine = exact<ReviewLineInput>({
  position: bodyPosition, source_position: nullable(bodyPosition), kind: lineKind, parent_position: nullable(bodyPosition), name: bodyText(4096),
  quantity: nullable(pattern(/^-?\d{1,9}\.\d{3}$/)), unit: nullable(unit), unit_price: nullable(pattern(/^\d{1,10}\.\d{4}$/)), amount: nullable(bodyAmount),
  tax_rate: bodyRate, tax_code: nullable(bodyText(8)),
})
const bodyDiscount = exact<ReviewDiscountInput>({ position: bodyPosition, line_position: nullable(bodyPosition), name: bodyText(255), amount: bodyAmount })
const bodyTax = exact<ReviewTaxInput>({ tax_rate: bodyRate, tax_code: nullable(bodyText(8)), net: nullable(bodyAmount), tax: nullable(bodyAmount), gross: nullable(bodyAmount) })
const bodyShape = exact<ReviewConfirmInput>({
  receipt: bodyReceipt, lines: boundedArray(bodyLine, 1000), discounts: boundedArray(bodyDiscount, 1000), taxes: boundedArray(bodyTax, 100),
})
/** Formats and the closed key set only; uniqueness, references and import rules belong to the server. */
export const isReviewConfirmInput: Guard<ReviewConfirmInput> = (value): value is ReviewConfirmInput => bodyShape(value) && value.lines.length > 0
