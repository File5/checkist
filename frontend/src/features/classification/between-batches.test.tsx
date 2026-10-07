import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRecognitionCsrf, getRecognitionCsrf } from '../../api/local'
import { getProductClassificationState, requestProductClassificationRun } from '../../api/product-classifications'
import type { Classification, ClassificationRun, ClassificationState } from '../../api/product-classifications'
import { classificationFixture } from '../../api/product-classifications-test-support'
import { publicFixture } from '../../api/recognition-test-support'
import type { Executor } from '../../api/recognition-types'
import type { Page } from '../../api/types'
import { createPollingRequest } from '../recognition/polling'
import type { PollEnvironment, RequestState } from '../recognition/polling'
import { createClassificationActions } from './actions'
import type { ActionState } from './actions'
import { ClassificationView } from './ClassificationPage'
import { runText } from './labels'
import { applyRunRequest, canRequestRun, runFinished, stateActive } from './state'
import { records, success } from './test-support'

/**
 * A run of several batches goes `queued → running → queued` after every batch and keeps `started_at`.
 * Every body here is the server's own example and reaches the screen through the real adapters, so a body
 * the client schema refuses fails the test as it would fail the page.
 */
const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const between = () => structuredClone(classificationFixture('status-between-batches.json')) as ClassificationState
const workers: Record<'idle' | 'busy' | 'absent', Executor> = {
  idle: { available: true, state: 'idle', last_seen_at: '2026-10-06T10:20:07Z' },
  busy: { available: true, state: 'busy', last_seen_at: null },
  absent: { available: false, state: 'absent', last_seen_at: null },
}
const withWorker = (state: keyof typeof workers, patch: Partial<ClassificationRun> = {}): ClassificationState => {
  const body = between()
  return { ...body, run: { ...body.run!, ...patch }, executor: workers[state] }
}
const read = async (body: unknown) => {
  fetchMock.mockResolvedValueOnce(json(body))
  return getProductClassificationState()
}
const noop = () => {}
const idle: ActionState = { kind: 'idle' }
const view = (state: RequestState<ClassificationState>, action: ActionState = idle, list: RequestState<Page<Classification>> = success(records())) =>
  renderToStaticMarkup(<ClassificationView query={{ page: 1 }} state={state} list={list} action={action}
    onRun={noop} onRetryAction={noop} onRetryState={noop} onRetryList={noop} onAction={noop} onOpen={noop} onClose={noop} />)
const startButton = (html: string) => html.match(/<button[^>]*>Предложить категории<\/button>/)![0]
const formatError = 'не соответствует ожидаемому формату'
/** Timers are fired by hand: the test sees every delay the poller asked for. */
function clock() {
  const delays: number[] = []
  let pending: (() => void) | undefined
  const env: PollEnvironment = {
    hidden: () => false, listen: () => () => {},
    later: (callback, delay) => { delays.push(delay); pending = callback; return 0 as unknown as ReturnType<typeof setTimeout> },
    clear: () => { pending = undefined },
  }
  return { env, delays, waiting: () => pending !== undefined, tick: () => { const callback = pending; pending = undefined; callback?.() } }
}

