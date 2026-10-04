import { readdirSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { isJob, isJobDetail, isPhoto, isPhotoUpload, isReceiptImage, isReceiptImageDetail, isRecognitionCsrf } from './recognition-schema'
import { isDiscount, isLine, isReceipt, isTax } from './receipts-schema'
import { page } from './schema'
import { publicFixture } from './recognition-test-support'
import type { JobDetail, ReceiptImageDetail } from './recognition-types'
import type { Line, Receipt } from './receipts-types'
import type { Page } from './types'

const schemas: Record<string, (value: unknown) => boolean> = {
  'csrf.json': isRecognitionCsrf, 'photo.json': isPhoto, 'photos.json': page(isPhoto),
  'job.json': isJobDetail, 'jobs.json': page(isJob), 'job-running.json': isJobDetail, 'job-cancel-requested.json': isJobDetail,
  'receipt-image.json': isReceiptImageDetail, 'receipt-images.json': page(isReceiptImage),
  'upload-new.json': isPhotoUpload, 'upload-reused.json': isPhotoUpload,
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
})
