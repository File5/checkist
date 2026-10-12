import { describe, expect, it, vi } from 'vitest'
import type { PhotoUpload, RecognitionLimits } from '../../api/recognition'
import { isPhotoUpload, isRecognitionCsrf } from '../../api/recognition-schema'
import { publicFixture } from '../../api/recognition-test-support'
import type { LocalApiResult } from '../../api/types'
import type { Reduced } from './image-reduce'
import { errorText } from './labels'
import { createUpload, fileFormat, formatName, isPdf, pdfPageCount, pdfSummary, validateFile } from './upload-state'

const fixture = <T,>(name: string, guard: (value: unknown) => value is T) => {
  const value = publicFixture(name); if (!guard(value)) throw new Error('Invalid fixture'); return value
}
const limits = () => fixture('csrf.json', isRecognitionCsrf).limits
type Send = (file: File, signal: AbortSignal, onProgress: (sent: number, total: number) => void) => Promise<LocalApiResult<PhotoUpload>>
type Reduce = (file: File, limits: RecognitionLimits, signal: AbortSignal) => Promise<Reduced>
const flush = async () => { for (let turn = 0; turn < 4; turn++) await Promise.resolve() }
const pdf = (bytes: number, name = 'Квитанция.pdf') => new File([new Uint8Array(bytes)], name, { type: 'application/pdf' })
/** Two page objects, the second saved twice by an incremental update; a /Pages tree that is not a page. */
const BILL = [
  '%PDF-1.7', '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj', '2 0 obj << /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >> endobj',
  '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] >>\nendobj', '4 0 obj << /Parent 2 0 R /Type/Page >> endobj',
  '4 0 obj << /Parent 2 0 R /Type /Page /Annots [] >> endobj', '%%EOF',
].join('\n')

describe('PDF on the upload screen', () => {
  it('is a format of its own, picked by extension or type and named PDF', () => {
    const server = limits()
    expect(server.formats).toContain('application/pdf'); expect(server.max_pdf_pages).toBe(3)
    expect(fileFormat({ name: 'bill.PDF' })).toBe('application/pdf')
    expect(fileFormat({ name: 'download', type: 'application/pdf' })).toBe('application/pdf')
    expect([isPdf({ name: 'a.pdf' }), isPdf({ name: 'a.jpg', type: 'application/pdf' }), isPdf({ name: 'a.png' })]).toEqual([true, false, false])
    expect(server.formats.map(formatName)).toEqual(['JPEG', 'PNG', 'WEBP', 'HEIC', 'HEIF', 'PDF'])
    expect(validateFile({ name: 'bill.pdf', size: server.max_bytes }, server)).toBeUndefined()
  })
  it('counts the page objects once each, and says nothing when they cannot be told', () => {
    expect(pdfPageCount(BILL)).toBe(2)
    expect(pdfPageCount('%PDF-1.7\n1 0 obj << /Type /ObjStm /N 5 /Length 900 >> stream ... endstream endobj')).toBeNull()
    expect(pdfPageCount('')).toBeNull()
    expect(pdfSummary(2)).toBe('PDF, 2 стр.')
    expect(pdfSummary(null)).toBe('PDF')
  })
  it('sends a PDF as it is, never reducing it, even when the bytes alone would ask for a reduction', async () => {
    const send = vi.fn<Send>(async () => ({ kind: 'ok', data: fixture('upload-new.json', isPhotoUpload) }))
    const reduce = vi.fn<Reduce>()
    const success = vi.fn()
    const upload = createUpload(send, vi.fn(), success, vi.fn(), reduce)
    const bill = pdf(1000)
    await upload.submit(bill, { ...limits(), max_pixels: 1 })
    await flush()
    expect(reduce).not.toHaveBeenCalled()
    expect(send.mock.calls[0][0]).toBe(bill)
    expect(success).toHaveBeenCalledOnce()
  })
  it('refuses a PDF over the bytes before sending', async () => {
    const send = vi.fn<Send>()
    const reduce = vi.fn<Reduce>()
    const upload = createUpload(send, vi.fn(), vi.fn(), vi.fn(), reduce)
    await upload.submit(pdf(11), { ...limits(), max_bytes: 10 })
    expect(send).not.toHaveBeenCalled(); expect(reduce).not.toHaveBeenCalled()
    expect(upload.getSnapshot()).toMatchObject({ kind: 'error', message: expect.stringContaining('слишком большой') })
  })
  it('explains every refusal of a PDF by the server in its own words', () => {
    const texts = (['invalid_pdf', 'pdf_encrypted', 'pdf_too_many_pages'] as const).map((reason) => errorText({ kind: 'error', reason }))
    expect(texts[0]).toContain('не удалось прочитать'); expect(texts[1]).toContain('паролем'); expect(texts[2]).toContain('3 страниц')
    expect(new Set(texts).size).toBe(3)
  })
})