beforeEach(() => { clearRecognitionCsrf(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { clearRecognitionCsrf(); vi.unstubAllGlobals() })

describe('run waiting between its batches: from the server answer to the text for a person', () => {
  it('reads the example of the server as it is: queued, started, 1 of 2 processed, no worker', async () => {
    const result = await read(classificationFixture('status-between-batches.json'))
    expect(result).toEqual({ kind: 'ok', data: classificationFixture('status-between-batches.json') })
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/api/product-classifications/status/', expect.objectContaining({ credentials: 'same-origin' }))
  })
  it.each<[keyof typeof workers, string, string]>([
    ['idle', 'ck-class-run', 'Модель предлагает категории: обработано 1 из 2.'],
    ['busy', 'ck-class-run', 'Модель предлагает категории: обработано 1 из 2. Воркер занят другим заданием.'],
    ['absent', 'ck-class-warning', 'Запуск приостановлен: обработано 1 из 2. Воркер распознавания не запущен: запуск продолжится, когда воркер запустят.'],
  ])('with the worker %s shows the progress, not an error and not «начнётся»', async (worker, style, text) => {
    const result = await read(withWorker(worker))
    if (result.kind !== 'ok') throw new Error(JSON.stringify(result))
    expect(runText(result.data)).toEqual({ text, warning: worker === 'absent' })
    const html = view(success(result.data))
    expect(html).toContain(`<p class="${style}" role="status" aria-live="polite">${text}</p>`)
    expect(html).not.toContain(formatError)
    expect(html).not.toContain('Не удалось обновить данные')
    expect(html).not.toContain('начнётся')
  })
  it('shows the same texts for the real numbers of the interface check: 4 of 10 with fractions of a second', async () => {
    const run = { started_at: '2026-10-06T21:13:45.465650Z', progress: { requested: 10, processed: 4, applied: 3, unknown: 1, skipped: 0 } }
    const texts = []
    for (const worker of ['idle', 'busy', 'absent'] as const) {
      const result = await read(withWorker(worker, run))
      texts.push(result.kind === 'ok' ? runText(result.data)?.text : result)
    }
    expect(texts).toEqual([
      'Модель предлагает категории: обработано 4 из 10.',
      'Модель предлагает категории: обработано 4 из 10. Воркер занят другим заданием.',
      'Запуск приостановлен: обработано 4 из 10. Воркер распознавания не запущен: запуск продолжится, когда воркер запустят.',
    ])
  })
  it('describes a run stopped during its first batch as started, with nothing processed yet', async () => {
    const requeued = classificationFixture('run-requeued.json') as ClassificationRun
    const result = await read({ ...between(), run: requeued })
    expect(result.kind === 'ok' && runText(result.data)?.text)
      .toBe('Запуск приостановлен: обработано 0 из 7. Воркер распознавания не запущен: запуск продолжится, когда воркер запустят.')
    const resumed = await read({ ...between(), run: requeued, executor: workers.idle })
    expect(resumed.kind === 'ok' && runText(resumed.data)?.text).toBe('Модель предлагает категории: обработано 0 из 7.')
  })
})

describe('page opened while the run waits between its batches', () => {
  it('shows the block with data, not in the error state, and starts the poll', async () => {
    const time = clock()
    const body = between()
    fetchMock.mockImplementation(async () => json(body))
    const request = createPollingRequest((signal) => getProductClassificationState({ signal }), stateActive, undefined, time.env)
    request.start()
    await vi.waitFor(() => expect(request.getSnapshot().kind).not.toBe('loading'))
    const shown = request.getSnapshot()
    expect(shown).toEqual({ kind: 'ok', data: body, refreshing: false })
    expect(time.delays).toEqual([2000])
    const html = view(shown)
    expect(html).toMatch(/<section[^>]*aria-labelledby="class-state-title" aria-busy="false"/)
    expect(html).toContain('Ожидают подтверждения: 6. Без категории: 1.')
    expect(html).toContain('Запуск приостановлен: обработано 1 из 2.')
    expect(html).not.toContain(formatError)
    expect(html).not.toContain('data-request-retry')
    request.dispose()
  })
  it('keeps the start button unavailable because the run is active, not because of an error', async () => {
    const result = await read(between())
    if (result.kind !== 'ok') throw new Error(JSON.stringify(result))
    // There is a candidate, the local API answers and nothing is being saved: only the active run forbids a new one.
    expect(result.data.unclassified_count).toBe(1)
    expect(stateActive(result.data)).toBe(true)
    expect(canRequestRun(result.data)).toBe(false)
    expect(startButton(view(success(result.data)))).toContain('disabled=""')
    const finished = { ...result.data, run: classificationFixture('run-cancelled-started.json') as ClassificationRun }
    expect(canRequestRun(finished)).toBe(true)
    expect(startButton(view(success(finished)))).not.toContain('disabled')
  })
})

describe('poll of a run of several batches', () => {
  it('goes on every 2 seconds while the run is queued or running and never slows down for a format error', async () => {
    const time = clock()
    const run = between().run!
    const steps: ClassificationState[] = [
      withWorker('absent'),
      withWorker('idle'),
      withWorker('busy', { status: 'running', version: run.version + 1 }),
      withWorker('idle', { version: run.version + 2, progress: { ...run.progress, requested: 3, processed: 2, applied: 2 } }),
      withWorker('busy', { status: 'running', version: run.version + 3, progress: { ...run.progress, requested: 3, processed: 2, applied: 2 } }),
      withWorker('idle', {
        status: 'succeeded', version: run.version + 4, finished_at: '2026-10-06T10:20:30Z',
        progress: { ...run.progress, requested: 3, processed: 3, applied: 3 },
      }),
    ]
    let reads = 0
    fetchMock.mockImplementation(async () => json(steps[Math.min(reads++, steps.length - 1)]))
    const request = createPollingRequest((signal) => getProductClassificationState({ signal }), stateActive, undefined, time.env)
    const seen: (string | undefined)[] = []
    const finished: boolean[] = []
    let previous: ClassificationState | undefined
    request.start()
    for (let step = 0; step < steps.length; step++) {
      await vi.waitFor(() => expect(reads).toBe(step + 1))
      await vi.waitFor(() => expect(request.getSnapshot()).toMatchObject({ kind: 'ok', refreshing: false }))
      const shown = request.getSnapshot()
      if (shown.kind !== 'ok') throw new Error(JSON.stringify(shown))
      expect(shown.refreshError).toBeUndefined()
      expect(shown.data).toEqual(steps[step])
      seen.push(runText(shown.data)?.text)
      finished.push(runFinished(previous, shown.data))
      previous = shown.data
      if (step < steps.length - 1) { expect(time.waiting()).toBe(true); time.tick() }
    }
    expect(seen).toEqual([
      'Запуск приостановлен: обработано 1 из 2. Воркер распознавания не запущен: запуск продолжится, когда воркер запустят.',
      'Модель предлагает категории: обработано 1 из 2.',
      'Модель предлагает категории: обработано 1 из 2.',
      'Модель предлагает категории: обработано 2 из 3.',
      'Модель предлагает категории: обработано 2 из 3.',
      'Запуск завершён: предложено 3, не распознано 0, пропущено 0.',
    ])
    // Five waits of exactly 2 seconds; the finished run stops the poll and makes the list read once.
    expect(time.delays).toEqual([2000, 2000, 2000, 2000, 2000])
    expect(time.waiting()).toBe(false)
    expect(finished).toEqual([false, false, false, false, false, true])
    expect(reads).toBe(steps.length)
    request.dispose()
  })
  it('still slows down for a body that is really of another shape', async () => {
    const time = clock()
    const broken = between()
    broken.run!.finished_at = broken.run!.started_at
    fetchMock.mockResolvedValueOnce(json(between())).mockResolvedValueOnce(json(broken)).mockResolvedValue(json(between()))
    const request = createPollingRequest((signal) => getProductClassificationState({ signal }), stateActive, undefined, time.env)
    request.start()
    await vi.waitFor(() => expect(time.delays).toHaveLength(1))
    time.tick()
    await vi.waitFor(() => expect(time.delays).toHaveLength(2))
    expect(request.getSnapshot()).toMatchObject({ kind: 'ok', refreshError: { reason: 'invalid_response' } })
    time.tick()
    await vi.waitFor(() => expect(time.delays).toHaveLength(3))
    expect(request.getSnapshot()).toEqual({ kind: 'ok', data: between(), refreshing: false })
    expect(time.delays).toEqual([2000, 2000, 2000])
    request.dispose()
  })
})

describe('«Предложить категории» pressed while the run waits between its batches', () => {
  const api = {
    confirm: async (): Promise<never> => { throw new Error('unexpected call') },
    reject: async (): Promise<never> => { throw new Error('unexpected call') },
    confirmMany: async (): Promise<never> => { throw new Error('unexpected call') },
    requestRun: (signal: AbortSignal) => requestProductClassificationRun({ signal }),
    refreshCsrf: (signal: AbortSignal) => getRecognitionCsrf({ signal }),
  }
  it.each<[keyof typeof workers, string]>([
    ['idle', 'Модель предлагает категории: обработано 1 из 2.'],
    ['absent', 'Запуск приостановлен: обработано 1 из 2. Воркер распознавания не запущен: запуск продолжится, когда воркер запустят.'],
  ])('answers 200 with the same run and the ordinary text (worker %s)', async (worker, text) => {
    const state = withWorker(worker)
    const answer = { created: false, run: state.run, executor: state.executor }
    fetchMock.mockResolvedValueOnce(json(publicFixture('csrf.json'))).mockResolvedValueOnce(json(answer))
    const success = vi.fn()
    const reread = vi.fn(async () => {})
    const failure = vi.fn()
    const actions = createClassificationActions(api, { pause: noop, success, failure, reread, release: noop, settled: noop })
    await actions.run({ type: 'run' })
    expect(fetchMock.mock.calls[1][0]).toBe('/api/product-classifications/runs/')
    expect(fetchMock.mock.calls[1][1]).toMatchObject({ method: 'POST', body: '{}' })
    expect(actions.getSnapshot()).toEqual({ kind: 'done', action: { type: 'run' }, message: 'Запуск уже в очереди или выполняется: новый не создан.' })
    expect(success).toHaveBeenCalledExactlyOnceWith({ action: { type: 'run' }, records: [], run: answer })
    expect(failure).not.toHaveBeenCalled()
    // Not an uncertain answer: nothing is read again «to check whether the action was saved».
    expect(reread).not.toHaveBeenCalled()
    // The page shows the answered run at once, before the next read of the state.
    const before = { ...withWorker('absent'), run: classificationFixture('run.json') as ClassificationRun }
    const shown = applyRunRequest(before, answer)
    expect(shown.run).toEqual(state.run)
    expect(runText(shown)?.text).toBe(text)
    const html = view(success.mock.calls.length ? { kind: 'ok', data: shown, refreshing: false } : { kind: 'loading' }, actions.getSnapshot())
    expect(html).toMatch(/class="ck-class-result">Запуск уже в очереди или выполняется: новый не создан\.<\/p>/)
    expect(html).toContain(text)
    expect(html).not.toContain(formatError)
    expect(html).not.toContain('Действие могло выполниться')
    expect(startButton(html)).toContain('disabled=""')
  })
})
