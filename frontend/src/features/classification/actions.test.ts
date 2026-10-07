import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRecognitionCsrf } from '../../api/local'
import { confirmProductClassification, getProductClassifications } from '../../api/product-classifications'
import { classificationFixture } from '../../api/product-classifications-test-support'
import { publicFixture } from '../../api/recognition-test-support'
import type { Classification, ClassificationConfirmItem, ClassificationConfirmMany, ClassificationRunRequest } from '../../api/product-classifications'
import type { RecognitionCsrf } from '../../api/recognition-types'
import type { LocalApiFailure, LocalApiResult, Page } from '../../api/types'
import { createPollingRequest } from '../recognition/polling'
import { createClassificationActions, keepsArea, retryable } from './actions'
import type { ActionLifecycle, ClassificationAction, ClassificationApi } from './actions'
import { confirmable, confirmItems, replaceRecords } from './state'
import { confirmedMany, record, records, refusal, runRequest } from './test-support'

const csrfOk: LocalApiResult<RecognitionCsrf> = { kind: 'ok', data: publicFixture('csrf.json') as RecognitionCsrf }
const never = async (): Promise<never> => { throw new Error('unexpected call') }
const api = (patch: Partial<ClassificationApi> = {}) => {
  const base: ClassificationApi = { confirm: never, reject: never, confirmMany: never, requestRun: never, refreshCsrf: async () => csrfOk }
  const mocked = { ...base, ...patch }
  return {
    confirm: vi.fn(mocked.confirm), reject: vi.fn(mocked.reject), confirmMany: vi.fn(mocked.confirmMany),
    requestRun: vi.fn(mocked.requestRun), refreshCsrf: vi.fn(mocked.refreshCsrf),
  }
}
const lifecycle = () => ({
  pause: vi.fn(), success: vi.fn(), failure: vi.fn(), reread: vi.fn<ActionLifecycle['reread']>(async () => {}), release: vi.fn(), settled: vi.fn(),
}) satisfies ActionLifecycle
const confirm: Extract<ClassificationAction, { id: number }> = { type: 'confirm', id: 4, input: { version: 1, generic_id: 92 } }
const choose: Extract<ClassificationAction, { id: number }> = { type: 'choose', id: 6, input: { version: 1, generic_id: 95 } }
const reject: Extract<ClassificationAction, { id: number }> = { type: 'reject', id: 3, input: { version: 1 } }
const ok = <T,>(data: T): LocalApiResult<T> => ({ kind: 'ok', data })
const many = (items: ClassificationConfirmItem[]): ClassificationConfirmMany => {
  const template = confirmedMany().results[0]
  return { confirmed: items.length, results: items.map((item) => ({ ...template, id: item.id, version: item.version + 1 })) }
}
const numbered = (count: number) => Array.from({ length: count }, (_, index) => ({ id: index + 1, version: 1 }))

