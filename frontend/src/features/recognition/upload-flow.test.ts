import { describe, expect, it, vi } from 'vitest'
import type { PhotoUpload, RecognitionLimits } from '../../api/recognition'
import { isPhotoUpload, isRecognitionCsrf } from '../../api/recognition-schema'
import { publicFixture } from '../../api/recognition-test-support'
import type { LocalApiResult } from '../../api/types'
import type { Reduced } from './image-reduce'
import { uploadLabels, sizeText } from './labels'
import { createUpload, progressValue } from './upload-state'

const fixture = <T,>(name: string, guard: (value: unknown) => value is T) => {
  const value = publicFixture(name); if (!guard(value)) throw new Error('Invalid fixture'); return value
}
const limits = () => fixture('csrf.json', isRecognitionCsrf).limits
const photo = () => fixture('upload-new.json', isPhotoUpload)
const file = (bytes = 5, name = 'receipt.jpg') => new File([new Uint8Array(bytes)], name, { type: 'image/jpeg' })
const flush = async () => { for (let turn = 0; turn < 4; turn++) await Promise.resolve() }
type Send = (file: File, signal: AbortSignal, onProgress: (sent: number, total: number) => void) => Promise<LocalApiResult<PhotoUpload>>
type Reduce = (file: File, limits: RecognitionLimits, signal: AbortSignal) => Promise<Reduced>

/** A send that stays open: the test moves the progress and answers by hand. */
const openSend = () => {
  const calls: { file: File; signal: AbortSignal; progress: (sent: number, total: number) => void; answer: (result: LocalApiResult<PhotoUpload>) => void }[] = []
  const send = vi.fn<Send>((sent, signal, progress) => new Promise((answer) => { calls.push({ file: sent, signal, progress, answer }) }))
  return { send, calls }
}
const small = { width: 4032, height: 3024 }
const huge = { width: 12000, height: 9000 }
const copy = (name = 'receipt.jpg'): Reduced => ({ file: new File([new Uint8Array(3)], name, { type: 'image/jpeg' }), width: 4096, height: 3072 })

describe('progress of sending', () => {
  it('sends a photo within the limits as it is and follows the bytes to the wait for the answer', async () => {
    const { send, calls } = openSend()
    const reduce = vi.fn<Reduce>()
    const success = vi.fn()
    const upload = createUpload(send, vi.fn(), success, vi.fn(), reduce)
    const seen: unknown[] = []
    upload.subscribe(() => seen.push(upload.getSnapshot()))
    const original = file(1000)
    const pending = upload.submit(original, limits(), small)
    expect(reduce).not.toHaveBeenCalled()
    expect(calls[0].file).toBe(original)
    expect(upload.getSnapshot()).toEqual({ kind: 'sending', stage: 'uploading' })
    calls[0].progress(250, 1000)
    expect(upload.getSnapshot()).toEqual({ kind: 'sending', stage: 'uploading', sent: 250, total: 1000 })
    calls[0].progress(1000, 1000)
    expect(upload.getSnapshot()).toEqual({ kind: 'sending', stage: 'waiting', sent: 1000, total: 1000 })
    calls[0].answer({ kind: 'ok', data: photo() }); await pending
    expect(success).toHaveBeenCalledTimes(1)
    expect(seen.map((state) => (state as { kind: string }).kind)).toEqual(['sending', 'sending', 'sending', 'success'])
    // A late event of a finished request changes nothing.
    calls[0].progress(1000, 1000); expect(upload.getSnapshot().kind).toBe('success')
  })
  it('writes the bytes as one unbreakable value with one decimal', () => {
    expect(progressValue(2_202_010, 5_557_453)).toBe('2,1 из 5,3 МиБ')
    expect(progressValue(0, 1_048_576)).toBe('0,0 из 1,0 МиБ')
    expect(progressValue(9_999_999, 1_048_576)).toBe('1,0 из 1,0 МиБ')
    expect(sizeText({ width: 4096, height: 3072 })).toBe('4096 × 3072')
  })
})

