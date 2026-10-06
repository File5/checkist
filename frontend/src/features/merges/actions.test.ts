import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRecognitionCsrf } from '../../api/local'
import { confirmProductMerge } from '../../api/product-merges'
import { errorFixtures, mergeFixture } from '../../api/product-merges-test-support'
import { publicFixture } from '../../api/recognition-test-support'
import type { MergeDetectResult, MergeGroup } from '../../api/product-merges'
import type { RecognitionCsrf } from '../../api/recognition'
import type { LocalApiFailure, LocalApiResult } from '../../api/types'
import { createPollingRequest } from '../recognition/polling'
import { createMergeActions } from './actions'
import type { MergeAction } from './actions'
import { confirmInput, initialSelection, selectResolution } from './state'
import { detected, group } from './test-support'

type Result = LocalApiResult<MergeGroup | MergeDetectResult>
const lifecycle = () => ({ pause: vi.fn(), success: vi.fn(), failure: vi.fn() })
const refusal = (name: string): LocalApiFailure => {
  const { status, reason, fields } = errorFixtures[name]
  return { kind: 'error', reason: reason as LocalApiFailure['reason'], status, ...(fields && { fields }) }
}
const csrfOk = async (): Promise<LocalApiResult<RecognitionCsrf>> => ({ kind: 'ok', data: publicFixture('csrf.json') as RecognitionCsrf })
const confirm: MergeAction = { type: 'confirm', id: 2, input: { version: 1, target_product_id: 5 } }
const flush = async () => { for (let index = 0; index < 5; index++) await Promise.resolve() }

