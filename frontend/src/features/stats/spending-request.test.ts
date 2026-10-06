import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fixturesOf, statsFixture } from '../../api/stats-test-support'
import type { Spending } from '../../api/stats'
import { createReceiptRequest } from '../receipts/request'
import { isFilteredSpending, loadSpending } from './spending-request'
import { spendingParams } from './spending-state'

const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

const parent = { id: 1, name: 'Продукты питания', path: [{ id: 1, name: 'Продукты питания' }] }
/** What the server answers to `category=1&group_by=generic`: generic items of the category and the category itself in `parent`. */
const underCategory = () => ({ ...(statsFixture('spending-generic.json') as Spending), parent })

describe('spending answer with a category filter under another breakdown', () => {
  it('accepts the category of the filter in `parent`', () => {
    expect(isFilteredSpending(underCategory())).toBe(true)
    expect(isFilteredSpending({ ...(statsFixture('spending-generic-filter.json') as Spending), parent })).toBe(true)
  })
  it.each(fixturesOf('spending-'))('agrees with the shared guard on %s', (name) => {
    expect(isFilteredSpending(statsFixture(name))).toBe(true)
  })
  it('still rejects a broken parent and a broken body', () => {
    expect(isFilteredSpending({ ...underCategory(), parent: { id: 1, name: 'x' } })).toBe(false)
    expect(isFilteredSpending({ ...underCategory(), parent: { ...parent, id: 0 } })).toBe(false)
    expect(isFilteredSpending({ ...underCategory(), parent: 'Продукты' })).toBe(false)
    const broken = underCategory()
    broken.currencies[0].items[0].amount = '12,5'
    expect(isFilteredSpending(broken)).toBe(false)
    expect(isFilteredSpending({ ...underCategory(), currencies: undefined })).toBe(false)
    expect(isFilteredSpending(null)).toBe(false)
    expect(isFilteredSpending([])).toBe(false)
  })
})

describe('loadSpending', () => {
  it('goes through the shared adapter for the default breakdown', async () => {
    fetchMock.mockResolvedValue(json(statsFixture('spending-category-drilldown.json')))
    const result = await loadSpending(spendingParams({ category: 1, store: [3, 5] }), { baseUrl: '/api' })
    expect(result).toEqual({ kind: 'ok', data: statsFixture('spending-category-drilldown.json') })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/stats/spending/?store=3%2C5&category=1')
  })
  it('requests a category under another breakdown with the same parameters and accepts the answer', async () => {
    fetchMock.mockResolvedValue(json(underCategory()))
    const result = await loadSpending(spendingParams({ date_from: '2026-01-01', country: 'DE', store: [3, 5], category: 1, group_by: 'generic' }), { baseUrl: '/api' })
    expect(result).toEqual({ kind: 'ok', data: underCategory() })
    expect(fetchMock).toHaveBeenCalledWith('/api/stats/spending/?date_from=2026-01-01&country=DE&store=3%2C5&group_by=generic&category=1',
      { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) })
  })
  it('keeps the refusals of the server on that path too', async () => {
    fetchMock.mockResolvedValue(json(statsFixture('error-permission-denied.json'), 403))
    expect(await loadSpending({ category: 1, group_by: 'product' }, { baseUrl: '/api' })).toMatchObject({ kind: 'error', reason: 'permission_denied', status: 403 })
    fetchMock.mockResolvedValue(json({ ...underCategory(), parent: 5 }))
    expect(await loadSpending({ category: 1, group_by: 'product' }, { baseUrl: '/api' })).toMatchObject({ kind: 'error', reason: 'invalid_response' })
  })
})

describe('quick filter changes', () => {
  it('aborts the request of the previous filters and ignores its late answer', async () => {
    const answers: ((response: Response) => void)[] = []
    const signals: AbortSignal[] = []
    fetchMock.mockImplementation((_url, init) => new Promise<Response>((resolve) => {
      answers.push(resolve)
      signals.push(init?.signal as AbortSignal)
    }))
    const states: string[] = []
    const first = createReceiptRequest((signal) => loadSpending({}, { signal, baseUrl: '/api' }))
    first.subscribe(() => states.push(`first:${first.getSnapshot().kind}`))
    first.start()
    await settle()
    // The screen replaces the request when the address changes: the old one is stopped, a new one starts.
    first.stop()
    const second = createReceiptRequest((signal) => loadSpending({ group_by: 'store' }, { signal, baseUrl: '/api' }))
    second.subscribe(() => states.push(`second:${second.getSnapshot().kind}`))
    second.start()
    await settle()
    expect(signals.map((signal) => signal.aborted)).toEqual([true, false])
    answers[1](json(statsFixture('spending-store.json')))
    answers[0](json(statsFixture('spending-category.json')))
    await settle()
    expect(first.getSnapshot()).toEqual({ kind: 'loading' })
    expect(second.getSnapshot()).toEqual({ kind: 'ok', data: statsFixture('spending-store.json') })
    expect(states).toEqual(['first:loading', 'second:loading', 'second:ok'])
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/api/stats/spending/', '/api/stats/spending/?group_by=store'])
  })
})
