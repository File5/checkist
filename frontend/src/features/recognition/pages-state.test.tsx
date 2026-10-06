import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isJobDetail, isPhoto, isPhotoUpload, isReceiptImage, isRecognitionCsrf } from '../../api/recognition-schema'
import { publicFixture } from '../../api/recognition-test-support'
import type { ExecutorState, JobDetail, RecognitionCsrf } from '../../api/recognition'
import { jobStatuses } from '../../api/recognition-types'
import { JobPage, JobsPage, UploadPage } from './index'
import { StoreResults } from './ReviewForm'
import type { RequestState } from './polling'
import { getJobNotice, setJobNotice, uploadMessage } from './upload-state'

type Lifecycle = { success: (job: JobDetail, action: 'cancel' | 'retry') => void }
const mocked = vi.hoisted(() => ({
  states: [] as RequestState<unknown>[], active: [] as (((data: unknown) => boolean) | undefined)[],
  lifecycle: undefined as unknown, navigate: vi.fn(),
}))
vi.mock('./useRequest', () => ({ useRequest: (_load: unknown, active?: (data: unknown) => boolean) => {
  mocked.active.push(active)
  return { state: mocked.states.shift() ?? { kind: 'loading' }, request: { pause: vi.fn(), resume: vi.fn(), setData: vi.fn(), refresh: vi.fn(), queueRefresh: vi.fn(), subscribe: vi.fn(), getSnapshot: vi.fn() } }
} }))
vi.mock('./useJobActions', () => ({ useJobActions: (lifecycle: unknown) => { mocked.lifecycle = lifecycle; return { state: { kind: 'idle' }, run: vi.fn() } } }))
vi.mock('../../navigation', async (original) => ({ ...await original<typeof import('../../navigation')>(), navigate: mocked.navigate }))
const fixture = <T,>(name: string, guard: (value: unknown) => value is T) => {
  const value = publicFixture(name); if (!guard(value)) throw new Error('Invalid fixture'); return value
}
const success = <T,>(data: T): RequestState<T> => ({ kind: 'ok', data, refreshing: false })
beforeEach(() => { mocked.states = []; mocked.active = []; mocked.lifecycle = undefined; mocked.navigate.mockClear() })

const executor = (state: ExecutorState) => ({ available: state !== 'absent' && state !== 'unknown', state, last_seen_at: null })
const states = ['idle', 'busy', 'absent', 'unknown'] as const
const absentText = 'Воркер распознавания не запущен. Задание будет ждать в очереди, пока воркер не запустят.'
const uploadTexts: Record<ExecutorState, string | undefined> = {
  idle: 'Воркер распознавания запущен и ждёт заданий.',
  busy: 'Воркер распознавания сейчас обрабатывает задание. Новое фото встанет в очередь.',
  absent: absentText, unknown: undefined,
}
const queuedTexts: Record<ExecutorState, string | undefined> = {
  idle: undefined, busy: 'Воркер занят другим заданием. Это задание начнётся после него.', absent: absentText, unknown: undefined,
}
const workerNotes = [...new Set([...Object.values(uploadTexts), ...Object.values(queuedTexts)])].filter((text) => text !== undefined)
/** Lines about the executor only: stage «Ожидание воркера» and the stalled text are other messages. */
const noteCount = (html: string) => workerNotes.filter((text) => html.includes(text)).length
const queuedJob = (state: ExecutorState, patch: Partial<JobDetail> = {}): JobDetail => ({
  ...fixture('job-running.json', isJobDetail), status: 'queued', stage: 'waiting', started_at: null, heartbeat_at: null, executor: executor(state), ...patch,
})

