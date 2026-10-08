import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProductClassifications, getProductClassificationState } from '../../api/product-classifications'
import type { Classification, ClassificationRun, ClassificationState } from '../../api/product-classifications'
import { classificationFixture } from '../../api/product-classifications-test-support'
import type { Executor } from '../../api/recognition-types'
import type { Page } from '../../api/types'
import type { ClassificationQuery } from '../../navigation'
import { createPollingRequest } from '../recognition/polling'
import type { PollEnvironment } from '../recognition/polling'
import type { ActionState } from './actions'
import { ClassificationView } from './ClassificationPage'
import { areaNotice, errorText } from './labels'
import { afterAction, countsAgree, createReadSync, listOutdated, syncReads } from './list-sync'
import type { Read, ReadSync } from './list-sync'
import { areaFate, areaSeen, listParams, openedArea, stateActive } from './state'
import type { OpenArea } from './state'
import { pageOf, record, records, refusal, stateOf, success } from './test-support'

/**
 * The server applies suggestions after every batch, so the list has to follow the state while the run is still active.
 * State bodies are the server's own examples with other numbers; they reach the requests through the real adapters.
 */
const between = () => structuredClone(classificationFixture('status-between-batches.json')) as ClassificationState
const idleWorker: Executor = { available: true, state: 'idle', last_seen_at: '2026-10-06T10:20:07Z' }
type Patch = Partial<Omit<ClassificationState, 'run'>> & { run?: Partial<Omit<ClassificationRun, 'progress'>> & { progress?: Partial<ClassificationRun['progress']> } }
/** The run between its batches, three products requested, nothing processed yet unless said. */
const stateWith = ({ run = {}, ...patch }: Patch = {}): ClassificationState => {
  const body = between()
  const progress = { ...body.run!.progress, requested: 3, processed: 0, applied: 0, ...run.progress }
  return { ...body, pending_count: 0, unclassified_count: 3, ...patch, run: { ...body.run!, ...run, progress } }
}
const done = (pending: number, progress: Partial<ClassificationRun['progress']> = { processed: 3, applied: 3 }) =>
  stateWith({ pending_count: pending, unclassified_count: 0, run: { status: 'succeeded', finished_at: '2026-10-06T10:20:30Z', progress } })
const firstRecords = (count: number) => pageOf(records().results.slice(0, count))
const idle = <T,>(data: T): Read<T> => ({ data, refreshing: false })
const busy = <T,>(data: T): Read<T> => ({ data, refreshing: true })
const pendingList = {}

describe('«нужно перечитать список»: two reads of the state', () => {
  it('reads the list again when a batch was processed between them, while the run is still active', () => {
    const one = stateWith({ pending_count: 1, run: { progress: { processed: 1, applied: 1 } } })
    const two = stateWith({ pending_count: 2, run: { progress: { processed: 2, applied: 2 } } })
    expect(stateActive(two)).toBe(true)
    expect(listOutdated(one, two)).toBe(true)
    // A batch that suggested nothing new may still have closed stale records: the progress alone is enough.
    expect(listOutdated(one, { ...one, run: { ...one.run!, progress: { ...one.run!.progress, processed: 2 } } })).toBe(true)
    expect(listOutdated(one, { ...one, run: { ...one.run!, progress: { ...one.run!.progress, applied: 2 } } })).toBe(true)
  })
  it('does not read it when the run only went from the queue to the worker or nothing changed', () => {
    const queued = stateWith({ pending_count: 1, run: { progress: { processed: 1, applied: 1 } } })
    const running = { ...queued, executor: idleWorker, run: { ...queued.run!, status: 'running' as const, version: queued.run!.version + 1 } }
    expect(listOutdated(queued, running)).toBe(false)
    expect(listOutdated(running, { ...queued, run: { ...queued.run!, version: queued.run!.version + 2 } })).toBe(false)
    expect(listOutdated(queued, structuredClone(queued))).toBe(false)
    expect(listOutdated(queued, { ...queued, unclassified_count: 9, auto_suggest: true })).toBe(false)
  })
  it('reads it exactly once when the run ends', () => {
    const steps = [
      stateWith(),
      stateWith({ run: { status: 'running' } }),
      stateWith({ pending_count: 1, run: { progress: { processed: 1, applied: 1 } } }),
      stateWith({ pending_count: 1, run: { status: 'running', progress: { processed: 1, applied: 1 } } }),
      // The last batch found nothing: only the end of the run says that the list may differ.
      done(1, { processed: 1, applied: 1 }),
      done(1, { processed: 1, applied: 1 }),
      done(1, { processed: 1, applied: 1 }),
    ]
    expect(steps.map((step, index) => listOutdated(steps[index - 1], step))).toEqual([false, false, true, false, true, false, false])
  })
  it('reads it when «Ожидают подтверждения» changed without any run on this screen', () => {
    const before = stateOf('status.json')
    expect(listOutdated(before, { ...before, pending_count: before.pending_count - 1 })).toBe(true)
    expect(listOutdated(before, { ...before, pending_count: before.pending_count + 2 })).toBe(true)
    const empty = stateOf('status-empty.json')
    expect(listOutdated(empty, { ...empty, pending_count: 1 })).toBe(true)
    expect(listOutdated(empty, structuredClone(empty))).toBe(false)
  })
  it('takes the first read as the beginning and a run that has just been queued as no work yet', () => {
    expect(listOutdated(undefined, stateWith({ pending_count: 5, run: { progress: { processed: 2, applied: 2 } } }))).toBe(false)
    const finished = stateOf('status.json')
    const queued = { ...finished, run: { ...stateWith().run!, id: finished.run!.id + 1 } }
    expect(listOutdated(finished, queued)).toBe(false)
    // A run of a command or of an import met for the first time with a batch already processed.
    expect(listOutdated(finished, { ...queued, run: { ...queued.run, progress: { ...queued.run.progress, processed: 1 } } })).toBe(true)
    expect(listOutdated(stateOf('status-empty.json'), { ...stateOf('status-empty.json'), run: queued.run })).toBe(false)
  })
})

