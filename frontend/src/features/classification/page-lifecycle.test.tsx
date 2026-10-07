import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRecognitionCsrf } from '../../api/local'
import { getProductClassifications, getProductClassificationState } from '../../api/product-classifications'
import type { Classification, ClassificationState } from '../../api/product-classifications'
import { classificationFixture } from '../../api/product-classifications-test-support'
import { publicFixture } from '../../api/recognition-test-support'
import type { Page } from '../../api/types'
import type { ClassificationQuery } from '../../navigation'
import { createPollingRequest } from '../recognition/polling'
import type { PollEnvironment } from '../recognition/polling'
import { createClassificationActions } from './actions'
import type { ClassificationAction } from './actions'
import { ClassificationView } from './ClassificationPage'
import { createReadSync } from './list-sync'
import { createPageLifecycle } from './page-lifecycle'
import type { ListReads } from './page-lifecycle'
import { listParams, stateActive } from './state'
import { pageOf, record, records } from './test-support'
import { classificationApi } from './useClassificationActions'

/**
 * The page as `ClassificationPage` wires it, without React: the state request lives as long as the screen, the list,
 * its connection to the state and the actions are replaced with every filter, product and page — in the order React
 * runs the cleanups. Every request goes through the real adapters; POSTs answer when the test says so.
 */
const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
/** An active run without a worker: the state is polled every 2 seconds. */
const activeState = (pending: number): ClassificationState =>
  ({ ...structuredClone(classificationFixture('status-between-batches.json')) as ClassificationState, pending_count: pending })
const confirm: ClassificationAction = { type: 'confirm', id: 4, input: { version: 1, generic_id: 92 } }
const reject: ClassificationAction = { type: 'reject', id: 3, input: { version: 1 } }
const noop = () => {}
const turn = () => new Promise<void>((resolve) => { setTimeout(resolve, 0) })

type Held = { url: string; answer: (body: unknown, status?: number) => void; fail: () => void }
function server(start: { state: ClassificationState; list: Page<Classification> }) {
  const data = { ...start }
  const reads = { state: 0, list: 0, record: 0 }
  const lists: string[] = []
  const posts: Held[] = []
  /** Reads of one record — the check after a lost answer — wait for the test as well. */
  const records: Held[] = []
  const held = (queue: Held[], url: string) => new Promise<Response>((resolve, fail) => {
    queue.push({ url, answer: (body, status) => resolve(json(body, status)), fail: () => fail(new TypeError('offline')) })
  })
  fetchMock.mockImplementation((input, init) => {
    const url = String(input)
    if (init?.method === 'POST') return held(posts, url)
    if (url.includes('/recognition/csrf/')) return Promise.resolve(json(publicFixture('csrf.json')))
    if (url.includes('/status/')) { reads.state++; return Promise.resolve(json(data.state)) }
    if (/\/product-classifications\/\d+\/$/.test(url)) { reads.record++; return held(records, url) }
    reads.list++
    lists.push(url)
    return Promise.resolve(json(data.list))
  })
  return { data, reads, lists, posts, records }
}

function page(first: ClassificationQuery = { page: 1 }) {
  let timer: (() => void) | undefined
  const env: PollEnvironment = {
    hidden: () => false, listen: () => () => {},
    later: (callback) => { timer = callback; return 0 as unknown as ReturnType<typeof setTimeout> },
    clear: () => { timer = undefined },
  }
  const loadState = (signal: AbortSignal) => getProductClassificationState({ signal })
  const states = createPollingRequest(loadState, stateActive, undefined, env)
  const area = { close: vi.fn(), keep: vi.fn(), reloadOptions: vi.fn() }
  let shown!: ListReads
  const mount = (query: ClassificationQuery) => {
    const loadList = (signal: AbortSignal) => getProductClassifications(listParams(query), { signal })
    const lists = createPollingRequest(loadList)
    const reads = createReadSync(states, lists, query)
    const lifecycle = createPageLifecycle({ states, own: { lists, reads }, shown: () => shown, loadState, loadList, area })
    const actions = createClassificationActions(classificationApi, lifecycle)
    lists.start()
    const stop = reads.start()
    shown = { lists, reads }
    return { query, lists, actions, stop }
  }
  states.start()
  let current = mount(first)
  const leaveList = () => { current.lists.dispose(); current.stop(); current.actions.dispose() }
  return {
    states, area,
    get lists() { return current.lists },
    get actions() { return current.actions },
    /** Another filter, product or page, or Back / Forward within the screen. */
    go: (query: ClassificationQuery) => { leaveList(); current = mount(query) },
    /** The person left the screen. */
    leave: () => { states.dispose(); leaveList() },
    polling: () => timer !== undefined,
    poll: () => { const callback = timer; timer = undefined; expect(callback).toBeDefined(); callback!() },
    settled: () => vi.waitFor(() => {
      expect(states.getSnapshot()).toMatchObject({ kind: 'ok', refreshing: false })
      expect(current.lists.getSnapshot()).toMatchObject({ kind: 'ok', refreshing: false })
    }),
    html: () => renderToStaticMarkup(<ClassificationView query={current.query} state={states.getSnapshot()} list={current.lists.getSnapshot()}
      action={current.actions.getSnapshot()} onRun={noop} onRetryAction={noop} onRetryState={states.refresh} onRetryList={current.lists.refresh}
      onAction={noop} onOpen={noop} onClose={noop} />),
  }
}
/** Everything that could still be read has been: a count that stays the same is a real «nothing more». */
const quiet = async (screen: ReturnType<typeof page>) => { await turn(); await screen.settled(); await turn() }
const startButton = (html: string) => html.match(/<button[^>]*>Предложить категории<\/button>/)![0]