describe('executor line by the current state (SSR)', () => {
  it.each(states)('upload page with the worker %s', (state) => {
    const csrf: RecognitionCsrf = { ...fixture('csrf.json', isRecognitionCsrf), executor: executor(state) }
    mocked.states = [success(csrf)]
    const html = renderToStaticMarkup(<UploadPage />)
    const text = uploadTexts[state]
    expect(noteCount(html)).toBe(text ? 1 : 0)
    if (text) expect(html).toContain(state === 'absent' ? `<p class="ck-rec-warning">${text}</p>` : `<p>${text}</p>`)
    expect(html).not.toMatch(/не обнаружен|неизвестна/)
    // Upload stays available in every state.
    expect(html).toContain('Обновить условия загрузки'); expect(html).not.toMatch(/id="recognition-file"[^>]*disabled/)
    expect(mocked.active[0]?.(csrf)).toBe(state === 'absent')
  })
  it('says nothing about the worker when the conditions are loading, failed or stale', () => {
    const csrf = fixture('csrf.json', isRecognitionCsrf)
    for (const state of [{ kind: 'loading' }, { kind: 'error', error: { kind: 'error', reason: 'network' } },
      { kind: 'ok', data: csrf, refreshing: false, refreshError: { kind: 'error', reason: 'network' } }] as RequestState<unknown>[]) {
      mocked.states = [state]
      const html = renderToStaticMarkup(<UploadPage />)
      expect(noteCount(html)).toBe(0)
      if (state.kind === 'error') { expect(html).toContain('Нет ответа сервера'); expect(html).toContain('Повторить') }
      if (state.kind === 'ok') { expect(html).toContain('Не удалось обновить условия'); expect(html).toContain('Обновить условия загрузки') }
    }
  })
  it.each(states)('queued job with the worker %s', (state) => {
    mocked.states = [success(queuedJob(state))]
    const html = renderToStaticMarkup(<JobPage jobId={31} />)
    const text = queuedTexts[state]
    expect(html).toContain('В очереди'); expect(noteCount(html)).toBe(text ? 1 : 0)
    if (text) expect(html).toContain(state === 'absent' ? `<p class="ck-rec-warning">${text}</p>` : `<p>${text}</p>`)
    expect(html).not.toMatch(/не обнаружен|неизвестна/)
  })
  it.each(jobStatuses.filter((status) => status !== 'queued').flatMap((status) => states.map((state) => [status, state] as const)))('job %s says nothing about the worker %s', (status, state) => {
    mocked.states = [success(queuedJob(state, { status, stage: status === 'running' ? 'recognize' : 'finished' }))]
    expect(noteCount(renderToStaticMarkup(<JobPage jobId={31} />))).toBe(0)
  })
  it('keeps the existing stalled text for a job whose worker disappeared, without the absent warning', () => {
    mocked.states = [success({ ...fixture('job-running.json', isJobDetail), stalled: true, executor: { available: false, state: 'absent' as const, last_seen_at: '2026-10-04T12:35:00Z' } })]
    const html = renderToStaticMarkup(<JobPage jobId={31} />)
    expect(html).toContain('Воркер давно не обновлял состояние'); expect(noteCount(html)).toBe(0)
  })
  it('hides the worker line of a stale queued snapshot and keeps the refresh error with retry', () => {
    mocked.states = [{ kind: 'ok', data: queuedJob('absent'), refreshing: false, refreshError: { kind: 'error', reason: 'network' } }]
    const html = renderToStaticMarkup(<JobPage jobId={31} />)
    expect(html).toContain('Не удалось обновить'); expect(html).toContain('Повторить обновление'); expect(noteCount(html)).toBe(0)
  })
  it.each(states)('upload and retry notices carry no worker text when it is %s; the line follows the fresh snapshot', (state) => {
    const upload = fixture('upload-new.json', isPhotoUpload)
    setJobNotice(31, uploadMessage({ ...upload, job: { ...upload.job, executor: executor(state) } }))
    mocked.states = [success(fixture('job-running.json', isJobDetail))]
    const running = renderToStaticMarkup(<JobPage jobId={31} />)
    expect(running).toContain('<p role="status" class="ck-rec-warning">Фото загружено. Задание принято.</p>')
    expect(running).toContain('Обрабатывается'); expect(noteCount(running)).toBe(0)

    const retried = queuedJob(state, { id: 32, retry_of: 31 });
    (mocked.lifecycle as Lifecycle).success(retried, 'retry')
    expect(getJobNotice(32)).toBe('Создано новое задание обработки.')
    expect(mocked.navigate).toHaveBeenCalledExactlyOnceWith({ kind: 'job', jobId: 32 })
    mocked.states = [success({ ...retried, status: 'running', stage: 'detect' })]
    const html = renderToStaticMarkup(<JobPage jobId={32} />)
    expect(html).toContain('<p role="status" class="ck-rec-warning">Создано новое задание обработки.</p>'); expect(noteCount(html)).toBe(0)
  })
})