describe('single record actions', () => {
  it.each<[Extract<ClassificationAction, { id: number }>, 'confirm' | 'reject', string, string]>([
    [confirm, 'confirm', 'classification-confirmed.json', 'Категория подтверждена.'],
    [choose, 'confirm', 'classification-confirmed-other.json', 'Выбран другой обобщённый продукт: «Творог».'],
    [reject, 'reject', 'classification-rejected.json', 'Предложение отклонено: товар возвращён в «Не разобрано».'],
  ])('pauses reads, sends the body, hands the answered record to the screen and reports %o', async (action, method, fixture, text) => {
    const life = lifecycle()
    const data = record(fixture)
    const calls = api({ [method]: async () => ok(data) })
    const actions = createClassificationActions(calls, life)
    const states: string[] = []
    actions.subscribe(() => states.push(actions.getSnapshot().kind))
    await actions.run(action)
    expect(states).toEqual(['pending', 'done'])
    expect(life.pause).toHaveBeenCalledTimes(1)
    expect(life.pause.mock.invocationCallOrder[0]).toBeLessThan(calls[method].mock.invocationCallOrder[0])
    expect(calls[method]).toHaveBeenCalledExactlyOnceWith(action.id, action.input, expect.any(AbortSignal))
    expect(life.success).toHaveBeenCalledExactlyOnceWith({ action, records: [data] })
    expect(life.failure).not.toHaveBeenCalled()
    expect(actions.getSnapshot()).toEqual({ kind: 'done', action, message: text })
  })
  it('confirm sends the version of the record and the suggested generic product through the real adapter', async () => {
    const fetchMock = vi.fn<typeof fetch>()
    clearRecognitionCsrf(); vi.stubGlobal('fetch', fetchMock)
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify(publicFixture('csrf.json'))))
      .mockResolvedValueOnce(new Response(JSON.stringify(classificationFixture('classification-confirmed.json'))))
    const milk = records().results[3]
    const life = lifecycle()
    const actions = createClassificationActions(api({ confirm: (id, input, signal) => confirmProductClassification(id, input, { signal }) }), life)
    await actions.run({ type: 'confirm', id: milk.id, input: { version: milk.version, generic_id: milk.suggested.generic.id } })
    expect(fetchMock.mock.calls[1][0]).toBe('/api/product-classifications/4/confirm/')
    expect(fetchMock.mock.calls[1][1]?.body).toBe(JSON.stringify(classificationFixture('confirm-request.json')))
    expect(actions.getSnapshot().kind).toBe('done')
    vi.unstubAllGlobals(); clearRecognitionCsrf()
  })

  it.each([
    ['error-classification-busy.json', 'Каталог сейчас изменяется: идёт импорт чека, слияние дублей или другое действие. Ничего не сохранено.'],
    ['error-classification-changed.json', 'Предложение изменилось. Данные обновлены: проверьте запись и повторите действие.'],
    ['error-classification-resolved.json', 'Предложение уже решено. Показано актуальное состояние.'],
    ['error-not-found.json', 'Запись не найдена. Список обновлён.'],
    ['error-permission-denied.json', 'Локальный API выключен или недоступен с этого адреса. Запустите сервер с ALLOW_LOCAL_RECOGNITION_API=1 и откройте приложение с этого компьютера.'],
  ])('never repeats a refused mutation and lets the screen read again: %s', async (name, text) => {
    const life = lifecycle()
    const error = refusal(name)
    const calls = api({ confirm: async () => error })
    const actions = createClassificationActions(calls, life)
    await actions.run(confirm)
    expect(calls.confirm).toHaveBeenCalledTimes(1)
    expect(life.success).not.toHaveBeenCalled()
    expect(life.reread).not.toHaveBeenCalled()
    expect(life.failure).toHaveBeenCalledExactlyOnceWith(error, confirm, [])
    expect(actions.getSnapshot()).toEqual({ kind: 'failed', action: confirm, error, message: text })
  })
  it('explains a refused choice of another generic product and keeps its area for a new choice', async () => {
    const life = lifecycle()
    for (const name of ['error-invalid-parameter.json', 'error-invalid-parameter-service.json']) {
      const error = refusal(name)
      const actions = createClassificationActions(api({ confirm: async () => error }), life)
      await actions.run(choose)
      expect(actions.getSnapshot()).toMatchObject({ kind: 'failed', message: 'Этот обобщённый продукт больше недоступен. Выберите другой.' })
      expect(keepsArea(error, choose)).toBe(true)
      expect(keepsArea(error, confirm)).toBe(false)
    }
    expect(life.failure).toHaveBeenCalledTimes(2)
  })
  it('offers «Повторить» only for a busy catalog and sends the same action again only when asked', async () => {
    const life = lifecycle()
    const busy = refusal('error-classification-busy.json')
    const data = record('classification-rejected.json')
    const calls = api({ reject: vi.fn<ClassificationApi['reject']>().mockResolvedValueOnce(busy).mockResolvedValueOnce(ok(data)) })
    const actions = createClassificationActions(calls, life)
    await actions.run(reject)
    const failed = actions.getSnapshot()
    expect(retryable(failed)).toBe(true)
    expect(keepsArea(busy, reject)).toBe(true)
    expect(calls.reject).toHaveBeenCalledTimes(1)
    if (retryable(failed)) await actions.run(failed.action)
    expect(calls.reject).toHaveBeenCalledTimes(2)
    expect(calls.reject.mock.calls[1].slice(0, 2)).toEqual([3, { version: 1 }])
    expect(actions.getSnapshot().kind).toBe('done')
    for (const name of ['error-classification-changed.json', 'error-classification-resolved.json', 'error-csrf-failed.json']) {
      const error = refusal(name)
      expect(retryable({ kind: 'failed', action: reject, error, message: '' })).toBe(false)
      expect(keepsArea(error, reject)).toBe(name === 'error-csrf-failed.json')
    }
    expect(retryable({ kind: 'done', action: reject, message: '' })).toBe(false)
  })
  it('renews the token after csrf_failed without sending the request again', async () => {
    const life = lifecycle()
    const error = refusal('error-csrf-failed.json')
    const calls = api({ reject: async () => error })
    const actions = createClassificationActions(calls, life)
    await actions.run(reject)
    expect(calls.reject).toHaveBeenCalledTimes(1)
    expect(calls.refreshCsrf).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal))
    expect(calls.refreshCsrf.mock.invocationCallOrder[0]).toBeLessThan(life.failure.mock.invocationCallOrder[0])
    expect(life.reread).not.toHaveBeenCalled()
    expect(actions.getSnapshot()).toMatchObject({ kind: 'failed', message: 'Токен безопасности устарел. Повторите действие.' })
  })
  it.each<LocalApiFailure['reason']>(['network', 'timeout', 'server', 'database_unavailable'])(
    'reads the record again after %s before anything can be repeated, and does not repeat itself', async (reason) => {
      const life = lifecycle()
      const order: string[] = []
      let release!: () => void
      life.reread.mockImplementation(() => { order.push('reread'); return new Promise<void>((resolve) => { release = resolve }) })
      life.failure.mockImplementation(() => { order.push('failure') })
      const calls = api({ confirm: async () => ({ kind: 'error', reason }) })
      const actions = createClassificationActions(calls, life)
      const running = actions.run(confirm)
      await vi.waitFor(() => expect(life.reread).toHaveBeenCalledExactlyOnceWith(confirm, expect.any(AbortSignal)))
      // Still busy: every control of the screen stays disabled until the record has been read.
      expect(actions.getSnapshot().kind).toBe('pending')
      await actions.run(confirm)
      expect(calls.confirm).toHaveBeenCalledTimes(1)
      release()
      await running
      expect(order).toEqual(['reread', 'failure'])
      expect(actions.getSnapshot()).toMatchObject({ kind: 'failed', message: 'Ответ сервера не получен. Действие могло выполниться: проверьте состояние записи перед повтором.' })
      expect(calls.confirm).toHaveBeenCalledTimes(1)
    })
  it('treats a thrown transport error as a network failure and survives a failed re-read', async () => {
    const life = lifecycle()
    life.reread.mockRejectedValue(new Error('private'))
    const actions = createClassificationActions(api({ confirm: async () => { throw new Error('private') } }), life)
    await actions.run(confirm)
    expect(actions.getSnapshot()).toMatchObject({ kind: 'failed', error: { kind: 'error', reason: 'network' } })
    expect(JSON.stringify(actions.getSnapshot())).not.toContain('private')
  })
})

