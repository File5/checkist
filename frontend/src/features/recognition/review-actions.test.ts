import { describe, expect, it, vi } from 'vitest'
import { readError } from '../../api/http'
import type { JobDetail, ReviewConfirmInput, ReviewConfirmResult } from '../../api/recognition'
import { isJobDetail, isRecognitionCsrf, isReviewConfirmResult } from '../../api/recognition-schema'
import { publicFixture } from '../../api/recognition-test-support'
import type { LocalApiFailure, LocalApiResult } from '../../api/types'
import { acceptJob, isActive, reviewErrorText, reviewKeepsState } from './labels'
import { createPollingRequest } from './polling'
import { createReviewActions, rememberConfirmed } from './review-actions'
import type { ConfirmedCrops } from './review-actions'

function confirmed(): ReviewConfirmResult { const data = publicFixture('review-confirmed.json'); if (!isReviewConfirmResult(data)) throw new Error('Invalid fixture'); return data }
function job(): JobDetail { const data = publicFixture('job.json'); if (!isJobDetail(data)) throw new Error('Invalid fixture'); return data }
function csrf() { const data = publicFixture('csrf.json'); if (!isRecognitionCsrf(data)) throw new Error('Invalid fixture'); return data }
const input = publicFixture('review-confirm-request.json') as ReviewConfirmInput
const lifecycle = () => ({ pause: vi.fn(), success: vi.fn(), failure: vi.fn() })
const failing = (error: LocalApiFailure) => async (): Promise<LocalApiResult<ReviewConfirmResult>> => error
const flush = async () => { await Promise.resolve(); await Promise.resolve() }