describe('counts of the list against «Ожидают подтверждения»', () => {
  it.each<[string, Pick<ClassificationQuery, 'status' | 'product'>, number[]]>([
    ['all pending records are exactly as many', {}, [4]],
    ['pending records of one product are not more', { product: 7 }, [0, 1, 2, 3, 4]],
    ['all records are not fewer', { status: 'all' }, [4, 5, 6]],
    ['all records of one product say nothing', { status: 'all', product: 7 }, [0, 1, 2, 3, 4, 5, 6]],
    ['confirmed records say nothing', { status: 'confirmed' }, [0, 1, 2, 3, 4, 5, 6]],
    ['rejected records say nothing', { status: 'rejected' }, [0, 1, 2, 3, 4, 5, 6]],
    ['superseded records say nothing', { status: 'superseded', product: 7 }, [0, 1, 2, 3, 4, 5, 6]],
  ])('%s', (_, filter, agreeing) => {
    expect([0, 1, 2, 3, 4, 5, 6].filter((count) => countsAgree({ pending_count: 4 }, count, filter))).toEqual(agreeing)
  })
})

describe('«нужно перечитать»: every published state of the two requests', () => {
  /** Feeds the states one by one, as the page does, and collects the asked rereads. */
  const feed = (steps: [Read<ClassificationState> | undefined, Read<Page<Classification>> | undefined][], filter = pendingList, memory: ReadSync = {}) => {
    const asked: (string | undefined)[] = []
    for (const [state, list] of steps) {
      const result = syncReads(memory, state, list, filter)
      memory = result.memory
      asked.push(result.reread)
    }
    return asked
  }
  it('asks for nothing while the first reads agree, in any order of their answers', () => {
    const state = stateWith({ pending_count: 4 })
    const list = records()
    expect(feed([[undefined, undefined], [idle(state), undefined], [idle(state), idle(list)], [idle(state), idle(list)]])).toEqual([undefined, undefined, undefined, undefined])
    expect(feed([[undefined, idle(list)], [idle(state), idle(list)]])).toEqual([undefined, undefined])
  })
  it('reads the list again when the first reads disagree and the state came last', () => {
    const state = stateWith({ pending_count: 4 })
    expect(feed([[undefined, idle(firstRecords(3))], [idle(state), idle(firstRecords(3))]])).toEqual([undefined, 'list'])
  })
  it('reads the state again when the list came last, then once the other side, and never loops', () => {
    const state = stateWith({ pending_count: 3 })
    const list = records()
    const sameState = structuredClone(state)
    const sameList = structuredClone(list)
    expect(feed([
      [idle(state), undefined],
      [idle(state), idle(list)],
      [busy(state), idle(list)],
      // The state answered the same: the list is read once too.
      [idle(sameState), idle(list)],
      [idle(sameState), busy(list)],
      // Both were read and still disagree: nothing more is asked, also on every later poll.
      [idle(sameState), idle(sameList)],
      [busy(sameState), idle(sameList)],
      [idle(structuredClone(state)), idle(sameList)],
      [idle(structuredClone(state)), idle(sameList)],
    ])).toEqual([undefined, 'state', undefined, 'list', undefined, undefined, undefined, undefined, undefined])
  })
  it('starts over when the disagreement is another one or was resolved in between', () => {
    const list = records()
    const three = stateWith({ pending_count: 3 })
    const four = stateWith({ pending_count: 4 })
    expect(feed([
      // The list answered the same, so the state is read; a third answer asks for nothing.
      [idle(three), idle(list)], [idle(three), idle(structuredClone(list))], [idle(structuredClone(three)), idle(list)],
      [idle(four), idle(list)],
      // The counts changed back without a run: the change itself reads the list.
      [idle(structuredClone(three)), idle(list)],
    ])).toEqual(['list', 'state', undefined, 'list', 'list'])
  })
  it('waits for a read under way instead of asking for another one', () => {
    const state = stateWith({ pending_count: 4 })
    const list = firstRecords(3)
    expect(feed([[idle(state), busy(list)], [busy(state), idle(list)], [idle(state), idle(list)]])).toEqual([undefined, undefined, 'list'])
  })
  it('reads the list after a batch although its earlier read is still under way: that one may be older', () => {
    const one = stateWith({ pending_count: 1, run: { progress: { processed: 1, applied: 1 } } })
    const two = stateWith({ pending_count: 2, run: { progress: { processed: 2, applied: 2 } } })
    const list = firstRecords(1)
    expect(feed([[idle(one), idle(list)], [busy(one), idle(list)], [idle(two), busy(list)]])).toEqual([undefined, undefined, 'list'])
  })
  it('does not answer a batch when the list was never read: its own block shows that and offers the retry', () => {
    const one = stateWith({ pending_count: 1, run: { progress: { processed: 1, applied: 1 } } })
    const two = stateWith({ pending_count: 2, run: { progress: { processed: 2, applied: 2 } } })
    expect(feed([[idle(one), undefined], [idle(two), undefined]])).toEqual([undefined, undefined])
  })
  it('takes the reads restarted by an action as a new beginning: no second read of the list', () => {
    const before = stateWith({ pending_count: 4 })
    const after = stateWith({ pending_count: 3 })
    const list = records()
    const replaced = structuredClone(list)
    const fresh = firstRecords(3)
    // The action is over: its records are shown, both requests read again.
    expect(feed([[busy(before), busy(replaced)], [idle(after), busy(replaced)], [idle(after), idle(fresh)], [idle(after), idle(fresh)]], pendingList, afterAction))
      .toEqual([undefined, undefined, undefined, undefined])
    expect(feed([[busy(before), busy(replaced)], [busy(before), idle(fresh)], [idle(after), idle(fresh)]], pendingList, afterAction)).toEqual([undefined, undefined, undefined])
    // Without that the decision of the person itself would look like a change made elsewhere.
    expect(feed([[idle(before), idle(list)], [idle(after), idle(fresh)]])).toEqual([undefined, 'list'])
    // The answers after an action are still compared with each other.
    expect(feed([[busy(before), busy(replaced)], [idle(after), idle(replaced)]], pendingList, afterAction)).toEqual([undefined, 'list'])
  })
  it('follows a batch under every filter and compares the counts only where they are bound', () => {
    const one = stateWith({ pending_count: 1, run: { progress: { processed: 1, applied: 1 } } })
    const two = stateWith({ pending_count: 2, run: { progress: { processed: 2, applied: 2 } } })
    const decided = pageOf([record('classification-confirmed.json')])
    for (const filter of [{ status: 'confirmed' }, { status: 'rejected' }, { status: 'superseded' }, { status: 'all' }, { product: 7 }, { status: 'all', product: 7 }] as const) {
      expect(feed([[idle(one), idle(decided)], [idle(structuredClone(one)), idle(decided)], [idle(two), idle(decided)]], filter), JSON.stringify(filter)).toEqual([undefined, undefined, 'list'])
    }
    const four = stateWith({ pending_count: 4 })
    expect(feed([[idle(four), idle(firstRecords(3))]], { status: 'all' })).toEqual(['list'])
    expect(feed([[idle(stateWith({ pending_count: 1 })), idle(firstRecords(2))]], { product: 7 })).toEqual(['list'])
    expect(feed([[idle(four), idle(firstRecords(3))]], { status: 'confirmed' })).toEqual([undefined])
    expect(feed([[idle(four), idle(firstRecords(3))]], { product: 7 })).toEqual([undefined])
  })
})