describe('stopping the sending', () => {
  it('aborts the request, says what is known and never replays; the same photo goes again on demand', async () => {
    const { send, calls } = openSend()
    const success = vi.fn()
    const upload = createUpload(send, vi.fn(), success, vi.fn(), vi.fn<Reduce>())
    const original = file()
    const first = upload.submit(original, limits(), small)
    calls[0].progress(2, 5)
    upload.cancel()
    expect(calls[0].signal.aborted).toBe(true)
    expect(upload.getSnapshot()).toEqual({ kind: 'cancelled', message: 'Отправка остановлена. Если фото успело дойти, задание появится в „Обработке“.' })
    // The stopped request answers late, with either result: neither reaches the screen.
    calls[0].progress(5, 5); calls[0].answer({ kind: 'ok', data: photo() }); await first; await flush()
    expect(success).not.toHaveBeenCalled(); expect(upload.getSnapshot().kind).toBe('cancelled')
    expect(send).toHaveBeenCalledTimes(1)

    const second = upload.submit(original, limits(), small)
    expect(send).toHaveBeenCalledTimes(2); expect(calls[1].file).toBe(original); expect(calls[1].signal.aborted).toBe(false)
    expect(upload.getSnapshot()).toEqual({ kind: 'sending', stage: 'uploading' })
    calls[1].answer({ kind: 'ok', data: photo() }); await second
    expect(success).toHaveBeenCalledTimes(1)
  })
  it('does nothing without a sending in flight', () => {
    const upload = createUpload(vi.fn<Send>(), vi.fn(), vi.fn(), vi.fn())
    const listener = vi.fn(); upload.subscribe(listener)
    upload.cancel()
    expect(listener).not.toHaveBeenCalled(); expect(upload.getSnapshot()).toEqual({ kind: 'idle' })
  })
  it('has no automatic repeat after a lost answer: one request per press', async () => {
    const send = vi.fn<Send>().mockResolvedValue({ kind: 'error', reason: 'network' })
    const upload = createUpload(send, vi.fn(), vi.fn(), vi.fn())
    await upload.submit(file(), limits(), small); await flush()
    expect(send).toHaveBeenCalledTimes(1)
    expect(upload.getSnapshot()).toMatchObject({ kind: 'error', message: expect.stringContaining('могло выполниться') })
  })
})

