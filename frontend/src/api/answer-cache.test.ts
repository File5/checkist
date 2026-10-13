import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ANSWER_FRESH_MS, ANSWER_KEEP_MS, ANSWER_LIMIT, answerCount, answerKey, keepAnswer, answerGeneration, remembersPath } from './answer-cache'
import { getDashboard, saveMonthBudget } from './budget'
import { dashboardFixture } from './budget-test-support'
import { requestJson } from './http'
import { clearRecognitionCsrf } from './local'
import { getReceipt, getReceipts } from './receipts'
import { publicFixture } from './recognition-test-support'
import { OFFLINE_HEADER, resetOfflineStatus } from '../offline/status'
import { forgetCachedAnswers } from '../offline/service-worker'

const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(body), { status, headers })
const csrf = () => json(publicFixture('csrf.json'))
const urls = () => fetchMock.mock.calls.map(([url]) => String(url))
const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null
/** A dashboard of another month: the answers of the server told apart. */
const month = (code: string) => ({ ...dashboardFixture(), month: code })
/** Lets the background refresh run its microtasks. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0) })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-13T09:00:00Z'))
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
  clearRecognitionCsrf()
  resetOfflineStatus()
})
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('the policy of the memory', () => {
  it('answers a second visit within 10 seconds from memory, without the network and with its own copy', async () => {
    fetchMock.mockResolvedValueOnce(json(month('2026-10')))
    const first = await getDashboard()
    expect(first).toEqual({ kind: 'ok', data: month('2026-10') })
    if (first.kind === 'ok') first.data.recent.length = 0
    vi.advanceTimersByTime(ANSWER_FRESH_MS - 1)
    expect(await getDashboard()).toEqual({ kind: 'ok', data: month('2026-10') })
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('answers an answer older than 10 seconds at once and reads it again once in the background for the next visit', async () => {
    fetchMock.mockResolvedValueOnce(json(month('2026-10')))
    await getDashboard()
    vi.advanceTimersByTime(30_000)
    let answer!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    // Two visits while the refresh is on the way: both from memory, one refresh.
    expect(await getDashboard()).toEqual({ kind: 'ok', data: month('2026-10') })
    expect(await getDashboard()).toEqual({ kind: 'ok', data: month('2026-10') })
    expect(urls()).toEqual(['/api/dashboard/', '/api/dashboard/'])
    answer(json(month('2026-11')))
    await settle()
    // The next visit shows what the refresh brought, without asking again.
    expect(await getDashboard()).toEqual({ kind: 'ok', data: month('2026-11') })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps the refresh going when the screen that started it is gone, and ignores its failure', async () => {
    fetchMock.mockResolvedValueOnce(json(month('2026-10')))
    await getDashboard()
    vi.advanceTimersByTime(20_000)
    fetchMock.mockRejectedValueOnce(new TypeError('offline'))
    const controller = new AbortController()
    expect(await getDashboard(undefined, { signal: controller.signal })).toEqual({ kind: 'ok', data: month('2026-10') })
    controller.abort()
    await settle()
    expect(fetchMock.mock.calls[1][1]?.signal?.aborted).toBe(false)
    // The failed refresh changed nothing: the kept answer is still shown, and a new refresh starts.
    fetchMock.mockResolvedValueOnce(json(month('2026-10')))
    expect(await getDashboard()).toEqual({ kind: 'ok', data: month('2026-10') })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('forgets an answer the server refuses on the refresh: the next visit asks the network', async () => {
    fetchMock.mockResolvedValueOnce(json(publicFixture('receipt.json')))
    await getReceipt(5)
    vi.advanceTimersByTime(20_000)
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'not_found', message: 'Нет' } }, 404))
    expect((await getReceipt(5)).kind).toBe('ok')
    await settle()
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'not_found', message: 'Нет' } }, 404))
    expect(await getReceipt(5)).toMatchObject({ kind: 'error', reason: 'not_found' })
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('waits for the network as before when the answer is older than 2 minutes', async () => {
    fetchMock.mockResolvedValueOnce(json(month('2026-10')))
    await getDashboard()
    vi.advanceTimersByTime(ANSWER_KEEP_MS)
    let answer!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const pending = getDashboard()
    let done = false
    void pending.then(() => { done = true })
    await settle()
    expect(done).toBe(false)
    answer(json(month('2026-11')))
    expect(await pending).toEqual({ kind: 'ok', data: month('2026-11') })
  })

  it('asks the network when the kept answer fails the validator of the caller', async () => {
    const strict = (value: unknown): value is { month: string } => isObject(value) && value.month === '2026-11'
    fetchMock.mockResolvedValueOnce(json(month('2026-10')))
    await getDashboard()
    fetchMock.mockResolvedValueOnce(json(month('2026-11')))
    expect(await requestJson('dashboard/', {}, strict, {}, { local: true })).toMatchObject({ kind: 'ok', data: { month: '2026-11' } })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps neither a failure nor an invalid answer', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'internal_error', message: 'Ошибка' } }, 500))
    expect((await getDashboard()).kind).toBe('error')
    fetchMock.mockResolvedValueOnce(json({ month: 'октябрь' }))
    expect(await getDashboard()).toMatchObject({ kind: 'error', reason: 'invalid_response' })
    fetchMock.mockResolvedValueOnce(json(month('2026-10')))
    expect((await getDashboard()).kind).toBe('ok')
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('serves two screens asking the same address at once with one request', async () => {
    let answer!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const first = getDashboard()
    const second = getDashboard()
    answer(json(month('2026-10')))
    expect(await Promise.all([first, second])).toEqual([{ kind: 'ok', data: month('2026-10') }, { kind: 'ok', data: month('2026-10') }])
    expect(fetchMock).toHaveBeenCalledOnce()
  })

  it('lets the second screen give up while it waits, and asks the network itself when the first read failed', async () => {
    let answer!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const first = getDashboard()
    const controller = new AbortController()
    const waiting = getDashboard(undefined, { signal: controller.signal })
    controller.abort()
    expect(await waiting).toEqual({ kind: 'aborted' })
    const third = getDashboard()
    fetchMock.mockResolvedValueOnce(json(month('2026-10')))
    answer(json({ error: { code: 'internal_error', message: 'Ошибка' } }, 500))
    expect((await first).kind).toBe('error')
    expect(await third).toEqual({ kind: 'ok', data: month('2026-10') })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('tells addresses apart by their parameters, whatever their order', async () => {
    expect(answerKey('/api/receipts/?page=1&ordering=-purchased_at')).toBe(answerKey('/api/receipts/?ordering=-purchased_at&page=1'))
    expect(answerKey('/api/receipts/?page=1')).not.toBe(answerKey('/api/receipts/?page=2'))
    fetchMock.mockImplementation(async () => json({ count: 0, page: 1, page_size: 50, pages: 0, results: [] }))
    await getReceipts({ page: 1, ordering: '-purchased_at' })
    await getReceipts({ ordering: '-purchased_at', page: 1 })
    await getReceipts({ page: 2, ordering: '-purchased_at' })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('keeps at most a bounded number of answers, the oldest dropped first', () => {
    const generation = answerGeneration()
    for (let index = 0; index <= ANSWER_LIMIT; index++) keepAnswer(`/api/receipts/${index + 1}/`, { id: index + 1 }, generation)
    expect(answerCount()).toBe(ANSWER_LIMIT)
  })
})

describe('writes and the generation', () => {
  beforeEach(() => {
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/csrf/')) return csrf()
      if (init?.method === 'POST') return json({ amount: '300000.00', currency: 'KZT', base_currency: 'KZT' })
      return json(month('2026-10'))
    })
  })

  it.each([
    ['a saved write', async () => json({ amount: '300000.00', currency: 'KZT', base_currency: 'KZT' })],
    ['a refused write', async () => json({ error: { code: 'invalid_parameter', message: 'Нет', fields: { amount: ['Нет'] } } }, 400)],
    ['a write lost on the network', () => Promise.reject(new TypeError('offline'))],
  ])('forgets every kept answer after %s', async (_name, write) => {
    await getDashboard()
    await getReceipt(5).catch(() => undefined)
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/csrf/')) return csrf()
      if (init?.method === 'POST') return write()
      return json(month('2026-11'))
    })
    await saveMonthBudget('300000.00')
    expect(answerCount()).toBe(0)
    expect(await getDashboard()).toEqual({ kind: 'ok', data: month('2026-11') })
  })

  it('never keeps a background refresh that started before a write', async () => {
    await getDashboard()
    vi.advanceTimersByTime(20_000)
    let answer!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    expect(await getDashboard()).toEqual({ kind: 'ok', data: month('2026-10') })
    await saveMonthBudget('300000.00')
    answer(json(month('2026-09')))
    await settle()
    expect(answerCount()).toBe(0)
    fetchMock.mockImplementationOnce(async () => json(month('2026-11')))
    expect(await getDashboard()).toEqual({ kind: 'ok', data: month('2026-11') })
  })

  it('never keeps a read that was on the way while a write ran', async () => {
    let answer!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const reading = getDashboard()
    await saveMonthBudget('300000.00')
    answer(json(month('2026-09')))
    // The screen that asked still gets its answer; the memory does not keep it.
    expect(await reading).toEqual({ kind: 'ok', data: month('2026-09') })
    expect(answerCount()).toBe(0)
  })

  it('never keeps a read that started while a write was on the way and answered after it', async () => {
    let saved!: (response: Response) => void
    fetchMock.mockImplementation(async (url, init) => {
      if (String(url).endsWith('/csrf/')) return csrf()
      if (init?.method === 'POST') return new Promise((resolve) => { saved = resolve })
      return new Promise(() => {})
    })
    const writing = saveMonthBudget('300000.00')
    await vi.waitFor(() => { expect(saved).toBeTypeOf('function') })
    let answer!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise((resolve) => { answer = resolve }))
    const reading = getDashboard()
    saved(json({ amount: '300000.00', currency: 'KZT', base_currency: 'KZT' }))
    expect((await writing).kind).toBe('ok')
    answer(json(month('2026-09')))
    expect(await reading).toEqual({ kind: 'ok', data: month('2026-09') })
    expect(answerCount()).toBe(0)
  })

  it('forgets the memory with the answers of the phone at a sign-in, a sign-out and another person', async () => {
    await getDashboard()
    expect(answerCount()).toBe(1)
    forgetCachedAnswers()
    expect(answerCount()).toBe(0)
  })
})

describe('what is kept', () => {
  it.each([
    'dashboard/', 'receipts/', 'receipts/5/', 'receipts/5/lines/', 'receipts/5/discounts/', 'receipts/5/taxes/', 'receipts/manual/suggest/',
    'stats/spending/', 'stats/receipts/series/', 'stats/trends/monthly/', 'stats/category-spends/', 'stats/incomes/',
    'recurring/', 'incomes/', 'incomes/summary/', 'incomes/categories/', 'incomes/4/', 'goals/', 'goals/3/',
    'categories/', 'categories/2/', 'budget/limits/', 'budget/limits/history/', 'budget/month/', 'family/', 'stores/',
    'store-merges/', 'statements/rules/', 'products/', 'products/9/', 'products/9/prices/', 'products/9/prices/summary/',
    'products/9/prices/series/', 'generic-products/', 'generic-products/5/', 'brands/', 'countries/',
  ])('keeps %s', (path) => { expect(remembersPath(path)).toBe(true) })

  it.each([
    'me/', 'me/settings/', 'auth/csrf/', 'auth/login/', 'recognition/csrf/', 'recognition/jobs/', 'recognition/jobs/7/',
    'recognition/photos/3/', 'recognition/receipt-images/2/', 'receipts/manual/', 'receipts/manual/parse/', 'receipts/manual/parse/4/',
    'insights/review/', 'insights/ask/', 'insights/9/', 'push/', 'statements/', 'statements/5/', 'export/', 'health/', 'health',
    'product-merges/', 'product-merges/2/', 'product-merges/2/lines/', 'product-classifications/', 'product-classifications/status/',
    'categories/2/icon/', 'family/invites/',
  ])('never keeps %s', (path) => { expect(remembersPath(path)).toBe(false) })

  it('asks the network every time for a polled endpoint', async () => {
    fetchMock.mockImplementation(async () => json(publicFixture('job.json')))
    const ok = (value: unknown): value is object => isObject(value)
    await requestJson('recognition/jobs/7/', {}, ok, {}, { local: true })
    await requestJson('recognition/jobs/7/', {}, ok, {}, { local: true })
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(answerCount()).toBe(0)
  })

  it('reads past the memory with `fresh`, and keeps what it read', async () => {
    fetchMock.mockResolvedValueOnce(json(month('2026-10')))
    await getDashboard()
    fetchMock.mockResolvedValueOnce(json(month('2026-11')))
    expect(await getDashboard(undefined, { fresh: true })).toEqual({ kind: 'ok', data: month('2026-11') })
    expect(await getDashboard()).toEqual({ kind: 'ok', data: month('2026-11') })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('never keeps an answer the service worker took from the phone', async () => {
    fetchMock.mockResolvedValueOnce(json(month('2026-09'), 200, { [OFFLINE_HEADER]: '1' }))
    expect(await getDashboard()).toEqual({ kind: 'ok', data: month('2026-09') })
    expect(answerCount()).toBe(0)
    fetchMock.mockResolvedValueOnce(json(month('2026-10')))
    expect(await getDashboard()).toEqual({ kind: 'ok', data: month('2026-10') })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})