const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200 })
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

const noop = () => {}
const noAction: ActionState = { kind: 'idle' }
/** The two requests of the page with the real adapters and its real connection; timers are fired by hand. */
function screen(server: { state: ClassificationState; list: Page<Classification> }, query: ClassificationQuery = { page: 1 }) {
  let pending: (() => void) | undefined
  const env: PollEnvironment = {
    hidden: () => false, listen: () => () => {},
    later: (callback) => { pending = callback; return 0 as unknown as ReturnType<typeof setTimeout> },
    clear: () => { pending = undefined },
  }
  const reads = { state: 0, list: 0 }
  const urls: string[] = []
  fetchMock.mockImplementation(async (input) => {
    const url = String(input)
    const side = url.includes('/status/') ? 'state' : 'list'
    reads[side]++
    if (side === 'list') urls.push(url)
    return json(server[side])
  })
  const states = createPollingRequest((signal) => getProductClassificationState({ signal }), stateActive, undefined, env)
  const lists = createPollingRequest((signal) => getProductClassifications(listParams(query), { signal }), undefined, undefined, env)
  const sync = createReadSync(states, lists, query)
  const settled = () => vi.waitFor(() => {
    expect(states.getSnapshot()).toMatchObject({ kind: 'ok', refreshing: false })
    expect(lists.getSnapshot()).toMatchObject({ kind: 'ok', refreshing: false })
  })
  states.start()
  lists.start()
  const stop = sync.start()
  return {
    states, lists, sync, reads, urls, settled, polling: () => pending !== undefined,
    /** The next poll of the state and everything it leads to. */
    poll: async () => { const callback = pending; pending = undefined; expect(callback).toBeDefined(); callback!(); await settled() },
    html: (open?: OpenArea, notice?: string) => renderToStaticMarkup(<ClassificationView query={query} state={states.getSnapshot()} list={lists.getSnapshot()}
      action={noAction} open={open} notice={notice} onRun={noop} onRetryAction={noop} onRetryState={noop} onRetryList={noop} onAction={noop} onOpen={noop} onClose={noop} />),
    dispose: () => { stop(); states.dispose(); lists.dispose() },
  }
}
const nothingWaits = 'Товаров, ожидающих подтверждения категории, нет.'
const paused = (processed: number) => `Запуск приостановлен: обработано ${processed} из 3.`
const running = (processed: number) => `Модель предлагает категории: обработано ${processed} из 3.`
const productNames = (page: Page<Classification>) => page.results.map((item) => item.product.name)