describe('one action at a time', () => {
  it('ignores every other action while one is being saved', async () => {
    const life = lifecycle()
    let finish!: (result: LocalApiResult<Classification>) => void
    const calls = api({ confirm: () => new Promise((resolve) => { finish = resolve }), reject: async () => ok(record('classification-rejected.json')) })
    const actions = createClassificationActions(calls, life)
    const first = actions.run(confirm)
    await actions.run(reject)
    await actions.run({ type: 'run' })
    await actions.run({ type: 'confirmAll', genericId: 93, items: numbered(2) })
    expect(actions.getSnapshot()).toEqual({ kind: 'pending', action: confirm })
    expect([calls.reject, calls.requestRun, calls.confirmMany].map((call) => call.mock.calls.length)).toEqual([0, 0, 0])
    expect(life.pause).toHaveBeenCalledTimes(1)
    finish(ok(record('classification-confirmed.json')))
    await first
    await actions.run(reject)
    expect(calls.reject).toHaveBeenCalledTimes(1)
  })
})

/**
 * The actions are replaced with every filter, product and page and with the screen itself. The state request of the
 * page outlives them, so whatever way an action ends, the pause it put on the reads has to be lifted — once.
 */
describe('the owner goes away during an action', () => {
  const lifted = (life: ReturnType<typeof lifecycle>) => life.success.mock.calls.length + life.failure.mock.calls.length + life.release.mock.calls.length
  it('leaves a POST in flight to answer, lets the reads go on at once and reads again when it has answered', async () => {
    const life = lifecycle()
    let signal!: AbortSignal
    let finish!: (result: LocalApiResult<Classification>) => void
    const actions = createClassificationActions(api({ confirm: (_id, _input, given) => { signal = given; return new Promise((resolve) => { finish = resolve }) } }), life)
    const states: string[] = []
    actions.subscribe(() => states.push(actions.getSnapshot().kind))
    const running = actions.run(confirm)
    actions.dispose()
    // Aborting would not undo the POST on the server: it would only hide the moment it was saved.
    expect(signal.aborted).toBe(false)
    expect(life.release).toHaveBeenCalledTimes(1)
    expect(life.settled).not.toHaveBeenCalled()
    expect(actions.getSnapshot()).toEqual({ kind: 'idle' })
    finish(ok(record('classification-confirmed.json')))
    await running
    expect(life.settled).toHaveBeenCalledTimes(1)
    expect(life.release.mock.invocationCallOrder[0]).toBeLessThan(life.settled.mock.invocationCallOrder[0])
    // The answer belongs to a screen that is gone: nothing of it is shown.
    expect(life.success).not.toHaveBeenCalled()
    expect(life.failure).not.toHaveBeenCalled()
    expect(states).toEqual(['pending', 'idle'])
    expect([life.pause.mock.calls.length, lifted(life)]).toEqual([1, 1])
  })
  it.each<[string, LocalApiResult<Classification>]>([
    ['a refusal', refusal('error-classification-resolved.json')], ['a lost answer', { kind: 'error', reason: 'network' }],
    ['a stale token', refusal('error-csrf-failed.json')], ['a cancelled request', { kind: 'aborted' }],
  ])('reads again after %s of the POST it left, without the re-read and the token of a screen that is gone', async (_name, answer) => {
    const life = lifecycle()
    let finish!: (result: LocalApiResult<Classification>) => void
    const calls = api({ confirm: () => new Promise((resolve) => { finish = resolve }) })
    const actions = createClassificationActions(calls, life)
    const running = actions.run(confirm)
    actions.dispose()
    finish(answer)
    await running
    expect([life.pause.mock.calls.length, lifted(life), life.release.mock.calls.length, life.settled.mock.calls.length]).toEqual([1, 1, 1, 1])
    expect(life.reread).not.toHaveBeenCalled()
    expect(calls.refreshCsrf).not.toHaveBeenCalled()
    expect(actions.getSnapshot()).toEqual({ kind: 'idle' })
  })
  it.each<[string, LocalApiResult<Classification>, 'reread' | 'refreshCsrf']>([
    ['the record is read again after a lost answer', { kind: 'error', reason: 'timeout' }, 'reread'],
    ['the token is renewed', refusal('error-csrf-failed.json'), 'refreshCsrf'],
  ])('aborts the read under way when it leaves while %s: the POST has answered already', async (_name, answer, step) => {
    const life = lifecycle()
    let signal!: AbortSignal
    let finish!: () => void
    const waiting = <T,>(value: T) => (given: AbortSignal) => { signal = given; return new Promise<T>((resolve) => { finish = () => resolve(value) }) }
    life.reread.mockImplementation((_action: ClassificationAction, given: AbortSignal) => waiting<void>(undefined)(given))
    const calls = api({ confirm: async () => answer, refreshCsrf: waiting(csrfOk) })
    const actions = createClassificationActions(calls, life)
    const running = actions.run(confirm)
    await vi.waitFor(() => expect(step === 'reread' ? life.reread : calls.refreshCsrf).toHaveBeenCalledTimes(1))
    actions.dispose()
    expect(signal.aborted).toBe(true)
    expect(life.release).toHaveBeenCalledTimes(1)
    finish()
    await running
    // Nothing is in flight on the server any more: there is nothing to wait for and nothing to show.
    expect(life.settled).not.toHaveBeenCalled()
    expect([life.pause.mock.calls.length, lifted(life)]).toEqual([1, 1])
    expect(actions.getSnapshot()).toEqual({ kind: 'idle' })
  })
  it('lets the batch of «Подтвердить все» in flight answer and sends none of the next ones', async () => {
    const life = lifecycle()
    const finish: ((result: LocalApiResult<ClassificationConfirmMany>) => void)[] = []
    const calls = api({ confirmMany: () => new Promise((resolve) => { finish.push(resolve) }) })
    const actions = createClassificationActions(calls, life)
    const items = numbered(250)
    const running = actions.run({ type: 'confirmAll', genericId: 93, items })
    await vi.waitFor(() => expect(finish).toHaveLength(1))
    actions.dispose()
    finish[0](ok(many(items.slice(0, 100))))
    await running
    expect(calls.confirmMany).toHaveBeenCalledTimes(1)
    expect([life.pause.mock.calls.length, lifted(life), life.settled.mock.calls.length]).toEqual([1, 1, 1])
  })
  it('does nothing when no action is being saved, and serves again after its owner came back', async () => {
    const life = lifecycle()
    let finish!: (result: LocalApiResult<Classification>) => void
    const calls = api({ confirm: () => new Promise((resolve) => { finish = resolve }), reject: async () => ok(record('classification-rejected.json')) })
    const actions = createClassificationActions(calls, life)
    // React StrictMode runs the cleanup of a mounted screen once before anything is pressed.
    actions.dispose()
    expect([life.pause, life.release, life.settled].map((call) => call.mock.calls.length)).toEqual([0, 0, 0])
    const left = actions.run(confirm)
    actions.dispose()
    actions.dispose()
    expect(life.release).toHaveBeenCalledTimes(1)
    // The old POST is still in flight; the same object takes the next action and shows only that one.
    await actions.run(reject)
    expect(actions.getSnapshot()).toMatchObject({ kind: 'done', action: reject })
    finish(ok(record('classification-confirmed.json')))
    await left
    expect(actions.getSnapshot()).toMatchObject({ kind: 'done', action: reject })
    expect([life.pause.mock.calls.length, lifted(life), life.settled.mock.calls.length]).toEqual([2, 2, 1])
  })
  it('lifts the pause when a request ends as cancelled although nobody left', async () => {
    const life = lifecycle()
    const actions = createClassificationActions(api({ confirm: async () => ({ kind: 'aborted' }) }), life)
    await actions.run(confirm)
    expect([life.pause.mock.calls.length, lifted(life), life.release.mock.calls.length, life.settled.mock.calls.length]).toEqual([1, 1, 1, 0])
    expect(actions.getSnapshot()).toEqual({ kind: 'idle' })
  })
  it.each<[string, Partial<ClassificationApi>, ClassificationAction]>([
    ['success', { confirm: async () => ok(record('classification-confirmed.json')) }, confirm],
    ['a refusal', { reject: async () => refusal('error-classification-changed.json') }, reject],
    ['a busy catalog', { confirm: async () => refusal('error-classification-busy.json') }, confirm],
    ['a refused choice', { confirm: async () => refusal('error-invalid-parameter.json') }, choose],
    ['a stale token', { confirm: async () => refusal('error-csrf-failed.json') }, confirm],
    ['a token that cannot be renewed', { confirm: async () => refusal('error-csrf-failed.json'), refreshCsrf: async () => ({ kind: 'error', reason: 'network' }) }, confirm],
    ['no network', { confirm: async () => ({ kind: 'error', reason: 'network' }) }, confirm],
    ['a timeout', { requestRun: async () => ({ kind: 'error', reason: 'timeout' }) }, { type: 'run' }],
    ['a broken answer', { confirm: async () => ({ kind: 'error', reason: 'invalid_response' }) }, confirm],
    ['a thrown transport error', { confirm: async () => { throw new Error('private') } }, confirm],
    ['a refused second batch', { confirmMany: async (items) => items[0].id === 1 ? ok(many(items)) : refusal('error-classification-busy.json') },
      { type: 'confirmAll', genericId: 93, items: numbered(150) }],
    ['a started run', { requestRun: async () => ok(runRequest('run-created.json')) }, { type: 'run' }],
  ])('lifts the pause exactly once after %s', async (_name, patch, action) => {
    const life = lifecycle()
    const actions = createClassificationActions(api(patch), life)
    await actions.run(action)
    expect([life.pause.mock.calls.length, lifted(life), life.release.mock.calls.length, life.settled.mock.calls.length]).toEqual([1, 1, 0, 0])
    // A re-read that throws does not leave the pause on either.
    const broken = lifecycle()
    broken.reread.mockRejectedValue(new Error('private'))
    await createClassificationActions(api(patch), broken).run(action)
    expect([broken.pause.mock.calls.length, lifted(broken)]).toEqual([1, 1])
  })
})