describe('merge actions', () => {
  it.each<[MergeAction, string, string]>([
    [confirm, 'group-confirmed.json', 'Слияние подтверждено'],
    [{ type: 'cancel', id: 3 }, 'group-cancelled.json', 'Слияние отменено'],
    [{ type: 'exclude', id: 2, input: { version: 1, product_id: 43 } }, 'group-pending.json', 'Запись исключена из группы'],
    [{ type: 'exclude', id: 3, input: { version: 1, product_id: 38 } }, 'group-cancelled.json', 'осталось меньше двух записей'],
  ])('pauses reads, hands the answered group to the screen and reports %o', async (action, fixture, text) => {
    const life = lifecycle()
    const data = group(fixture)
    const mutate = vi.fn(async (): Promise<Result> => ({ kind: 'ok', data }))
    const actions = createMergeActions(mutate, csrfOk, life)
    const states: string[] = []
    actions.subscribe(() => states.push(actions.getSnapshot().kind))
    await actions.run(action)
    expect(states).toEqual(['pending', 'done'])
    expect(life.pause).toHaveBeenCalledTimes(1)
    expect(life.success).toHaveBeenCalledExactlyOnceWith({ action, data })
    expect(life.failure).not.toHaveBeenCalled()
    expect(actions.getSnapshot()).toMatchObject({ kind: 'done', action, message: expect.stringContaining(text) })
    expect(mutate).toHaveBeenCalledExactlyOnceWith(action, expect.any(AbortSignal))
  })
  it('shows the result of a duplicate search with the found groups', async () => {
    const life = lifecycle()
    const actions = createMergeActions(async () => ({ kind: 'ok', data: detected() }), csrfOk, life)
    await actions.run({ type: 'detect' })
    expect(actions.getSnapshot()).toEqual({ kind: 'done', action: { type: 'detect' }, message: 'Создано групп: 3.', detected: detected() })
  })
  it.each([
    ['error-merge-busy.json', 'Каталог сейчас изменяется'], ['error-merge-changed.json', 'Состав группы изменился'],
    ['error-merge-resolved.json', 'Слияние уже завершено'], ['error-merge-conflict.json', 'Выберите значение'],
    ['error-invalid-parameter.json', 'Выбор больше не соответствует группе'],
  ])('never repeats a refused mutation: %s', async (name, text) => {
    const life = lifecycle()
    const error = refusal(name)
    const mutate = vi.fn(async (): Promise<Result> => error)
    const actions = createMergeActions(mutate, csrfOk, life)
    await actions.run(confirm)
    await flush()
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(life.success).not.toHaveBeenCalled()
    // The screen reads the group again; the mutation itself waits for an explicit press.
    expect(life.failure).toHaveBeenCalledExactlyOnceWith(error, confirm)
    expect(actions.getSnapshot()).toEqual({ kind: 'failed', action: confirm, error, message: expect.stringContaining(text) })
  })
  it.each<LocalApiFailure['reason']>(['network', 'timeout', 'server', 'database_unavailable'])('warns that the action may have been saved after %s, without a repeat', async (reason) => {
    const life = lifecycle()
    const mutate = vi.fn(async (): Promise<Result> => ({ kind: 'error', reason }))
    const actions = createMergeActions(mutate, csrfOk, life)
    await actions.run(confirm)
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(actions.getSnapshot()).toMatchObject({ kind: 'failed', message: expect.stringContaining('могло выполниться') })
    expect(life.failure).toHaveBeenCalledTimes(1)
  })
  it('treats a thrown transport error as a network failure', async () => {
    const life = lifecycle()
    const actions = createMergeActions(async () => { throw new Error('private') }, csrfOk, life)
    await actions.run(confirm)
    expect(actions.getSnapshot()).toMatchObject({ kind: 'failed', error: { reason: 'network' } })
    expect(JSON.stringify(actions.getSnapshot())).not.toContain('private')
  })
  it('refreshes the token after csrf_failed but leaves the repeat to the person', async () => {
    const life = lifecycle()
    const mutate = vi.fn(async (): Promise<Result> => ({ kind: 'error', reason: 'csrf_failed', status: 403 }))
    const refresh = vi.fn(csrfOk)
    const actions = createMergeActions(mutate, refresh, life)
    await actions.run(confirm)
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(actions.getSnapshot()).toMatchObject({ kind: 'failed', message: expect.stringContaining('Действие не повторялось') })
    const broken = createMergeActions(mutate, async () => ({ kind: 'error', reason: 'network' }), lifecycle())
    await broken.run(confirm)
    expect(broken.getSnapshot()).toMatchObject({ kind: 'failed', message: expect.stringContaining('Не удалось обновить токен') })
  })
  it('ignores a second press while a request is running', async () => {
    let resolve!: (value: Result) => void
    const mutate = vi.fn(() => new Promise<Result>((yes) => { resolve = yes }))
    const actions = createMergeActions(mutate, csrfOk, lifecycle())
    const first = actions.run(confirm)
    await actions.run({ type: 'cancel', id: 2 })
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(actions.getSnapshot()).toEqual({ kind: 'pending', action: confirm })
    resolve({ kind: 'ok', data: group('group-confirmed.json') }); await first
    // A finished request frees the next explicit press.
    void actions.run({ type: 'cancel', id: 2 })
    expect(mutate).toHaveBeenCalledTimes(2)
    actions.dispose()
  })
  it('cancels the wait on leaving the route and ignores the late reply', async () => {
    let resolve!: (value: Result) => void
    let signal!: AbortSignal
    const life = lifecycle()
    const actions = createMergeActions((_action, current) => { signal = current; return new Promise((yes) => { resolve = yes }) }, csrfOk, life)
    const pending = actions.run(confirm)
    actions.dispose()
    expect(signal.aborted).toBe(true)
    resolve({ kind: 'ok', data: group('group-confirmed.json') }); await pending
    expect(life.success).not.toHaveBeenCalled(); expect(life.failure).not.toHaveBeenCalled()
    expect(actions.getSnapshot().kind).toBe('pending')
  })
  it('returns to idle when the request itself reports an abort', async () => {
    const life = lifecycle()
    const actions = createMergeActions(async () => ({ kind: 'aborted' }), csrfOk, life)
    await actions.run(confirm)
    expect(actions.getSnapshot()).toEqual({ kind: 'idle' })
    expect(life.success).not.toHaveBeenCalled(); expect(life.failure).not.toHaveBeenCalled()
  })
  it('keeps an older read from restoring the pending group after confirmation', async () => {
    let resolve!: (value: LocalApiResult<MergeGroup>) => void
    const request = createPollingRequest<MergeGroup>(() => new Promise((yes) => { resolve = yes }))
    request.start()
    const confirmed = group('group-confirmed.json')
    const actions = createMergeActions(async () => ({ kind: 'ok', data: confirmed }), csrfOk, {
      pause: request.pause, success: (outcome) => { request.setData(outcome.data as MergeGroup); request.resume(false) }, failure: () => request.resume(),
    })
    await actions.run(confirm); resolve({ kind: 'ok', data: group('group-pending-conflict.json') }); await flush()
    expect(request.getSnapshot()).toMatchObject({ kind: 'ok', data: confirmed })
    actions.dispose(); request.dispose()
  })
  it('reads the group again after a refusal and shows what the server holds now', async () => {
    const pending = group('group-pending.json')
    const next = { ...pending, version: 2 }
    const load = vi.fn<() => Promise<LocalApiResult<MergeGroup>>>().mockResolvedValueOnce({ kind: 'ok', data: pending }).mockResolvedValue({ kind: 'ok', data: next })
    const request = createPollingRequest<MergeGroup>(load)
    request.start(); await flush()
    const mutate = vi.fn(async (): Promise<Result> => refusal('error-merge-changed.json'))
    const actions = createMergeActions(mutate, csrfOk, { pause: request.pause, success: vi.fn(), failure: () => request.resume() })
    await actions.run(confirm); await flush()
    expect(load).toHaveBeenCalledTimes(2)
    expect(mutate).toHaveBeenCalledTimes(1)
    expect(request.getSnapshot()).toMatchObject({ kind: 'ok', data: { version: 2 } })
    actions.dispose(); request.dispose()
  })
})