describe('page: the list follows the batches of an active run', () => {
  it('shows the records of every batch without a reload and reads the list only when something changed', async () => {
    const server = { state: stateWith(), list: firstRecords(0) }
    const page = screen(server)
    await page.settled()
    expect(page.reads).toEqual({ state: 1, list: 1 })
    expect(page.urls[0]).toContain('status=pending')
    expect(page.html()).toContain(nothingWaits)

    // The worker took the run and has not finished a batch: polls go on, the list is left alone.
    await page.poll()
    server.state = stateWith({ executor: idleWorker, run: { status: 'running', version: 5 } })
    await page.poll()
    expect(page.reads).toEqual({ state: 3, list: 1 })

    // First batch applied, the worker is gone: «Запуск приостановлен», and the record is already in the list.
    server.state = stateWith({ pending_count: 1, unclassified_count: 2, run: { version: 6, progress: { processed: 1, applied: 1 } } })
    server.list = firstRecords(1)
    await page.poll()
    expect(page.reads).toEqual({ state: 4, list: 2 })
    expect(stateActive(server.state)).toBe(true)
    let html = page.html()
    expect(html).toContain('Ожидают подтверждения: 1. Без категории: 2.')
    expect(html).toContain(paused(1))
    expect(html).not.toContain(nothingWaits)
    for (const name of productNames(server.list)) expect(html).toContain(name)
    expect(html).toMatch(/<button type="button">Подтвердить<span/)

    // The run stays paused: every later poll reads only the state.
    await page.poll()
    await page.poll()
    await page.poll()
    expect(page.reads).toEqual({ state: 7, list: 2 })

    // The worker is back: `queued → running` with the same progress changes nothing in the list.
    server.state = { ...server.state, executor: idleWorker, run: { ...server.state.run!, status: 'running', version: 7 } }
    await page.poll()
    expect(page.reads).toEqual({ state: 8, list: 2 })

    // Second batch, the run is between its batches with a worker.
    server.state = stateWith({ executor: idleWorker, pending_count: 2, unclassified_count: 1, run: { version: 8, progress: { processed: 2, applied: 2 } } })
    server.list = firstRecords(2)
    await page.poll()
    expect(page.reads).toEqual({ state: 9, list: 3 })
    html = page.html()
    expect(html).toContain(running(2))
    expect(html).toContain('Ожидают подтверждения: 2. Без категории: 1.')
    for (const name of productNames(server.list)) expect(html).toContain(name)

    // Third batch closes the run: the list is read once and the poll stops.
    server.state = done(3)
    server.list = firstRecords(3)
    await page.poll()
    expect(page.reads).toEqual({ state: 10, list: 4 })
    expect(page.polling()).toBe(false)
    expect(page.html()).toContain('Запуск завершён: предложено 3, не распознано 0, пропущено 0.')
    expect(page.lists.getSnapshot()).toEqual({ kind: 'ok', data: server.list, refreshing: false })
    page.dispose()
  })
  it('reads the list once when the last batch and the end of the run come in one answer, and once when the end comes alone', async () => {
    const server = { state: stateWith({ pending_count: 1, run: { progress: { processed: 2, applied: 1 } } }), list: firstRecords(1) }
    const page = screen(server)
    await page.settled()
    server.state = done(2, { processed: 3, applied: 2 })
    server.list = firstRecords(2)
    await page.poll()
    expect(page.reads).toEqual({ state: 2, list: 2 })
    page.dispose()

    fetchMock.mockReset()
    const quiet = { state: stateWith({ pending_count: 1, run: { progress: { processed: 3, applied: 1 } } }), list: firstRecords(1) }
    const other = screen(quiet)
    await other.settled()
    quiet.state = done(1, { processed: 3, applied: 1 })
    await other.poll()
    expect(other.reads).toEqual({ state: 2, list: 2 })
    expect(other.polling()).toBe(false)
    other.dispose()
  })
  it('opened between two batches with a disagreement, brings the two reads together and stops', async () => {
    // The first answer of the list does not fit the state: a batch or a decision fell between the two reads.
    let listReads = 0
    const server = {
      state: stateWith({ pending_count: 1, run: { progress: { processed: 1, applied: 1 } } }),
      get list() { return firstRecords(listReads++ === 0 ? 2 : 1) },
    }
    const page = screen(server)
    await vi.waitFor(() => expect(page.reads.list).toBe(2))
    await page.settled()
    // Whichever answer came last, at most one extra read of each side and no contradiction on the screen.
    expect(page.reads.list).toBe(2)
    expect(page.reads.state).toBeLessThanOrEqual(2)
    const html = page.html()
    expect(html).toContain('Ожидают подтверждения: 1.')
    expect(html).toContain('Всего: 1\u00a0запись.')
    const reads = { ...page.reads }
    await page.poll()
    expect(page.reads).toEqual({ state: reads.state + 1, list: reads.list })
    page.dispose()
  })
  it('opened on a state and a list that keep disagreeing, reads each side once more and then only polls', async () => {
    const server = { state: stateWith({ pending_count: 6 }), list: records() }
    const page = screen(server)
    await page.settled()
    await vi.waitFor(() => expect(page.reads).toEqual({ state: 2, list: 2 }))
    await page.settled()
    for (let poll = 0; poll < 4; poll++) await page.poll()
    expect(page.reads).toEqual({ state: 6, list: 2 })
    page.dispose()
  })
  it('follows «Ожидают подтверждения» changed without a run when the state is read again by hand', async () => {
    const server = { state: { ...stateOf('status.json'), pending_count: 4 }, list: records() }
    const page = screen(server)
    await page.settled()
    expect(page.polling()).toBe(false)
    expect(page.reads).toEqual({ state: 1, list: 1 })
    // Another tab confirmed a record; nothing polls here, so the screen learns it with its next read of the state.
    server.state = { ...server.state, pending_count: 3 }
    server.list = firstRecords(3)
    page.states.refresh()
    await page.settled()
    expect(page.reads).toEqual({ state: 2, list: 2 })
    expect(page.html()).toContain('Всего: 3\u00a0записи.')
    page.states.refresh()
    await page.settled()
    expect(page.reads).toEqual({ state: 3, list: 2 })
    page.dispose()
  })
  it.each<[string, ClassificationQuery, string]>([
    ['«Все»', { status: 'all', page: 1 }, 'ordering=-id'],
    ['«Заменённые»', { status: 'superseded', page: 1 }, 'status=superseded'],
    ['«Подтверждённые»', { status: 'confirmed', page: 1 }, 'status=confirmed'],
    ['the pending records of one product', { product: 12, page: 1 }, 'product=12'],
  ])('reads the list of %s after every batch as well', async (_, query, part) => {
    const server = { state: stateWith({ pending_count: 4 }), list: pageOf([...records().results, record('classification-confirmed.json'), record('classification-superseded.json')]) }
    if (query.product !== undefined) server.list = firstRecords(1)
    const page = screen(server, query)
    await page.settled()
    await page.poll()
    expect(page.reads).toEqual({ state: 2, list: 1 })
    server.state = stateWith({ pending_count: 4, run: { progress: { processed: 1, skipped: 1 } } })
    await page.poll()
    expect(page.reads).toEqual({ state: 3, list: 2 })
    expect(page.urls.every((url) => url.includes(part))).toBe(true)
    await page.poll()
    expect(page.reads).toEqual({ state: 4, list: 2 })
    page.dispose()
  })
  it('reads «Все» again when it holds fewer records than are pending', async () => {
    const server = { state: { ...stateOf('status.json'), pending_count: 4 }, list: firstRecords(3) }
    const page = screen(server, { status: 'all', page: 1 })
    server.list = records()
    await page.settled()
    await vi.waitFor(() => expect(page.reads.list).toBe(2))
    await page.settled()
    expect(page.reads.list).toBe(2)
    expect(page.reads.state).toBeLessThanOrEqual(2)
    expect(page.html()).toContain('Всего: 4\u00a0записи.')
    page.dispose()
  })
})