describe('a photo over a limit', () => {
  it.each([
    ['pixels', () => file(5), huge],
    ['bytes', () => file(limits().max_bytes + 1), small],
    ['bytes, with an unknown pixel size', () => file(limits().max_bytes + 1), undefined],
  ])('is reduced before sending when it is over by %s, and the copy is what goes', async (_name, make, size) => {
    const { send, calls } = openSend()
    const made = copy()
    const reduce = vi.fn<Reduce>().mockResolvedValue(made)
    const upload = createUpload(send, vi.fn(), vi.fn(), vi.fn(), reduce)
    const original = make()
    const pending = upload.submit(original, limits(), size)
    expect(upload.getSnapshot()).toEqual({ kind: 'sending', stage: 'reducing' })
    expect(send).not.toHaveBeenCalled()
    await flush()
    expect(reduce).toHaveBeenCalledExactlyOnceWith(original, limits(), expect.any(AbortSignal))
    expect(calls[0].file).toBe(made.file)
    expect(upload.getSnapshot()).toEqual({ kind: 'sending', stage: 'uploading', reduced: { ...made, source: original } })
    calls[0].answer({ kind: 'ok', data: photo() }); await pending
    expect(upload.getSnapshot()).toMatchObject({ kind: 'success', reduced: { width: 4096, height: 3072 } })
  })
  it('keeps the copy and sends the very same file on a repeat, without encoding again', async () => {
    const send = vi.fn<Send>().mockResolvedValueOnce({ kind: 'error', reason: 'timeout' }).mockResolvedValue({ kind: 'ok', data: photo() })
    const made = copy()
    const reduce = vi.fn<Reduce>().mockResolvedValue(made)
    const upload = createUpload(send, vi.fn(), vi.fn(), vi.fn(), reduce)
    const original = file(5)
    await upload.submit(original, limits(), huge)
    expect(upload.getSnapshot()).toMatchObject({ kind: 'error', reduced: { file: made.file, source: original } })
    await upload.submit(original, limits(), huge)
    expect(reduce).toHaveBeenCalledTimes(1)
    expect(send).toHaveBeenCalledTimes(2)
    expect(send.mock.calls[0][0]).toBe(made.file); expect(send.mock.calls[1][0]).toBe(made.file)
  })
  it('repeats with the same copy after a stop and after a refreshed token', async () => {
    const { send, calls } = openSend()
    const made = copy()
    const reduce = vi.fn<Reduce>().mockResolvedValue(made)
    const refresh = vi.fn().mockResolvedValue({ kind: 'ok', data: fixture('csrf.json', isRecognitionCsrf) })
    const upload = createUpload(send, refresh, vi.fn(), vi.fn(), reduce)
    const original = file(5)
    void upload.submit(original, limits(), huge); await flush()
    upload.cancel()
    expect(upload.getSnapshot()).toMatchObject({ kind: 'cancelled', message: uploadLabels.cancelled, reduced: { file: made.file } })
    const second = upload.submit(original, limits(), huge); await flush()
    expect(calls[1].file).toBe(made.file)
    calls[1].answer({ kind: 'error', reason: 'csrf_failed', status: 403 }); await second
    expect(upload.getSnapshot()).toMatchObject({ kind: 'error', csrfRefreshed: true, reduced: { file: made.file } })
    void upload.submit(original, limits(), huge); await flush()
    expect(calls[2].file).toBe(made.file)
    expect(reduce).toHaveBeenCalledTimes(1)
  })
  it('forgets the copy with another photo', async () => {
    const send = vi.fn<Send>().mockResolvedValue({ kind: 'error', reason: 'network' })
    const reduce = vi.fn<Reduce>().mockImplementation(async (source) => copy(source.name))
    const upload = createUpload(send, vi.fn(), vi.fn(), vi.fn(), reduce)
    await upload.submit(file(5, 'first.jpg'), limits(), huge)
    upload.reset()
    expect(upload.getSnapshot()).toEqual({ kind: 'idle' })
    const other = file(5, 'second.jpg')
    await upload.submit(other, limits(), small)
    expect(reduce).toHaveBeenCalledTimes(1); expect(send.mock.calls[1][0]).toBe(other)
    // Even without a reset, a copy of one photo never goes instead of another.
    const third = file(5, 'third.jpg')
    await upload.submit(file(5, 'fourth.jpg'), limits(), huge); await upload.submit(third, limits(), small)
    expect(send.mock.calls[3][0]).toBe(third); expect(upload.getSnapshot().reduced).toBeUndefined()
  })
  it('says how to shoot again when the photo cannot be reduced, and sends nothing', async () => {
    const send = vi.fn<Send>()
    const reduce = vi.fn<Reduce>().mockRejectedValueOnce(new Error('memory')).mockResolvedValue(copy())
    const upload = createUpload(send, vi.fn(), vi.fn(), vi.fn(), reduce)
    const original = file(5)
    await upload.submit(original, limits(), huge)
    expect(upload.getSnapshot()).toEqual({ kind: 'error', message: 'Не удалось уменьшить фото на этом устройстве. Снимите чек с меньшим разрешением камеры и выберите фото заново.' })
    expect(send).not.toHaveBeenCalled()
    // Nothing is kept from a failure: the next press tries again.
    send.mockResolvedValue({ kind: 'ok', data: photo() })
    await upload.submit(original, limits(), huge)
    expect(reduce).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledTimes(1)
  })
  it('refuses a copy that no longer passes the limits instead of sending it', async () => {
    const send = vi.fn<Send>().mockResolvedValue({ kind: 'error', reason: 'network' })
    const upload = createUpload(send, vi.fn(), vi.fn(), vi.fn(), vi.fn<Reduce>().mockResolvedValue(copy()))
    const original = file(5)
    await upload.submit(original, limits(), huge)
    await upload.submit(original, { ...limits(), max_bytes: 2 }, huge)
    expect(send).toHaveBeenCalledTimes(1)
    expect(upload.getSnapshot()).toMatchObject({ kind: 'error', message: uploadLabels.reduceFailed })
  })
  it('stops during the reduction without sending and says so', async () => {
    let finish!: (value: Reduced) => void
    let signal!: AbortSignal
    const reduce = vi.fn<Reduce>((_file, _limits, current) => { signal = current; return new Promise((resolve) => { finish = resolve }) })
    const send = vi.fn<Send>()
    const upload = createUpload(send, vi.fn(), vi.fn(), vi.fn(), reduce)
    const pending = upload.submit(file(5), limits(), huge)
    upload.cancel()
    expect(signal.aborted).toBe(true)
    expect(upload.getSnapshot()).toEqual({ kind: 'cancelled', message: 'Подготовка фото остановлена. Фото не отправлялось.' })
    finish(copy()); await pending; await flush()
    expect(send).not.toHaveBeenCalled(); expect(upload.getSnapshot().reduced).toBeUndefined()
  })
  it('keeps the former refusal where nothing can reduce', async () => {
    const send = vi.fn<Send>()
    const upload = createUpload(send, vi.fn(), vi.fn(), vi.fn())
    await upload.submit(file(limits().max_bytes + 1), limits())
    expect(upload.getSnapshot()).toMatchObject({ kind: 'error', message: expect.stringContaining('слишком большой') })
    await upload.submit(file(5), limits(), huge)
    expect(upload.getSnapshot()).toMatchObject({ kind: 'error', message: expect.stringContaining('Разрешение фото превышает лимит') })
    expect(send).not.toHaveBeenCalled()
  })
})