describe('«Подтвердить все»', () => {
  it('sends the records of the group on the page with their versions in one request', async () => {
    const life = lifecycle()
    const kefir = confirmable(records().results.filter((item) => item.suggested.generic.id === 93))
    const answer = confirmedMany()
    const calls = api({ confirmMany: async () => ok(answer) })
    const actions = createClassificationActions(calls, life)
    const action: ClassificationAction = { type: 'confirmAll', genericId: 93, items: confirmItems(kefir) }
    await actions.run(action)
    expect(calls.confirmMany).toHaveBeenCalledExactlyOnceWith((classificationFixture('confirm-many-request.json') as { items: unknown }).items, expect.any(AbortSignal))
    expect(life.success).toHaveBeenCalledExactlyOnceWith({ action, records: answer.results })
    expect(actions.getSnapshot()).toEqual({ kind: 'done', action, message: 'Подтверждено 2 из 2.' })
  })
  it('sends more than 100 records as consecutive requests of 100', async () => {
    const life = lifecycle()
    const active: number[] = []
    let inFlight = 0
    const calls = api({ confirmMany: async (items) => {
      active.push(++inFlight)
      await Promise.resolve()
      inFlight--
      return ok(many(items))
    } })
    const actions = createClassificationActions(calls, life)
    await actions.run({ type: 'confirmAll', genericId: 93, items: numbered(250) })
    expect(calls.confirmMany.mock.calls.map(([items]) => [items[0].id, items.length])).toEqual([[1, 100], [101, 100], [201, 50]])
    expect(active).toEqual([1, 1, 1])
    expect(life.pause).toHaveBeenCalledTimes(1)
    expect(life.success.mock.calls[0][0].records).toHaveLength(250)
    expect(actions.getSnapshot()).toMatchObject({ kind: 'done', message: 'Подтверждено 250 из 250.' })
  })
  it.each([
    ['error-classification-changed-items.json', 'Предложение изменилось. Данные обновлены: проверьте запись и повторите действие.', false],
    ['error-classification-resolved-items.json', 'Предложение уже решено. Показано актуальное состояние.', false],
    ['error-classification-busy.json', 'Каталог сейчас изменяется: идёт импорт чека, слияние дублей или другое действие. Ничего не сохранено.', true],
  ])('stops at the first refusal and reports how many were confirmed: %s', async (name, text, retry) => {
    const life = lifecycle()
    const error = refusal(name)
    const calls = api({ confirmMany: vi.fn<ClassificationApi['confirmMany']>().mockImplementationOnce(async (items) => ok(many(items))).mockResolvedValueOnce(error) })
    const actions = createClassificationActions(calls, life)
    const action: ClassificationAction = { type: 'confirmAll', genericId: 93, items: numbered(250) }
    await actions.run(action)
    expect(calls.confirmMany).toHaveBeenCalledTimes(2)
    expect(life.success).not.toHaveBeenCalled()
    expect(life.failure).toHaveBeenCalledExactlyOnceWith(error, action, expect.any(Array))
    expect(life.failure.mock.calls[0][2]).toHaveLength(100)
    const state = actions.getSnapshot()
    expect(state).toMatchObject({ kind: 'failed', error, message: `Подтверждено 100 из 250. ${text}` })
    expect(retryable(state)).toBe(retry)
  })
  it('reports nothing confirmed when the only request is refused, and reads the list again after a lost answer', async () => {
    const life = lifecycle()
    const actions = createClassificationActions(api({ confirmMany: async () => ({ kind: 'error', reason: 'timeout' }) }), life)
    const action: ClassificationAction = { type: 'confirmAll', genericId: 93, items: numbered(2) }
    await actions.run(action)
    expect(life.reread).toHaveBeenCalledExactlyOnceWith(action, expect.any(AbortSignal))
    expect(actions.getSnapshot()).toMatchObject({ kind: 'failed', message: 'Подтверждено 0 из 2. Ответ сервера не получен. Действие могло выполниться: проверьте состояние записи перед повтором.' })
  })
})