describe('confirm through the real adapter (mocked fetch)', () => {
  const fetchMock = vi.fn<typeof fetch>()
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
  const send = (action: MergeAction, signal: AbortSignal): Promise<Result> => {
    if (action.type !== 'confirm') throw new Error('Only confirm is sent here')
    return confirmProductMerge(action.id, action.input, { signal })
  }
  beforeEach(() => { clearRecognitionCsrf(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
  afterEach(() => { clearRecognitionCsrf(); vi.unstubAllGlobals() })

  it('posts the chosen kept record, name and decisions with the read version', async () => {
    const milk = group('group-pending-conflict.json')
    const selection = { ...selectResolution(initialSelection(milk), 'generic', 2), name: 36 }
    fetchMock.mockResolvedValueOnce(json(publicFixture('csrf.json'))).mockResolvedValueOnce(json(mergeFixture('group-confirmed.json')))
    const life = lifecycle()
    const actions = createMergeActions(send, csrfOk, life)
    await actions.run({ type: 'confirm', id: milk.id, input: confirmInput(milk, selection) })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/product-merges/1/confirm/')
    expect(init).toMatchObject({ method: 'POST', credentials: 'same-origin' })
    expect(JSON.parse(String(init?.body))).toEqual({ version: 1, target_product_id: 2, name_product_id: 36, resolutions: { generic: 2 } })
    expect(life.success).toHaveBeenCalledTimes(1)
  })
  it('omits name_product_id and resolutions when nothing was chosen', async () => {
    const pizza = group('group-pending.json')
    fetchMock.mockResolvedValueOnce(json(publicFixture('csrf.json'))).mockResolvedValueOnce(json(mergeFixture('group-confirmed.json')))
    await createMergeActions(send, csrfOk, lifecycle()).run({ type: 'confirm', id: pizza.id, input: confirmInput(pizza, initialSelection(pizza)) })
    expect(String(fetchMock.mock.calls[1][1]?.body)).toBe('{"version":1,"target_product_id":5}')
  })
  it.each(['error-merge-busy.json', 'error-merge-changed.json', 'error-merge-conflict.json', 'error-merge-resolved.json'])('sends exactly one POST when the server answers %s', async (name) => {
    fetchMock.mockResolvedValueOnce(json(publicFixture('csrf.json'))).mockResolvedValue(json(mergeFixture(name), 409))
    const life = lifecycle()
    const actions = createMergeActions(send, csrfOk, life)
    await actions.run(confirm); await flush()
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1)
    expect(actions.getSnapshot()).toMatchObject({ kind: 'failed', error: { reason: errorFixtures[name].reason, status: 409 } })
  })
})
