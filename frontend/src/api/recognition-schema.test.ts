import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { readError } from './http'
import {
  isJob, isJobDetail, isPhoto, isPhotoUpload, isReceiptImage, isReceiptImageDetail, isRecognitionCsrf, isRecognitionIssue,
  isReviewConfirmInput, isReviewConfirmResult,
} from './recognition-schema'
import { isDiscount, isLine, isReceipt, isTax } from './receipts-schema'
import { page } from './schema'
import { issue, publicFixture, taxEvidenceMissingIssues } from './recognition-test-support'
import type { JobDetail, ReceiptImageDetail, ReviewConfirmInput, ReviewConfirmResult } from './recognition-types'
import type { Line, Receipt } from './receipts-types'
import type { Page } from './types'

const schemas: Record<string, (value: unknown) => boolean> = {
  'csrf.json': isRecognitionCsrf, 'photo.json': isPhoto, 'photos.json': page(isPhoto),
  'job.json': isJobDetail, 'jobs.json': page(isJob), 'job-running.json': isJobDetail, 'job-cancel-requested.json': isJobDetail,
  'receipt-image.json': isReceiptImageDetail, 'receipt-images.json': page(isReceiptImage),
  'upload-new.json': isPhotoUpload, 'upload-reused.json': isPhotoUpload,
  'review-confirm-request.json': isReviewConfirmInput, 'review-confirmed.json': isReviewConfirmResult,
  // Error bodies are read by the transport: the fixture is valid when it becomes exactly its refusal.
  'review-invalid.json': (value) => readError(409, value, true).reason === 'review_invalid',
  'review-invalid-parameter.json': (value) => readError(400, value, true).reason === 'invalid_parameter',
  'receipt.json': isReceipt, 'receipts.json': page(isReceipt), 'lines.json': page(isLine), 'discounts.json': page(isDiscount), 'taxes.json': page(isTax),
}