describe('crop confirmation state machine', () => {
  it('sends one POST, ignores presses while waiting and reports the saved receipt', async () => {
    let resolve!: (value: LocalApiResult<ReviewConfirmResult>) => void
    const confirm = vi.fn(() => new Promise<LocalApiResult<ReviewConfirmResult>>((yes) => { resolve = yes }))
    const life = lifecycle()
    const actions = createReviewActions(confirm, vi.fn(), life)
    const pending = actions.run(42, input)
    expect(await actions.run(42, input)).toBeUndefined(); expect(await actions.run(41, input)).toBeUndefined()
    expect(confirm).toHaveBeenCalledExactlyOnceWith(42, input, expect.any(AbortSignal))
    expect(actions.getSnapshot()).toEqual({ kind: 'pending', imageId: 42 }); expect(life.pause).toHaveBeenCalledTimes(1)
    expect(life.success).not.toHaveBeenCalled()
    resolve({ kind: 'ok', data: confirmed() })
    expect(await pending).toBeUndefined()
    expect(life.success).toHaveBeenCalledExactlyOnceWith(confirmed()); expect(life.failure).not.toHaveBeenCalled()
    expect(actions.getSnapshot()).toEqual({ kind: 'done', imageId: 42, image: confirmed().image, message: 'Подтверждено. Чек\u00a0№72 сохранён.' })
    expect(actions.getServerSnapshot()).toEqual({ kind: 'idle' })
  })
  it.each([
    ['reused', 'привязана к уже сохранённому чеку\u00a0№72: его значения не изменены, исправления к нему не применены'],
    ['updated', 'дополнены только его пустые поля, заполненные значения не изменены'],
  ] as const)('says plainly that corrections were not applied to an existing receipt (%s)', async (status, text) => {
    const data = { ...confirmed(), image: { ...confirmed().image, status } }
    const actions = createReviewActions(async () => ({ kind: 'ok', data }), vi.fn(), lifecycle())
    await actions.run(42, input)
    expect(actions.getSnapshot()).toMatchObject({ kind: 'done', message: expect.stringContaining(text) })
  })
  it('keeps the form after review_invalid: no reread, the causes go back to the caller', async () => {
    const error = readError(409, publicFixture('review-invalid.json'), true)
    const life = lifecycle()
    const actions = createReviewActions(failing(error), vi.fn(), life)
    expect(await actions.run(42, input)).toBe(error)
    expect(error.issues).toHaveLength(3)
    expect(life.failure).toHaveBeenCalledExactlyOnceWith(error, false); expect(life.success).not.toHaveBeenCalled()
    expect(actions.getSnapshot()).toMatchObject({ kind: 'failed', imageId: 42, error, message: expect.stringContaining('не прошли проверку, чек не сохранён') })
    expect(JSON.stringify(actions.getSnapshot())).toContain('Исправленные данные не прошли проверку, чек не сохранён')
  })
  it('keeps the form after invalid_parameter and names the marked fields', async () => {
    const error = readError(400, publicFixture('review-invalid-parameter.json'), true)
    const life = lifecycle()
    const actions = createReviewActions(failing(error), vi.fn(), life)
    expect(await actions.run(42, input)).toBe(error)
    expect(life.failure).toHaveBeenCalledExactlyOnceWith(error, false)
    expect(actions.getSnapshot()).toMatchObject({ kind: 'failed', message: expect.stringContaining('Проверьте отмеченные поля') })
  })
  it.each([
    ['review_resolved', 'уже подтверждён с другими данными'], ['review_unavailable', 'Подтверждение для этой вырезки недоступно'],
    ['review_busy', 'изменяются другой операцией'], ['job_active', 'Задание ещё не завершено'], ['not_found', 'Вырезка не найдена'],
  ] as const)('%s explains the refusal and asks for one reread of the saved state', async (reason, text) => {
    const error: LocalApiFailure = { kind: 'error', reason, status: reason === 'not_found' ? 404 : 409 }
    const life = lifecycle()
    const confirm = vi.fn(failing(error))
    const actions = createReviewActions(confirm, vi.fn(), life)
    expect(await actions.run(42, input)).toBe(error)
    expect(confirm).toHaveBeenCalledTimes(1); expect(life.failure).toHaveBeenCalledExactlyOnceWith(error, true)
    expect(actions.getSnapshot()).toMatchObject({ kind: 'failed', message: expect.stringContaining(text) })
  })
  it.each(['network', 'timeout', 'server', 'database_unavailable', 'invalid_response'] as const)('%s warns that the action may have happened and rereads without repeating', async (reason) => {
    const life = lifecycle()
    const confirm = vi.fn(failing({ kind: 'error', reason }))
    const actions = createReviewActions(confirm, vi.fn(), life)
    await actions.run(42, input)
    expect(confirm).toHaveBeenCalledTimes(1); expect(life.failure).toHaveBeenCalledExactlyOnceWith({ kind: 'error', reason }, true)
    expect(actions.getSnapshot()).toMatchObject({ kind: 'failed', message: expect.stringContaining('Действие могло выполниться: проверьте задание перед повтором.') })
  })
  it('treats a thrown transport error as a lost answer', async () => {
    const life = lifecycle()
    const actions = createReviewActions(async () => { throw new Error('socket') }, vi.fn(), life)
    expect(await actions.run(42, input)).toEqual({ kind: 'error', reason: 'network' })
    expect(life.failure).toHaveBeenCalledExactlyOnceWith({ kind: 'error', reason: 'network' }, true)
  })
  it.each([[true, 'Токен безопасности обновлён. Чек не сохранён, действие не повторялось'], [false, 'Не удалось обновить токен безопасности']] as const)(
    'refreshes CSRF (ok=%s) but never repeats the confirmation', async (ok, text) => {
      const confirm = vi.fn(failing({ kind: 'error', reason: 'csrf_failed', status: 403 }))
      const refresh = vi.fn().mockResolvedValue(ok ? { kind: 'ok', data: csrf() } : { kind: 'error', reason: 'network' })
      const life = lifecycle()
      const actions = createReviewActions(confirm, refresh, life)
      await actions.run(42, input)
      expect(confirm).toHaveBeenCalledTimes(1); expect(refresh).toHaveBeenCalledTimes(1)
      expect(life.failure).toHaveBeenCalledExactlyOnceWith({ kind: 'error', reason: 'csrf_failed', status: 403 }, false)
      expect(actions.getSnapshot()).toMatchObject({ kind: 'failed', message: expect.stringContaining(text) })
      // The next press is a new explicit attempt.
      await actions.run(42, input); expect(confirm).toHaveBeenCalledTimes(2)
    })
  it('allows a new attempt after a refusal and replaces the old message', async () => {
    const confirm = vi.fn<(id: number) => Promise<LocalApiResult<ReviewConfirmResult>>>()
      .mockResolvedValueOnce({ kind: 'error', reason: 'review_busy', status: 409 }).mockResolvedValueOnce({ kind: 'ok', data: confirmed() })
    const actions = createReviewActions(confirm, vi.fn(), lifecycle())
    await actions.run(42, input); expect(actions.getSnapshot().kind).toBe('failed')
    await actions.run(42, input); expect(actions.getSnapshot().kind).toBe('done')
  })
  it('aborts the request on leaving the page and ignores its late answer', async () => {
    let resolve!: (value: LocalApiResult<ReviewConfirmResult>) => void
    let signal!: AbortSignal
    const life = lifecycle()
    const actions = createReviewActions((_id, _input, current) => { signal = current; return new Promise((yes) => { resolve = yes }) }, vi.fn(), life)
    const pending = actions.run(42, input); actions.dispose(); expect(signal.aborted).toBe(true)
    resolve({ kind: 'ok', data: confirmed() })
    expect(await pending).toBeUndefined()
    expect(life.success).not.toHaveBeenCalled(); expect(life.failure).not.toHaveBeenCalled()
    expect(actions.getSnapshot()).toEqual({ kind: 'pending', imageId: 42 })
  })
  it('pauses the job read before the POST so that an older answer cannot hide the confirmed job', async () => {
    let resolve!: (value: LocalApiResult<JobDetail>) => void
    const request = createPollingRequest<JobDetail>(() => new Promise((yes) => { resolve = yes }), isActive, acceptJob)
    request.start()
    const actions = createReviewActions(async () => ({ kind: 'ok', data: confirmed() }), vi.fn(), {
      pause: request.pause, success: (result) => { request.setData(result.job); request.resume(false) }, failure: vi.fn(),
    })
    await actions.run(42, input); resolve({ kind: 'ok', data: job() }); await flush()
    expect(request.getSnapshot()).toMatchObject({ kind: 'ok', data: { status: 'succeeded', version: 2, progress: { review: 0, imported: 2 } } })
    // An older job version read later is not accepted over the answer of the confirmation.
    expect(acceptJob(confirmed().job, job())).toBe(false)
    actions.dispose(); request.dispose()
  })
  it.each([
    ['review_invalid', 409], ['invalid_parameter', 400], ['invalid_request', 400], ['csrf_failed', 403], ['permission_denied', 403],
  ] as const)('reads the crop list that the second confirmation interrupted, after its refusal without a reread (%s)', async (reason, status) => {
    type Crops = { id: number; status: string }[]
    const stale: Crops = [{ id: 41, status: 'needs_review' }, { id: 42, status: 'needs_review' }]
    const saved: Crops = [{ id: 41, status: 'imported' }, { id: 42, status: 'needs_review' }]
    const signals: AbortSignal[] = []
    const reads: ((value: LocalApiResult<Crops>) => void)[] = []
    const crops = createPollingRequest<Crops>((signal) => { signals.push(signal); return new Promise((yes) => { reads.push(yes) }) })
    const jobRead = vi.fn(async (): Promise<LocalApiResult<JobDetail>> => ({ kind: 'ok', data: job() }))
    const jobs = createPollingRequest<JobDetail>(jobRead, isActive, acceptJob)
    const kinds: string[] = []
    crops.start(); jobs.start(); reads[0]({ kind: 'ok', data: stale }); await flush()
    crops.subscribe(() => kinds.push(crops.getSnapshot().kind))
    let answer!: (value: LocalApiResult<ReviewConfirmResult>) => void
    const confirm = vi.fn(() => new Promise<LocalApiResult<ReviewConfirmResult>>((yes) => { answer = yes }))
    // The wiring of JobPage: both reads pause; a success reads the crops once, a refusal rereads only when the saved state may differ.
    const actions = createReviewActions(confirm, async () => ({ kind: 'ok', data: csrf() }), {
      pause: () => { jobs.pause(); crops.pause() },
      success: (result) => { jobs.setData(result.job); jobs.resume(false); crops.resume(true) },
      failure: (_error, reread) => { jobs.resume(reread); crops.resume(reread) },
    })
    const first = actions.run(41, input); answer({ kind: 'ok', data: confirmed() }); await first
    expect(signals).toHaveLength(2) // the list read after the success is in flight
    const second = actions.run(42, input)
    expect(signals[1].aborted).toBe(true); expect(signals).toHaveLength(2)
    answer({ kind: 'error', reason, status }); expect(await second).toMatchObject({ reason })
    expect(signals).toHaveLength(3); expect(signals[2].aborted).toBe(false)
    // The cancelled read answers late and is ignored; the new one brings the saved first crop.
    reads[1]({ kind: 'ok', data: stale }); reads[2]({ kind: 'ok', data: saved }); await flush()
    expect(crops.getSnapshot()).toEqual({ kind: 'ok', data: saved, refreshing: false })
    // The list never left `ok`: its cards stay mounted, so the form of crop 42 keeps what the person typed.
    expect(new Set(kinds)).toEqual(new Set(['ok']))
    // The job came with the answer of the first confirmation: no read of it is owed.
    expect(jobRead).toHaveBeenCalledTimes(1); expect(jobs.getSnapshot()).toMatchObject({ data: { version: 2 } })
    expect(confirm).toHaveBeenCalledTimes(2)
    actions.dispose(); crops.dispose(); jobs.dispose()
  })
  it('remembers every confirmed crop of the screen, so that the next confirmation does not show it as unconfirmed again', () => {
    const none: ConfirmedCrops = new Map()
    const image = confirmed().image
    expect(rememberConfirmed(none, { kind: 'idle' })).toBe(none); expect(rememberConfirmed(none, { kind: 'pending', imageId: 41 })).toBe(none)
    const first = rememberConfirmed(none, { kind: 'done', imageId: 41, image, message: '' })
    expect([...first]).toEqual([[41, image]]); expect(none.size).toBe(0)
    // The same answer is not stored twice: the component would otherwise render without end.
    expect(rememberConfirmed(first, { kind: 'done', imageId: 41, image, message: '' })).toBe(first)
    const error: LocalApiFailure = { kind: 'error', reason: 'review_invalid', status: 409 }
    expect(rememberConfirmed(first, { kind: 'pending', imageId: 42 })).toBe(first); expect(rememberConfirmed(first, { kind: 'failed', imageId: 42, error, message: '' })).toBe(first)
    expect([...rememberConfirmed(first, { kind: 'done', imageId: 42, image, message: '' }).keys()]).toEqual([41, 42])
  })
  it('does not read the crop list after a refusal without a reread when no read was interrupted', async () => {
    const load = vi.fn(async (): Promise<LocalApiResult<number>> => ({ kind: 'ok', data: 1 }))
    const crops = createPollingRequest<number>(load)
    crops.start(); await flush()
    const error = readError(409, publicFixture('review-invalid.json'), true)
    const actions = createReviewActions(failing(error), vi.fn(), { pause: crops.pause, success: vi.fn(), failure: (_error, reread) => crops.resume(reread) })
    await actions.run(42, input); await flush()
    expect(load).toHaveBeenCalledTimes(1)
    actions.dispose(); crops.dispose()
  })
  it('has a client text for every refusal of the contract and never rereads for a refusal that saved nothing', () => {
    const reasons = ['invalid_request', 'invalid_parameter', 'csrf_failed', 'permission_denied', 'not_found', 'job_active', 'review_unavailable', 'review_resolved',
      'review_busy', 'review_invalid', 'database_unavailable', 'server', 'method_not_allowed', 'not_acceptable', 'unsupported_media_type', 'network', 'timeout', 'invalid_response'] as const
    const texts = reasons.map((reason) => reviewErrorText({ kind: 'error', reason }))
    for (const text of texts) { expect(text.length).toBeGreaterThan(20); expect(text).not.toContain('undefined') }
    expect(new Set(texts.slice(0, 10)).size).toBe(10)
    expect(reasons.filter((reason) => reviewKeepsState({ kind: 'error', reason }))).toEqual(['invalid_request', 'invalid_parameter', 'csrf_failed', 'permission_denied', 'review_invalid'])
  })
})