beforeEach(() => { clearRecognitionCsrf(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { clearRecognitionCsrf(); vi.unstubAllGlobals() })

describe('page: the person goes on while a POST is in flight', () => {
  const confirmed = () => pageOf([record('classification-confirmed.json')])
  it.each<[string, ClassificationQuery, string]>([
    ['another filter', { status: 'confirmed', page: 1 }, 'status=confirmed'],
    ['«Все»', { status: 'all', page: 1 }, 'page=1&page_size=200&ordering=-id'],
    ['another page', { page: 2 }, 'status=pending&page=2'],
    ['the records of one product', { product: 12, page: 1 }, 'product=12'],
    ['the same list again by Back and Forward', { page: 1 }, 'status=pending&page=1'],
  ])('%s: the state is read, polled and retried again, and what the POST saved is read when it answers', async (_name, query, address) => {
    const backend = server({ state: activeState(4), list: records() })
    const screen = page()
    await screen.settled()
    expect(backend.reads).toMatchObject({ state: 1, list: 1 })
    expect(screen.polling()).toBe(true)

    void screen.actions.run(confirm)
    await vi.waitFor(() => expect(backend.posts).toHaveLength(1))
    expect(backend.posts[0].url).toBe('/api/product-classifications/4/confirm/')
    // Reads wait for the answer of the action.
    expect(screen.polling()).toBe(false)
    expect(startButton(screen.html())).toContain('disabled=""')

    screen.go(query)
    await quiet(screen)
    // The pause is lifted with the actions that put it on: one read of the state, the first read of the new list.
    expect(backend.reads).toMatchObject({ state: 2, list: 2 })
    expect(backend.lists[1]).toContain(address)
    expect(screen.actions.getSnapshot()).toEqual({ kind: 'idle' })
    expect(screen.polling()).toBe(true)
    // The poll of the active run goes on, and «Повторить» of the block reads.
    screen.poll()
    await quiet(screen)
    expect(backend.reads.state).toBe(3)
    screen.states.refresh()
    await quiet(screen)
    expect(backend.reads).toMatchObject({ state: 4, list: 2 })

    // The server saves the confirmation only now, after all those reads.
    backend.data.state = activeState(3)
    backend.data.list = query.status === 'confirmed' ? confirmed() : pageOf(records().results.slice(0, 3))
    backend.posts[0].answer(classificationFixture('classification-confirmed.json'))
    await vi.waitFor(() => expect(backend.reads).toMatchObject({ state: 5, list: 3 }))
    await quiet(screen)
    // Once each, and only the list shown now: the one the action was pressed in is gone.
    expect(backend.reads).toMatchObject({ state: 5, list: 3, record: 0 })
    expect(backend.lists[2]).toBe(backend.lists[1])
    expect(screen.lists.getSnapshot()).toEqual({ kind: 'ok', data: backend.data.list, refreshing: false })
    const html = screen.html()
    expect(html).toContain('Ожидают подтверждения: 3.')
    expect(html).toContain('Запуск приостановлен: обработано 1 из 2.')
    // The answer belongs to the list that is gone: no result line, no record of it put into the new list.
    expect(html).not.toContain('Категория подтверждена.')
    expect(screen.area.close).not.toHaveBeenCalled()
    expect(screen.polling()).toBe(true)
    screen.leave()
  })
  it.each<[string, (post: Held) => void]>([
    ['is refused', (post) => post.answer(classificationFixture('error-classification-resolved.json'), 409)],
    ['gets no answer', (post) => post.fail()],
  ])('reads both once more when the POST it left %s: nothing of the answer is shown or checked', async (_name, end) => {
    const backend = server({ state: activeState(4), list: records() })
    const screen = page()
    await screen.settled()
    void screen.actions.run(confirm)
    await vi.waitFor(() => expect(backend.posts).toHaveLength(1))
    screen.go({ status: 'all', page: 1 })
    await quiet(screen)
    end(backend.posts[0])
    await vi.waitFor(() => expect(backend.reads).toMatchObject({ state: 3, list: 3 }))
    await quiet(screen)
    expect(backend.reads).toEqual({ state: 3, list: 3, record: 0 })
    expect(screen.html()).not.toMatch(/class="ck-class-error">[^<]/)
    expect(screen.polling()).toBe(true)
    screen.leave()
  })
  it('going on while the record is checked after a lost answer cancels the check and reads the state', async () => {
    const backend = server({ state: activeState(4), list: records() })
    const screen = page()
    await screen.settled()
    const running = screen.actions.run(confirm)
    await vi.waitFor(() => expect(backend.posts).toHaveLength(1))
    backend.posts[0].fail()
    await vi.waitFor(() => expect(backend.reads.record).toBe(1))
    expect(screen.polling()).toBe(false)
    screen.go({ status: 'rejected', page: 1 })
    await running
    await quiet(screen)
    expect(backend.reads).toEqual({ state: 2, list: 2, record: 1 })
    expect(screen.polling()).toBe(true)
    // The late answer of the cancelled check changes nothing and asks for nothing.
    backend.records[0].answer(classificationFixture('classification-confirmed.json'))
    await quiet(screen)
    expect(backend.reads).toEqual({ state: 2, list: 2, record: 1 })
    expect(screen.lists.getSnapshot()).toEqual({ kind: 'ok', data: backend.data.list, refreshing: false })
    screen.leave()
  })
  it('a new action in the new list keeps its own pause: the old answer reads nothing under it', async () => {
    const backend = server({ state: activeState(4), list: records() })
    const screen = page()
    await screen.settled()
    void screen.actions.run(confirm)
    await vi.waitFor(() => expect(backend.posts).toHaveLength(1))
    screen.go({ page: 1 })
    await quiet(screen)
    expect(backend.reads).toMatchObject({ state: 2, list: 2 })
    const second = screen.actions.run(reject)
    await vi.waitFor(() => expect(backend.posts).toHaveLength(2))
    expect(screen.polling()).toBe(false)
    backend.posts[0].answer(classificationFixture('classification-confirmed.json'))
    await quiet(screen)
    expect(backend.reads).toMatchObject({ state: 2, list: 2 })
    expect(screen.actions.getSnapshot().kind).toBe('pending')
    // Its own answer lifts its own pause: each request is read once, the poll goes on.
    backend.data.state = activeState(2)
    backend.data.list = pageOf(records().results.slice(0, 2))
    backend.posts[1].answer(classificationFixture('classification-rejected.json'))
    await second
    await quiet(screen)
    expect(backend.reads).toMatchObject({ state: 3, list: 3 })
    expect(screen.actions.getSnapshot()).toMatchObject({ kind: 'done', action: reject })
    expect(screen.html()).toContain('Ожидают подтверждения: 2.')
    expect(screen.polling()).toBe(true)
    screen.leave()
  })
  it('an old answer that comes after the new action has ended is read once more', async () => {
    const backend = server({ state: activeState(4), list: records() })
    const screen = page()
    await screen.settled()
    void screen.actions.run(confirm)
    await vi.waitFor(() => expect(backend.posts).toHaveLength(1))
    screen.go({ page: 1 })
    await quiet(screen)
    const second = screen.actions.run(reject)
    await vi.waitFor(() => expect(backend.posts).toHaveLength(2))
    backend.posts[1].answer(classificationFixture('classification-rejected.json'))
    await second
    await quiet(screen)
    expect(backend.reads).toMatchObject({ state: 3, list: 3 })
    backend.data.state = activeState(2)
    backend.data.list = pageOf(records().results.slice(0, 2))
    backend.posts[0].answer(classificationFixture('classification-confirmed.json'))
    await vi.waitFor(() => expect(backend.reads).toMatchObject({ state: 4, list: 4 }))
    await quiet(screen)
    expect(backend.reads).toMatchObject({ state: 4, list: 4 })
    expect(screen.lists.getSnapshot()).toEqual({ kind: 'ok', data: backend.data.list, refreshing: false })
    // The result of the action the person still sees stays.
    expect(screen.actions.getSnapshot()).toMatchObject({ kind: 'done', action: reject })
    screen.leave()
  })
  it('several lists passed during one POST: only the last one is read when it answers', async () => {
    const backend = server({ state: activeState(4), list: records() })
    const screen = page()
    await screen.settled()
    void screen.actions.run(confirm)
    await vi.waitFor(() => expect(backend.posts).toHaveLength(1))
    screen.go({ status: 'confirmed', page: 1 })
    screen.go({ status: 'rejected', page: 1 })
    screen.go({ status: 'all', page: 1 })
    await quiet(screen)
    const before = backend.lists.length
    backend.posts[0].answer(classificationFixture('classification-confirmed.json'))
    await vi.waitFor(() => expect(backend.lists).toHaveLength(before + 1))
    await quiet(screen)
    expect(backend.lists).toHaveLength(before + 1)
    expect(backend.lists.at(-1)).toContain('ordering=-id')
    expect(backend.lists.at(-1)).not.toContain('status=')
    screen.leave()
  })
})

describe('page: the person leaves the screen while a POST is in flight', () => {
  it('reads nothing after it, also when the POST answers; the screen opened again starts from its own reads', async () => {
    const backend = server({ state: activeState(4), list: records() })
    const screen = page()
    await screen.settled()
    void screen.actions.run(confirm)
    await vi.waitFor(() => expect(backend.posts).toHaveLength(1))
    screen.leave()
    await turn()
    expect(backend.reads).toEqual({ state: 1, list: 1, record: 0 })
    expect(screen.polling()).toBe(false)

    // Back to the screen before the POST has answered: a new page with requests of its own, nothing left paused.
    const again = page()
    await again.settled()
    expect(backend.reads).toEqual({ state: 2, list: 2, record: 0 })
    expect(again.polling()).toBe(true)
    expect(again.actions.getSnapshot()).toEqual({ kind: 'idle' })
    expect(startButton(again.html())).toContain('disabled=""')

    // The answer of the page that is gone reaches only requests that are gone.
    backend.posts[0].answer(classificationFixture('classification-confirmed.json'))
    await quiet(again)
    expect(backend.reads).toEqual({ state: 2, list: 2, record: 0 })
    again.poll()
    await quiet(again)
    expect(backend.reads.state).toBe(3)
    again.leave()
    await turn()
    expect(again.polling()).toBe(false)
  })
})

describe('page: an action that ends on its own screen', () => {
  it.each<[string, (post: Held) => void, { state: number; list: number; record: number }, string]>([
    ['is saved', (post) => post.answer(classificationFixture('classification-confirmed.json')), { state: 2, list: 2, record: 0 }, 'Категория подтверждена.'],
    ['is refused', (post) => post.answer(classificationFixture('error-classification-resolved.json'), 409), { state: 2, list: 2, record: 0 }, 'Предложение уже решено. Показано актуальное состояние.'],
    ['finds the catalog busy', (post) => post.answer(classificationFixture('error-classification-busy.json'), 409), { state: 2, list: 2, record: 0 },
      'Каталог сейчас изменяется: идёт импорт чека, слияние дублей или другое действие. Ничего не сохранено.'],
  ])('%s: each request is read once and the poll of the active run goes on', async (_name, end, reads, text) => {
    const backend = server({ state: activeState(4), list: records() })
    const screen = page()
    await screen.settled()
    const running = screen.actions.run(confirm)
    await vi.waitFor(() => expect(backend.posts).toHaveLength(1))
    expect(screen.polling()).toBe(false)
    end(backend.posts[0])
    await running
    await quiet(screen)
    expect(backend.reads).toEqual(reads)
    expect(screen.html()).toContain(text)
    expect(screen.polling()).toBe(true)
    screen.poll()
    await quiet(screen)
    expect(backend.reads).toEqual({ ...reads, state: reads.state + 1 })
    screen.leave()
  })
  it('gets no answer: the record is checked first, then each request is read once and the poll goes on', async () => {
    const backend = server({ state: activeState(4), list: records() })
    const screen = page()
    await screen.settled()
    const running = screen.actions.run(confirm)
    await vi.waitFor(() => expect(backend.posts).toHaveLength(1))
    backend.posts[0].fail()
    await vi.waitFor(() => expect(backend.reads.record).toBe(1))
    expect(backend.reads).toEqual({ state: 1, list: 1, record: 1 })
    expect(screen.polling()).toBe(false)
    backend.records[0].answer(classificationFixture('classification-confirmed.json'))
    await running
    await quiet(screen)
    expect(backend.reads).toEqual({ state: 2, list: 2, record: 1 })
    expect(screen.html()).toContain('Ответ сервера не получен. Действие могло выполниться: проверьте состояние записи перед повтором.')
    expect(screen.polling()).toBe(true)
    screen.leave()
  })
})
