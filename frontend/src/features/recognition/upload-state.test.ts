import { describe, expect, it, vi } from 'vitest'
import type { PhotoUpload } from '../../api/recognition'
import { isPhotoUpload, isRecognitionCsrf } from '../../api/recognition-schema'
import { publicFixture } from '../../api/recognition-test-support'
import type { LocalApiResult } from '../../api/types'
import { errorText } from './labels'
import { createPreview } from './preview'
import { createUpload, getJobNotice, setJobNotice, uploadMessage, validateFile } from './upload-state'

const fixture = <T,>(name: string, guard: (value: unknown) => value is T) => {
  const value = publicFixture(name); if (!guard(value)) throw new Error('Invalid fixture'); return value
}
const csrf = () => fixture('csrf.json', isRecognitionCsrf)
const photo = (reused = false) => fixture(reused ? 'upload-reused.json' : 'upload-new.json', isPhotoUpload)
const file = () => new File(['image'], 'receipt.PNG', { type: 'image/png' })
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

describe('upload and object URL lifecycle', () => {
  it('accepts the exact server size limit and rejects one byte over, empty and unsupported files', () => {
    const limits = csrf().limits
    expect(validateFile({ name: 'Фото.JPEG', size: limits.max_bytes }, limits)).toBeUndefined()
    expect(validateFile({ name: 'photo.png', size: limits.max_bytes + 1 }, limits)).toContain('слишком большой')
    expect(validateFile({ name: 'photo.png', size: 0 }, limits)).toContain('пуст')
    for (const name of ['photo.HEIC', 'photo.gif', 'photo.pdf', 'photo']) expect(validateFile({ name, size: 2 }, limits)).toContain('JPEG или PNG')
    expect(validateFile({ name: 'photo.webp', size: 2 }, { ...limits, formats: ['image/png'] })).toContain('не поддерживается')
  })
  it('does not send a file failing client validation', async () => {
    const send = vi.fn()
    const upload = createUpload(send, vi.fn(), vi.fn(), vi.fn())
    await upload.submit(new File(['x'], 'bad.heic'), csrf().limits)
    expect(send).not.toHaveBeenCalled(); expect(upload.getSnapshot().kind).toBe('error')
  })
  it.each([false, true])('handles the full public success reused=%s and passes the server job to navigation', async (reused) => {
    const response = photo(reused)
    const success = vi.fn()
    const upload = createUpload(async () => ({ kind: 'ok', data: response }), vi.fn(), success, vi.fn())
    await upload.submit(file(), csrf().limits)
    expect(success).toHaveBeenCalledExactlyOnceWith(response)
    expect(upload.getSnapshot()).toMatchObject({ kind: 'success', data: response })
    expect(uploadMessage(response)).toContain(reused ? 'уже было загружено' : 'Задание принято')
    if (reused) expect(uploadMessage(response)).toContain('последнее задание этого фото')
  })
  it('refreshes CSRF once and requires an explicit second submit, carrying updated limits', async () => {
    const send = vi.fn<(file: File, signal: AbortSignal) => Promise<LocalApiResult<PhotoUpload>>>()
      .mockResolvedValueOnce({ kind: 'error', reason: 'csrf_failed', status: 403 }).mockResolvedValue({ kind: 'ok', data: photo() })
    const refresh = vi.fn().mockResolvedValue({ kind: 'ok', data: csrf() })
    const limitsChanged = vi.fn()
    const upload = createUpload(send, refresh, vi.fn(), limitsChanged)
    await upload.submit(file(), csrf().limits)
    expect(send).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1)
    expect(limitsChanged).toHaveBeenCalledExactlyOnceWith(csrf())
    expect(upload.getSnapshot()).toMatchObject({ kind: 'error', csrfRefreshed: true })
    await upload.submit(file(), csrf().limits); expect(send).toHaveBeenCalledTimes(2)
  })
  it('reports a failed CSRF refresh without replaying the upload', async () => {
    const send = vi.fn().mockResolvedValue({ kind: 'error', reason: 'csrf_failed' })
    const upload = createUpload(send, async () => ({ kind: 'error', reason: 'network' }), vi.fn(), vi.fn())
    await upload.submit(file(), csrf().limits)
    expect(upload.getSnapshot()).toMatchObject({ kind: 'error', csrfRefreshed: false, message: expect.stringContaining('Не удалось обновить') })
    expect(send).toHaveBeenCalledTimes(1)
  })
  it('prevents double submit and ignores a late success after replacement/unmount', async () => {
    let resolve!: (value: LocalApiResult<PhotoUpload>) => void
    let signal!: AbortSignal
    const send = vi.fn((_file: File, current: AbortSignal) => { signal = current; return new Promise<LocalApiResult<PhotoUpload>>((yes) => { resolve = yes }) })
    const success = vi.fn()
    const upload = createUpload(send, vi.fn(), success, vi.fn())
    const pending = upload.submit(file(), csrf().limits)
    await upload.submit(file(), csrf().limits)
    expect(send).toHaveBeenCalledTimes(1); expect(upload.getSnapshot().kind).toBe('sending')
    upload.dispose(); expect(signal.aborted).toBe(true)
    resolve({ kind: 'ok', data: photo() }); await pending; await flush()
    expect(success).not.toHaveBeenCalled(); expect(upload.getSnapshot().kind).toBe('idle')
  })
  it.each(['unsupported_format', 'upload_too_large', 'invalid_image', 'image_too_large', 'permission_denied', 'storage_unavailable', 'network', 'timeout'] as const)('translates server upload error %s safely', async (reason) => {
    const upload = createUpload(async () => ({ kind: 'error', reason }), vi.fn(), vi.fn(), vi.fn())
    await upload.submit(file(), csrf().limits)
    expect(upload.getSnapshot()).toMatchObject({ kind: 'error', message: errorText({ kind: 'error', reason }, true) })
  })
  it('warns about uncertain upload result and executor availability without blocking', () => {
    expect(errorText({ kind: 'error', reason: 'timeout' }, true)).toContain('могло выполниться')
    const response = photo(); response.job.executor.available = false
    expect(uploadMessage(response)).toContain('ждать в очереди')
    setJobNotice(response.job.id, uploadMessage(response))
    expect(getJobNotice(response.job.id)).toBe(uploadMessage(response))
    expect(getJobNotice(response.job.id + 1)).toBeUndefined()
  })
  it('creates URLs only on mount, revokes on cleanup/replacement and supports StrictMode', () => {
    const urls = { createObjectURL: vi.fn().mockReturnValueOnce('blob:first').mockReturnValueOnce('blob:second'), revokeObjectURL: vi.fn() }
    const preview = createPreview(file(), urls)
    expect(urls.createObjectURL).not.toHaveBeenCalled()
    preview.start(); preview.start(); expect(urls.createObjectURL).toHaveBeenCalledTimes(1)
    preview.dispose(); preview.dispose(); expect(urls.revokeObjectURL).toHaveBeenCalledExactlyOnceWith('blob:first')
    preview.start(); expect(preview.getSnapshot()).toBe('blob:second'); preview.dispose()
    expect(urls.revokeObjectURL).toHaveBeenCalledTimes(2)
  })
})