describe('«Предложить категории»', () => {
  it.each<[string, string]>([
    ['run-created.json', 'Запуск поставлен в очередь.'], ['run-existing.json', 'Запуск уже в очереди или выполняется: новый не создан.'],
    ['run-nothing.json', 'Товаров без категории нет.'],
  ])('reports the answer %s', async (fixture, text) => {
    const life = lifecycle()
    const data: ClassificationRunRequest = runRequest(fixture)
    const calls = api({ requestRun: async () => ok(data) })
    const actions = createClassificationActions(calls, life)
    await actions.run({ type: 'run' })
    expect(calls.requestRun).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal))
    expect(life.success).toHaveBeenCalledExactlyOnceWith({ action: { type: 'run' }, records: [], run: data })
    expect(actions.getSnapshot()).toEqual({ kind: 'done', action: { type: 'run' }, message: text })
  })
  it('does not queue a second run after a busy catalog or a lost answer', async () => {
    for (const error of [refusal('error-classification-busy.json'), { kind: 'error', reason: 'network' } as LocalApiFailure]) {
      const life = lifecycle()
      const calls = api({ requestRun: async () => error })
      const actions = createClassificationActions(calls, life)
      await actions.run({ type: 'run' })
      expect(calls.requestRun).toHaveBeenCalledTimes(1)
      expect(life.reread).toHaveBeenCalledTimes(error.reason === 'network' ? 1 : 0)
      expect(actions.getSnapshot().kind).toBe('failed')
    }
  })
})