describe('public recognition/receipts contract fixtures', () => {
  it('covers every JSON supplied by backend, including future additions', () => {
    const files = readdirSync(new URL('../../../backend/recognition/tests/fixtures/public/', import.meta.url)).filter((name) => name.endsWith('.json')).sort()
    expect(Object.keys(schemas).sort()).toEqual(files)
  })
  it.each(Object.entries(schemas))('validates %s and requires every root field', (name, validate) => {
    const body = publicFixture(name) as Record<string, unknown>
    expect(validate(body)).toBe(true)
    for (const key of Object.keys(body)) {
      const missing = { ...body }
      delete missing[key]
      expect(validate(missing), `${name} missing ${key}`).toBe(false)
    }
    for (const invalid of [null, [], true, 'body', 1, {}]) expect(validate(invalid)).toBe(false)
  })
  it('requires detail fields without pretending that the list provides them', () => {
    const job = publicFixture('job.json') as JobDetail
    const listJob: Partial<JobDetail> = { ...job }
    delete listJob.items
    expect(isJob(listJob)).toBe(true)
    expect(isJobDetail(listJob)).toBe(false)
    const listImage: Partial<ReceiptImageDetail> = { ...(publicFixture('receipt-image.json') as ReceiptImageDetail) }
    delete listImage.quad
    delete listImage.rotation_degrees
    expect(isReceiptImage(listImage)).toBe(true)
    expect(isReceiptImageDetail(listImage)).toBe(false)
  })
  it('validates incomplete review output and preserves invalid printed dates for review', () => {
    const image = publicFixture('receipt-image.json') as ReceiptImageDetail
    expect(image.normalized_result?.lines[0].quantity).toBeNull()
    const copy = structuredClone(image)
    copy.normalized_result!.proposed_receipt.purchased_on = '2026-02-30'
    expect(isReceiptImageDetail(copy)).toBe(true)
    copy.normalized_result!.lines[0].quantity = '1e3'
    expect(isReceiptImageDetail(copy)).toBe(false)
    expect(isReceiptImageDetail({ ...image, status: 'imported' })).toBe(false)
    expect(isReceiptImageDetail({ ...image, normalized_result: null })).toBe(true)
  })
  it.each([
    ['job.json', { status: 'unknown' }], ['job.json', { stage: 'unknown' }], ['job.json', { version: 0 }],
    ['job.json', { progress: { detected: '2' } }], ['job.json', { actions: { can_cancel: 1, can_retry: true } }],
    ['job.json', { error: { code: 'private_error', message: 'error' } }], ['job.json', { stalled: 'false' }],
    ['job.json', { started_at: '2026-02-30T12:00:00Z' }], ['job.json', { items_count: 11 }],
    ['photo.json', { id: Number.MAX_SAFE_INTEGER + 1 }], ['photo.json', { width: 0 }], ['photo.json', { content_type: 'image/heic' }],
    ['photo.json', { original_url: 'https://outside.test/media/x.png' }], ['photo.json', { preview_url: '/media/../secret.png' }],
    ['receipt-image.json', { bbox: { x_min: 0.9, x_max: 0.1, y_min: 0, y_max: 1 } }],
    ['receipt-image.json', { quad: [{ x: 0, y: 0 }] }], ['receipt-image.json', { rotation_degrees: Infinity }],
    ['receipt-image.json', { issues: [{ code: 'missing_required', field: '/fiscal', message: 'error' }] }],
    ['receipt.json', { total: 2.38 }], ['receipt.json', { total: '2.3800' }], ['receipt.json', { purchased_at: 'yesterday' }],
    ['receipt.json', { origin: 'manual' }], ['receipt.json', { lines_url: 'https://outside.test/api/receipts/71/lines/' }],
    ['csrf.json', { csrf_token: 'token\r\nInjected: 1' }], ['csrf.json', { executor: { available: 'false', last_seen_at: null } }],
  ])('rejects malformed nested fields in %s %#', (name, patch) => {
    expect(schemas[name]({ ...(publicFixture(name) as object), ...patch })).toBe(false)
  })
  it('keeps money precise, allows refunds and legacy zero positions, checks matching/i18n', () => {
    const receipt = publicFixture('receipt.json') as Receipt
    expect(isReceipt({ ...receipt, total: '-999999999999.99', operation: 'refund', origin: 'legacy/manual' })).toBe(true)
    const line = (publicFixture('lines.json') as Page<Line>).results[0]
    expect(isLine({ ...line, position: 0, product: null, matching_status: 'unmatched', tax_rate: null })).toBe(true)
    expect(isLine({ ...line, product: null })).toBe(false)
    expect(isLine({ ...line, name_i18n: { ru: 1 } })).toBe(false)
    expect(isLine({ ...line, name_i18n: { fiscal: 'secret' } })).toBe(false)
    expect(isLine({ ...line, quantity: '2.00' })).toBe(false)
  })
  it('checks page arithmetic and bounded results without requiring a common DB snapshot', () => {
    const body = publicFixture('receipts.json') as Page<Receipt>
    const validate = page(isReceipt)
    expect(validate({ ...body, page_size: 201 })).toBe(false)
    expect(validate({ ...body, pages: 2 })).toBe(false)
    expect(validate({ ...body, results: [null] })).toBe(false)
    expect(validate({ count: 0, page: 1, page_size: 50, pages: 0, results: [] })).toBe(true)
    expect(validate({ ...body, results: [] })).toBe(true)
  })
  it('bounds review arrays and validates nested tax/discount data', () => {
    const image = publicFixture('receipt-image.json') as ReceiptImageDetail
    const result = image.normalized_result!
    expect(isReceiptImage({ ...image, normalized_result: { ...result, lines: Array(1001).fill(result.lines[0]) } })).toBe(false)
    expect(isReceiptImage({ ...image, normalized_result: { ...result, discounts: [{ position: 1, line_position: null, name: null, amount: '1.00' }], taxes: [{ tax_rate: { kind: 'exempt', rate: null }, tax_code: null, net: null, tax: '0.00', gross: null }] } })).toBe(true)
    expect(isReceiptImage({ ...image, normalized_result: { ...result, proposed_receipt: { ...result.proposed_receipt, store: { id: 1 } } } })).toBe(false)
  })
  it('requires the additive confirmed_at and proposed country and checks their types', () => {
    const image = publicFixture('receipt-image.json') as ReceiptImageDetail
    expect(image.confirmed_at).toBeNull(); expect(image.normalized_result?.proposed_receipt.country).toBe('DE')
    expect(isReceiptImageDetail({ ...image, confirmed_at: '2026-10-04T12:35:00Z' })).toBe(true)
    for (const confirmed_at of ['2026-10-04', '2026-10-04T12:35:00+02:00', 1, true]) expect(isReceiptImageDetail({ ...image, confirmed_at })).toBe(false)
    const result = image.normalized_result!
    const proposed = (patch: object) => ({ ...image, normalized_result: { ...result, proposed_receipt: { ...result.proposed_receipt, ...patch } } })
    expect(isReceiptImageDetail(proposed({ country: null }))).toBe(true)
    expect(isReceiptImageDetail(proposed({ country: 7 }))).toBe(false)
    const old: Record<string, unknown> = { ...result.proposed_receipt }
    delete old.country
    expect(isReceiptImageDetail({ ...image, normalized_result: { ...result, proposed_receipt: old } })).toBe(false)
    const list = publicFixture('receipt-images.json') as Page<ReceiptImageDetail>
    expect(list.results.every((item) => Object.hasOwn(item, 'confirmed_at'))).toBe(true)
  })
  it('accepts the confirmation answer only with a saved crop and a full job', () => {
    const body = publicFixture('review-confirmed.json') as ReviewConfirmResult
    expect(body.image).toMatchObject({ status: 'imported', receipt_id: 72, normalized_result: null, confirmed_at: '2026-10-04T12:35:00Z' })
    expect(body.job).toMatchObject({ status: 'succeeded', version: 2, review_required: false, actions: { can_retry: false } })
    const listJob: Record<string, unknown> = { ...body.job }
    delete listJob.items
    expect(isReviewConfirmResult({ ...body, job: listJob })).toBe(false)
    const listImage: Record<string, unknown> = { ...body.image }
    delete listImage.quad
    expect(isReviewConfirmResult({ ...body, image: listImage })).toBe(false)
    expect(isReviewConfirmResult({ ...body, image: { ...body.image, confirmed_at: 'now' } })).toBe(false)
  })
  describe('confirmation request body', () => {
    const body = () => structuredClone(publicFixture('review-confirm-request.json')) as ReviewConfirmInput
    const change = (edit: (value: ReviewConfirmInput) => void) => { const value = body(); edit(value); return value }
    it('keeps decimals as strings and allows the optional offset only', () => {
      expect(isReviewConfirmInput(change((value) => { value.receipt.utc_offset = '+02:00' }))).toBe(true)
      expect(isReviewConfirmInput(change((value) => { value.receipt.utc_offset = null }))).toBe(true)
      expect(isReviewConfirmInput(change((value) => { value.receipt.utc_offset = '2' }))).toBe(false)
      expect(isReviewConfirmInput({ ...body(), draft: true })).toBe(false)
      expect(isReviewConfirmInput(change((value) => { Object.assign(value.receipt, { discount_total: '0.20' }) }))).toBe(false)
      expect(isReviewConfirmInput(change((value) => { Object.assign(value.lines[0], { product_id: 61 }) }))).toBe(false)
      expect(isReviewConfirmInput(change((value) => { Object.assign(value.lines[0].tax_rate, { country: 'DE' }) }))).toBe(false)
    })
    it.each([
      (value: ReviewConfirmInput) => { Object.assign(value.receipt, { total: 2.63 }) }, (value: ReviewConfirmInput) => { value.receipt.total = '2.6' },
      (value: ReviewConfirmInput) => { value.receipt.purchased_on = '2026-02-30' }, (value: ReviewConfirmInput) => { value.receipt.local_time = '14.35' },
      (value: ReviewConfirmInput) => { value.receipt.country = 'DEU' }, (value: ReviewConfirmInput) => { value.receipt.store_name = '   ' },
      (value: ReviewConfirmInput) => { value.lines[0].quantity = '2' }, (value: ReviewConfirmInput) => { value.lines[0].unit_price = '-1.2900' },
      (value: ReviewConfirmInput) => { value.lines[0].position = 0 }, (value: ReviewConfirmInput) => { value.lines[0].name = '' },
      (value: ReviewConfirmInput) => { value.lines = [] }, (value: ReviewConfirmInput) => { value.discounts[0].amount = '0.2' },
      (value: ReviewConfirmInput) => { value.taxes[0].tax_rate.rate = '7' }, (value: ReviewConfirmInput) => { Object.assign(value.taxes[0], { net: 2.22 }) },
    ])('rejects a malformed value %#', (edit) => { expect(isReviewConfirmInput(change(edit))).toBe(false) })
  })
  it('reads review_invalid only together with well-formed causes and keeps other bodies generic', () => {
    const body = publicFixture('review-invalid.json') as { error: object; issues: object[] }
    expect(readError(409, body, true)).toEqual({ kind: 'error', reason: 'review_invalid', status: 409, issues: body.issues })
    expect(readError(409, { ...body, issues: [{ ...body.issues[0], severity: 'fatal' }] }, true).reason).toBe('invalid_response')
    expect(readError(409, { ...body, issues: 'none' }, true).reason).toBe('invalid_response')
    expect(readError(409, { ...body, issues: Array(1001).fill(body.issues[0]) }, true).reason).toBe('invalid_response')
    // The catalog transport and other statuses never learn the local codes.
    expect(readError(409, body, false).reason).toBe('invalid_response')
    expect(readError(400, body, true).reason).toBe('invalid_response')
    const fields = publicFixture('review-invalid-parameter.json')
    expect(readError(400, fields, true)).toEqual({ kind: 'error', reason: 'invalid_parameter', status: 400,
      fields: ['receipt.total', 'lines.0.quantity', 'lines.1.source_position', 'discounts.0.line_position', 'taxes.1.tax_rate.rate'] })
    for (const code of ['review_unavailable', 'review_resolved', 'review_busy', 'job_active']) {
      expect(readError(409, { error: { code, message: 'Текст сервера.' } }, true)).toEqual({ kind: 'error', reason: code, status: 409 })
      expect(readError(409, { error: { code, message: 'Текст сервера.' } }, false).reason).toBe('invalid_response')
    }
  })
  describe('issue reason/severity/context', () => {
    const image = publicFixture('receipt-image.json') as ReceiptImageDetail
    const legacy = { code: 'invalid_value', field: '/lines/0/tax_rate', message: 'Значение не прошло проверку.' }
    const full = issue('optional_omitted', 'warning', { entity: 'line', index: 0, position: 1, attribute: 'tax_rate' }, { field: '/lines/0/tax_rate' })
    const withContext = (patch: object) => ({ ...full, context: { ...full.context, ...patch } })
    it('accepts the old answer without the three keys and the complete new answer', () => {
      expect(isRecognitionIssue(legacy)).toBe(true)
      expect(isRecognitionIssue(full)).toBe(true)
      expect(image.issues[0]).toMatchObject({ reason: 'missing_required', severity: 'error', context: { entity: 'line', index: 0, position: 1, attribute: 'quantity' } })
      expect(isReceiptImageDetail({ ...image, issues: [legacy] })).toBe(true)
      expect(isReceiptImageDetail({ ...image, issues: taxEvidenceMissingIssues() })).toBe(true)
      expect(isRecognitionIssue(withContext({ entity: 'receipt', index: null, position: null, attribute: null }))).toBe(true)
      expect(isRecognitionIssue(withContext({ index: 9999, position: 32767 }))).toBe(true)
    })
    it.each([
      [{ reason: 'optional_omitted' }], [{ severity: 'warning' }], [{ context: full.context }],
      [{ reason: 'optional_omitted', severity: 'warning' }], [{ reason: 'optional_omitted', context: full.context }],
      [{ severity: 'warning', context: full.context }],
    ])('rejects the whole answer with a partial set of keys %#', (partial) => {
      expect(isRecognitionIssue({ ...legacy, ...partial })).toBe(false)
      expect(isReceiptImageDetail({ ...image, issues: [image.issues[0], { ...legacy, ...partial }] })).toBe(false)
    })
    it.each([
      [{ reason: null }], [{ reason: 7 }], [{ reason: '' }], [{ reason: 'Optional' }], [{ reason: 'tax-rate' }], [{ reason: 'a'.repeat(65) }],
      [{ severity: 'critical' }], [{ severity: null }], [{ severity: 'Error' }],
      [{ context: null }], [{ context: [] }], [{ context: 'line' }], [{ context: { entity: 'line', index: 0, position: 1 } }],
      [withContext({ entity: null })], [withContext({ entity: 'Line' })], [withContext({ entity: 'a'.repeat(33) })],
      [withContext({ attribute: 7 })], [withContext({ attribute: 'tax rate' })], [withContext({ attribute: '' })],
      [withContext({ index: -1 })], [withContext({ index: 10000 })], [withContext({ index: 1.5 })], [withContext({ index: '0' })],
      [withContext({ position: 0 })], [withContext({ position: 32768 })], [withContext({ position: 2.5 })], [withContext({ position: true })],
    ])('rejects wrong types and out-of-range values %#', (patch) => {
      expect(isRecognitionIssue({ ...full, ...patch })).toBe(false)
      expect(isReceiptImageDetail({ ...image, issues: [{ ...full, ...patch }] })).toBe(false)
    })
    it('accepts unlisted reason, entity and attribute slugs for display as unknown', () => {
      expect(isRecognitionIssue({ ...full, reason: 'future_reason' })).toBe(true)
      expect(isRecognitionIssue({ ...full, reason: 'a'.repeat(64) })).toBe(true)
      expect(isRecognitionIssue(withContext({ entity: 'payment' }))).toBe(true)
      expect(isRecognitionIssue(withContext({ attribute: 'loyalty_card' }))).toBe(true)
      expect(isRecognitionIssue(withContext({ attribute: null }))).toBe(true)
    })
    it('keeps the old code/field/message rules for the new answer', () => {
      expect(isRecognitionIssue({ ...full, code: 'optional_omitted' })).toBe(false)
      expect(isRecognitionIssue({ ...full, field: '/fiscal/signature' })).toBe(false)
      expect(isRecognitionIssue({ ...full, message: null })).toBe(false)
    })
  })
})