describe('page: reads wait during a POST', () => {
  it('reads nothing while the action is being saved and each request once after it', async () => {
    const server = { state: stateWith({ pending_count: 4, run: { progress: { processed: 1, applied: 1 } } }), list: records() }
    const page = screen(server)
    await page.settled()
    expect(page.reads).toEqual({ state: 1, list: 1 })
    // The page pauses both requests before the POST.
    page.states.pause()
    page.lists.pause()
    expect(page.polling()).toBe(false)
    // A batch is applied and the record is confirmed meanwhile; even a state given by the action asks for no read.
    server.state = stateWith({ pending_count: 4, run: { progress: { processed: 2, applied: 2 } } })
    page.states.setData(server.state)
    await Promise.resolve()
    expect(page.reads).toEqual({ state: 1, list: 1 })
    expect(page.lists.getSnapshot()).toMatchObject({ kind: 'ok', refreshing: false })
    // The answer of the action: both are resumed, the decision of the person is not «a change made elsewhere».
    server.state = stateWith({ pending_count: 3, run: { progress: { processed: 2, applied: 2 } } })
    server.list = firstRecords(3)
    page.sync.afterAction()
    page.states.resume()
    page.lists.resume()
    await page.settled()
    expect(page.reads).toEqual({ state: 2, list: 2 })
    await page.poll()
    expect(page.reads).toEqual({ state: 3, list: 2 })
    page.dispose()
  })
})