describe('reads during an action', () => {
  const fetchMock = vi.fn<typeof fetch>()
  beforeEach(() => { clearRecognitionCsrf(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
  afterEach(() => { clearRecognitionCsrf(); vi.unstubAllGlobals() })
  it('pauses the list: a late read never replaces the record the action answered with', async () => {
    const page = records()
    let answerRead!: (result: LocalApiResult<Page<Classification>>) => void
    let reads = 0
    const list = createPollingRequest<Page<Classification>>(() => {
      reads++
      return reads === 1 ? Promise.resolve(ok(page)) : new Promise((resolve) => { answerRead = resolve })
    })
    list.start()
    await vi.waitFor(() => expect(list.getSnapshot().kind).toBe('ok'))
    list.refresh()
    expect(reads).toBe(2)
    const confirmed = record('classification-confirmed.json')
    const actions = createClassificationActions(api({ confirm: async () => ok(confirmed) }), {
      pause: list.pause, reread: async () => {}, failure: () => list.resume(), release: () => list.resume(), settled: () => {},
      success: (outcome) => {
        const current = list.getSnapshot()
        if (current.kind === 'ok') list.setData(replaceRecords(current.data, outcome.records))
      },
    })
    await actions.run(confirm)
    // The read that started before the action answers last, with the old pending record.
    answerRead(ok(page))
    await Promise.resolve(); await Promise.resolve()
    const shown = list.getSnapshot()
    expect(shown.kind === 'ok' && shown.data.results.find((item) => item.id === 4)?.status).toBe('confirmed')
    list.dispose()
  })
  it('reads the same list the screen shows when asked through the real adapter', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(classificationFixture('classifications.json'))))
    expect((await getProductClassifications({ status: 'pending', page: 1, page_size: 200, ordering: 'generic' })).kind).toBe('ok')
    expect(fetchMock.mock.calls[0][0]).toBe('/api/product-classifications/?status=pending&page=1&page_size=200&ordering=generic')
  })
})
