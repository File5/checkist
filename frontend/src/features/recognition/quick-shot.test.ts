import { afterEach, describe, expect, it, vi } from 'vitest'
import type { RecognitionLimits } from '../../api/recognition-types'
import { navigate } from '../../navigation'
import { clearQuickShot, galleryAccept, handOver, onQuickShot, peekQuickShot, setQuickShot } from './quick-shot'
import { autoSendStep, pickAccept } from './upload-state'

vi.mock('../../navigation', () => ({ navigate: vi.fn() }))

const shot = (name: string) => new File(['x'], name, { type: 'image/jpeg' })

describe('quick shot hand-over', () => {
  afterEach(clearQuickShot)

  it('keeps the shot for the upload page that is not open yet', () => {
    const file = shot('a.jpg')
    expect(setQuickShot(file)).toBe(false)
    expect(peekQuickShot()).toBe(file)
  })

  it('gives a shot to the open upload page at once and keeps nothing stale', () => {
    const take = vi.fn()
    const stop = onQuickShot(take)
    const file = shot('b.jpg')
    expect(setQuickShot(file)).toBe(true)
    expect(take).toHaveBeenCalledWith(file)
    expect(peekQuickShot()).toBeUndefined()
    stop()
    expect(setQuickShot(shot('c.jpg'))).toBe(false)
    expect(take).toHaveBeenCalledTimes(1)
  })

  it('an old unsubscribe does not remove a newer page', () => {
    const first = vi.fn(), second = vi.fn()
    const stopFirst = onQuickShot(first)
    const stopSecond = onQuickShot(second)
    stopFirst()
    expect(setQuickShot(shot('d.jpg'))).toBe(true)
    expect(second).toHaveBeenCalledTimes(1)
    expect(first).not.toHaveBeenCalled()
    stopSecond()
  })
})

describe('«Из галереи» hands over like «Снять чек»', () => {
  afterEach(() => { clearQuickShot(); vi.mocked(navigate).mockClear() })
  const pdf = new File(['%PDF-1.7'], 'Счёт.pdf', { type: 'application/pdf' })
  const limits: RecognitionLimits = { formats: ['image/jpeg', 'application/pdf'], max_bytes: 100, max_pixels: 100, max_receipts: 1, max_pdf_pages: 3 }

  it('opens the upload page with the chosen file waiting there', () => {
    handOver(pdf)
    expect(peekQuickShot()).toBe(pdf)
    expect(navigate).toHaveBeenCalledExactlyOnceWith('/receipts/upload')
  })

  it('gives the file to the open upload page without navigating', () => {
    const take = vi.fn()
    const stop = onQuickShot(take)
    handOver(shot('gallery.jpg'))
    expect(take).toHaveBeenCalledTimes(1)
    expect(navigate).not.toHaveBeenCalled()
    stop()
  })

  it('accepts photos of any type and PDF bills, and a PDF goes by itself: nothing to measure', () => {
    expect(galleryAccept).toBe('image/*,.heic,.heif,application/pdf')
    // The upload page checks the same file against the server list; its own picker accepts PDF too.
    expect(pickAccept).toContain('application/pdf')
    expect(autoSendStep({ file: pdf, pending: pdf, limits, measuring: false, refreshing: false, idle: true })).toBe('send')
  })
})