describe('page: a read of the list and the open area', () => {
  const kefir = () => records().results.filter((item) => item.suggested.generic.name === 'Кефир')
  const bumped = (item: Classification): Classification => ({ ...item, version: item.version + 1 })
  it('keeps «Выбрать другой», the rejection and «Подтвердить все» open while their records are what the person saw', () => {
    const list = records().results
    const [first] = kefir()
    const areas: OpenArea[] = [{ kind: 'choose', id: first.id }, { kind: 'reject', id: first.id }, { kind: 'bulk', genericId: first.suggested.generic.id }]
    for (const area of areas) {
      const opened = openedArea(area, list)!
      expect(opened).toEqual({ area, seen: areaSeen(area, list) })
      // The same list read again: new objects, the same records.
      expect(areaFate(opened, structuredClone(list))).toBe('open')
      // A batch added a record of another group before and after it.
      const other = { ...record('classification-pending.json'), id: 900, suggested: { ...list.at(-1)!.suggested, generic: { ...list.at(-1)!.suggested.generic, id: 901, name: 'Абрикосы' } } }
      expect(areaFate(opened, [other, ...structuredClone(list), { ...other, id: 902 }])).toBe('open')
    }
  })
  it('closes the area of a record that changed, was decided or left the list', () => {
    const list = records().results
    const [first, second] = kefir()
    for (const kind of ['choose', 'reject'] as const) {
      const opened = openedArea({ kind, id: first.id }, list)!
      expect(areaFate(opened, list.map((item) => item.id === first.id ? bumped(item) : item))).toBe('changed')
      expect(areaFate(opened, list.filter((item) => item.id !== first.id))).toBe('gone')
      expect(areaFate(opened, list.map((item) => item.id === first.id ? record('classification-confirmed.json') : item).map((item, index) => index ? item : { ...item, id: first.id }))).toBe('gone')
      expect(areaFate(opened, list.map((item) => item.id === first.id ? { ...item, actions: { can_confirm: false, can_choose: false, can_reject: false } } : item))).toBe('gone')
      // Another record of the same group changed: this one is the same.
      expect(areaFate(opened, list.map((item) => item.id === second.id ? bumped(item) : item))).toBe('open')
    }
  })
  it('closes «Подтвердить все» when the records it would send are not the ones the question named', () => {
    const list = records().results
    const [first, second] = kefir()
    const opened = openedArea({ kind: 'bulk', genericId: first.suggested.generic.id }, list)!
    expect(opened.seen).toBe(`${first.id}:${first.version},${second.id}:${second.version}`)
    // A batch suggested the same generic product for one more product.
    expect(areaFate(opened, [...list, { ...first, id: 950 }])).toBe('changed')
    expect(areaFate(opened, list.map((item) => item.id === second.id ? bumped(item) : item))).toBe('changed')
    expect(areaFate(opened, list.filter((item) => item.id !== second.id))).toBe('changed')
    expect(areaFate(opened, list.filter((item) => item.suggested.generic.id !== first.suggested.generic.id))).toBe('gone')
    expect(openedArea({ kind: 'bulk', genericId: 777 }, list)).toBeUndefined()
    expect(openedArea({ kind: 'reject', id: 777 }, list)).toBeUndefined()
  })
  it('says why an area was closed in the words of the refusal the action would have got', () => {
    expect(areaNotice('changed', { kind: 'choose', id: 1 })).toBe(errorText(refusal('error-classification-changed.json'), 'action'))
    expect(areaNotice('changed', { kind: 'reject', id: 1 })).toBe('Предложение изменилось. Данные обновлены: проверьте запись и повторите действие.')
    expect(areaNotice('gone', { kind: 'choose', id: 1 })).toBe('Предложение уже решено либо записи больше нет в этом списке. Показано актуальное состояние.')
    expect(areaNotice('changed', { kind: 'bulk', genericId: 93 })).toBe('Состав группы изменился. Данные обновлены: проверьте группу и повторите действие.')
    expect(areaNotice('gone', { kind: 'bulk', genericId: 93 })).toBe('В группе больше нет записей для подтверждения. Показано актуальное состояние.')
  })

  const statuses = (html: string) => [...html.matchAll(/<p[^>]*role="status"[^>]*>(.*?)<\/p>/g)].map((match) => match[1])
  const chooser = (html: string, id: number) => html.match(new RegExp(`<div class="ck-class-area" role="group" aria-labelledby="class-choose-${id}-title">.*?</div></div>`))?.[0]
  it('leaves the open chooser, its place in the list and every status line as they were after a batch', async () => {
    const all = records().results
    const [first] = kefir()
    const server = { state: stateWith({ pending_count: 2, run: { progress: { processed: 1, applied: 2 } } }), list: pageOf(kefir()) }
    const page = screen(server)
    await page.settled()
    const area: OpenArea = { kind: 'choose', id: first.id }
    const opened = openedArea(area, server.list.results)!
    const before = page.html(area)
    expect(chooser(before, first.id)).toContain('Поиск обобщённого продукта')

    // The next batch adds the other groups; the run is still active.
    server.state = stateWith({ pending_count: 4, run: { progress: { processed: 2, applied: 4 } } })
    server.list = pageOf(structuredClone(all))
    await page.poll()
    expect(page.reads).toEqual({ state: 2, list: 2 })
    const shown = page.lists.getSnapshot()
    if (shown.kind !== 'ok') throw new Error(JSON.stringify(shown))
    expect(areaFate(opened, shown.data.results)).toBe('open')
    const after = page.html(area)
    // The same area under the same record: the component keeps its typed search and chosen option, nothing is remounted.
    expect(chooser(after, first.id)).toBe(chooser(before, first.id))
    expect(after).toContain('Всего: 4\u00a0записи.')
    // Only the line of the run changed its text; the result lines of actions stay empty: nothing extra is announced.
    expect(statuses(before)).toEqual([expect.stringContaining(paused(1)), '', ''])
    expect(statuses(after)).toEqual([expect.stringContaining(paused(2)), '', ''])
    // While the list is being read, the block is not «loading» and the area is still there.
    server.state = stateWith({ pending_count: 4, run: { progress: { processed: 3, applied: 4 } } })
    let reading: string | undefined
    const unsubscribe = page.lists.subscribe(() => {
      const current = page.lists.getSnapshot()
      if (current.kind === 'ok' && current.refreshing) reading = page.html(area)
    })
    await page.poll()
    unsubscribe()
    expect(page.reads).toEqual({ state: 3, list: 3 })
    expect(reading).toMatch(/aria-labelledby="class-list-title" aria-busy="false"/)
    expect(chooser(reading!, first.id)).toBe(chooser(before, first.id))
    expect(reading).not.toContain('Загружаем данные…')
    page.dispose()
  })
  it('closes the area of a record changed by the read and says so in the result line of the list', async () => {
    const [first] = kefir()
    const server = { state: stateWith({ pending_count: 4, run: { progress: { processed: 1, applied: 4 } } }), list: records() }
    const page = screen(server)
    await page.settled()
    const area: OpenArea = { kind: 'choose', id: first.id }
    const opened = openedArea(area, server.list.results)!
    server.state = stateWith({ pending_count: 4, run: { progress: { processed: 2, applied: 4 } } })
    server.list = pageOf(records().results.map((item) => item.id === first.id ? bumped(item) : item))
    await page.poll()
    const shown = page.lists.getSnapshot()
    if (shown.kind !== 'ok') throw new Error(JSON.stringify(shown))
    const fate = areaFate(opened, shown.data.results)
    expect(fate).toBe('changed')
    // What the page renders for this fate: no area, the message instead.
    const text = areaNotice('changed', area)
    const html = page.html(undefined, text)
    expect(chooser(html, first.id)).toBeUndefined()
    expect(html).toContain(`<div class="ck-class-result-bar ck-class-result-shown" data-request-focus-own=""><p tabindex="-1" role="status" aria-live="polite" class="ck-class-error">${text}</p></div>`)
    expect(html).toMatch(/Выбрать другой<span class="ck-class-hidden">/)
    page.dispose()
  })
  it('puts the message before the result of an earlier action and withdraws its «Повторить»', () => {
    const busyAction: ActionState = {
      kind: 'failed', action: { type: 'reject', id: 1, input: { version: 1 } }, error: refusal('error-classification-busy.json'),
      message: errorText(refusal('error-classification-busy.json'), 'action'),
    }
    const view = (notice?: string) => renderToStaticMarkup(<ClassificationView query={{ page: 1 }} state={success(stateOf('status.json'))} list={success(records())}
      action={busyAction} notice={notice} onRun={noop} onRetryAction={noop} onRetryState={noop} onRetryList={noop} onAction={noop} onOpen={noop} onClose={noop} />)
    expect(view()).toContain('>Повторить</button>')
    expect(view()).toContain(busyAction.message)
    const text = areaNotice('gone', { kind: 'reject', id: 1 })
    expect(view(text)).toContain(text)
    expect(view(text)).not.toContain(busyAction.message)
    expect(view(text)).not.toContain('>Повторить</button>')
  })
})