describe('page block states with public API data (SSR)', () => {
  it('shows real limits and the absent worker warning, never the CSRF token', () => {
    const csrf = fixture('csrf.json', isRecognitionCsrf)
    mocked.states = [success(csrf)]
    const html = renderToStaticMarkup(<UploadPage />)
    expect(html).toContain('20 МиБ'); expect(html).toContain('40 000 000'); expect(html).toContain('JPEG, PNG, WEBP')
    expect(html).toContain('Воркер распознавания не запущен.'); expect(html).not.toContain(csrf.csrf_token)
    expect(html).toContain('Фото передаётся облачной модели')
  })
  it('shows a recoverable limits error without allowing upload', () => {
    mocked.states = [{ kind: 'error', error: { kind: 'error', reason: 'permission_denied' } }]
    const html = renderToStaticMarkup(<UploadPage />)
    expect(html).toContain('Локальный сервис недоступен'); expect(html).toContain('Повторить')
    expect(html).toMatch(/type="submit"[^>]*disabled=""/)
  })
  it('renders page links that preserve status and photo and detail links for shell focus return', () => {
    const job = fixture('job-running.json', isJobDetail)
    mocked.states = [success({ count: 3, page: 2, page_size: 1, pages: 3, results: [job] })]
    const html = renderToStaticMarkup(<JobsPage query={{ page: 2, page_size: 1, status: 'running', photo: job.photo_id }} />)
    expect(html).toContain('href="/recognition/jobs/31"'); expect(html).toContain('Фото №11')
    expect(html).toMatch(/href="\/recognition\/jobs\?[^"]*status=running[^"]*"/)
    expect(html).toContain('photo=11'); expect(html).toContain('page_size=1'); expect(html).toContain('aria-current="page"')
    expect(html).toContain('Обрабатывается'); expect(html).toContain('Отменить')
  })
  it('distinguishes no uploads from an empty filtered list', () => {
    const page = { count: 0, page: 1, page_size: 50, pages: 0, results: [] }
    mocked.states = [success(page)]
    expect(renderToStaticMarkup(<JobsPage query={{ page: 1 }} />)).toContain('Фото ещё не загружались')
    mocked.states = [success(page)]
    const filtered = renderToStaticMarkup(<JobsPage query={{ page: 1, status: 'failed' }} />)
    expect(filtered).toContain('По выбранным фильтрам заданий нет'); expect(filtered).toContain('Сбросить фильтры')
  })
  it('offers the first page after page_out_of_range, preserving filters', () => {
    mocked.states = [{ kind: 'error', error: { kind: 'error', reason: 'page_out_of_range' } }]
    const html = renderToStaticMarkup(<JobsPage query={{ page: 100, status: 'failed' }} />)
    expect(html).toContain('На первую страницу'); expect(html).toContain('href="/recognition/jobs?status=failed"')
  })
  it('keeps job and photo available when the crop block fails', () => {
    mocked.states = [success(fixture('job.json', isJobDetail)), success(fixture('photo.json', isPhoto)), { kind: 'error', error: { kind: 'error', reason: 'network' } }]
    const html = renderToStaticMarkup(<JobPage jobId={31} />)
    expect(html).toContain('Завершено частично'); expect(html).toContain('src="/media/originals/test/source.png"')
    expect(html).toContain('Вырезки чеков (2)'); expect(html).toContain('Нет ответа сервера'); expect(html).toContain('Повторить')
  })
  it('keeps review crops available when the source photo fails', () => {
    mocked.states = [success(fixture('job.json', isJobDetail)), { kind: 'error', error: { kind: 'error', reason: 'storage_unavailable' } }, success({ results: [fixture('receipt-image.json', isReceiptImage)] })]
    const html = renderToStaticMarkup(<JobPage jobId={31} />)
    expect(html).toContain('Сервис временно недоступен'); expect(html).toContain('Требует проверки')
    expect(html).toContain('Исправление и подтверждение'); expect(html).toContain('value="МОЛОКО"')
    // job.json is finished: the confirmation is offered, with no draft promised.
    expect(html).toMatch(/<button type="button" data-review-confirm="true" aria-describedby="[^"]+">Подтвердить и сохранить чек<\/button>/)
  })
  it('names the search field as the place of focus of «Повторить поиск», which disappears with its press', () => {
    mocked.states = [{ kind: 'error', error: { kind: 'error', reason: 'network' } }]
    const html = renderToStaticMarkup(<StoreResults query="test" disabled={false} focus="review-42-receipt-store" onChoose={vi.fn()} />)
    expect(html).toContain('Не удалось найти магазины.')
    expect(html).toContain('<button type="button" data-review-focus="review-42-receipt-store">Повторить поиск</button>')
    // No other state of the search has a button that its own press removes without a place for focus.
    expect(renderToStaticMarkup(<StoreResults query="test" disabled={false} focus="review-42-receipt-store" onChoose={vi.fn()} />)).toBe('<p role="status">Ищем магазины…</p>')
  })
  it('shows cancel_requested separately from cancelled with disabled cancel and keeps processing updates visible', () => {
    mocked.states = [success(fixture('job-cancel-requested.json', isJobDetail)), { kind: 'loading' }, { kind: 'loading' }]
    const html = renderToStaticMarkup(<JobPage jobId={31} />)
    expect(html).toContain('Отмена запрошена'); expect(html).toContain('Ждём подтверждения отмены')
    expect(html).toMatch(/disabled=""[^>]*>Отменить/); expect(html).not.toContain('ck-rec-status-cancelled')
    expect(html.match(/Загружаем данные/g)).toHaveLength(2)
  })
})
