import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createBudgetLimit, deleteBudgetLimit, getBudgetLimits, getDashboard, getMonthBudget, saveMonthBudget, updateBudgetLimit } from './budget'
import { deleteReceipt } from './receipts'
import { isBudgetLimit, isDashboard, isMonthCode } from './budget-schema'
import { dashboardFixture, limitFixture } from './budget-test-support'
import { clearRecognitionCsrf } from './local'
import { publicFixture } from './recognition-test-support'

const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const csrf = () => json(publicFixture('csrf.json'))
const token = (publicFixture('csrf.json') as { csrf_token: string }).csrf_token
const failure = (code: string, status: number, fields?: object) => json({ error: { code, message: 'private server text', ...(fields && { fields }) } }, status)
beforeEach(() => { clearRecognitionCsrf(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { clearRecognitionCsrf(); vi.useRealTimers(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('dashboard on the wire', () => {
  it('accepts the contract example and additive fields', () => {
    expect(isDashboard(dashboardFixture())).toBe(true)
    expect(isDashboard({ ...dashboardFixture(), extra: 1 })).toBe(true)
    expect(isDashboard({ ...dashboardFixture(), currencies: [], recent: [], members: ['local'] })).toBe(true)
  })
  it.each([
    ['month', '2026-13'], ['previous_month', null], ['days_left', -1], ['members', ['']], ['members', 'andrey'],
  ])('rejects %s = %j', (key, value) => {
    expect(isDashboard({ ...dashboardFixture(), [key]: value })).toBe(false)
  })
  it('rejects money that is not a decimal string and an unknown source', () => {
    const body = dashboardFixture()
    expect(isDashboard({ ...body, currencies: [{ ...body.currencies[0], spent: 287450 }] })).toBe(false)
    expect(isDashboard({ ...body, currencies: [{ ...body.currencies[0], limit_total: '1' }] })).toBe(false)
    expect(isDashboard({ ...body, currencies: [{ ...body.currencies[0], categories: [{ ...body.currencies[0].categories[0], limit_id: 0 }] }] })).toBe(false)
    expect(isDashboard({ ...body, recent: [{ ...body.recent[0], source: 'scan' }] })).toBe(false)
    expect(isDashboard({ ...body, recent: [{ ...body.recent[0], purchased_on: '2026-02-30' }] })).toBe(false)
  })
  it('accepts a category without an id and a refund month below zero', () => {
    const body = dashboardFixture()
    const block = { ...body.currencies[0], spent: '-10.00', categories: [{ category_id: null, name: 'Без категории', spent: '-10.00', limit: null, limit_id: null }] }
    expect(isDashboard({ ...body, currencies: [block] })).toBe(true)
  })
  it('knows a real month only', () => {
    for (const month of ['2026-01', '2026-12', '1999-07']) expect(isMonthCode(month)).toBe(true)
    for (const month of ['2026-00', '2026-1', '0000-05', '2026-10-01', 202610]) expect(isMonthCode(month)).toBe(false)
  })

  it('asks for the month with same-origin credentials, or for the server month without it', async () => {
    fetchMock.mockImplementation(async () => json(dashboardFixture()))
    expect(await getDashboard('2026-09', { baseUrl: '/other/' })).toEqual({ kind: 'ok', data: dashboardFixture() })
    expect(fetchMock).toHaveBeenCalledWith('/other/dashboard/?month=2026-09',
      { headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store', signal: expect.any(AbortSignal) })
    await getDashboard()
    expect(fetchMock.mock.calls[1][0]).toBe('/api/dashboard/')
  })
  it('refuses a wrong month locally and a pre-aborted caller without fetching', async () => {
    expect(await getDashboard('2026-13')).toEqual({ kind: 'error', reason: 'invalid_parameter', fields: ['month'] })
    const aborted = new AbortController(); aborted.abort()
    expect(await getDashboard('2026-09', { signal: aborted.signal })).toEqual({ kind: 'aborted' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('reports a body of another shape and a server refusal by name only', async () => {
    fetchMock.mockResolvedValueOnce(json({ month: '2026-10' }))
    expect(await getDashboard()).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
    fetchMock.mockResolvedValueOnce(failure('invalid_parameter', 400, { month: ['bad'] }))
    expect(await getDashboard('2026-09')).toEqual({ kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['month'] })
  })
  it('times out a stalled answer at 15 seconds', async () => {
    vi.useFakeTimers(); fetchMock.mockImplementation(() => new Promise(() => {}))
    const pending = getDashboard()
    await vi.advanceTimersByTimeAsync(15_000)
    expect(await pending).toEqual({ kind: 'error', reason: 'timeout' })
  })
})

describe('budget limits on the wire', () => {
  it('reads the list bare, as {results} and as a page', async () => {
    const limits = [limitFixture(), limitFixture({ id: 8, category_id: 8, category_name: 'Кафе', amount: '50000.00' })]
    // The same address three times: `fresh` asks the network each time instead of the memory of answers.
    for (const body of [limits, { results: limits }, { count: 2, page: 1, page_size: 50, pages: 1, results: limits }]) {
      fetchMock.mockResolvedValueOnce(json(body))
      expect(await getBudgetLimits({ fresh: true })).toEqual({ kind: 'ok', data: limits })
    }
    expect(fetchMock.mock.calls.map((call) => call[0])).toEqual(Array(3).fill('/api/budget/limits/'))
    fetchMock.mockResolvedValueOnce(json([{ ...limitFixture(), amount: 120000 }]))
    expect(await getBudgetLimits({ fresh: true })).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
    expect(isBudgetLimit({ ...limitFixture(), category_id: 0 })).toBe(false)
  })
  it('creates a limit with the CSRF token and the JSON body', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(json(limitFixture(), 201))
    expect(await createBudgetLimit({ category_id: 3, currency: 'KZT', amount: '120000.00' })).toEqual({ kind: 'ok', data: limitFixture() })
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/budget/limits/')
    expect(init?.method).toBe('POST')
    expect(init?.body).toBe('{"category_id":3,"currency":"KZT","amount":"120000.00"}')
    expect(init?.headers).toEqual({ Accept: 'application/json', 'X-CSRFToken': token, 'Content-Type': 'application/json' })
  })
  it('changes the amount with PATCH and deletes with an empty 204', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(json(limitFixture({ amount: '90000.00' })))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await updateBudgetLimit(7, '90000.00')).toEqual({ kind: 'ok', data: limitFixture({ amount: '90000.00' }) })
    expect(fetchMock.mock.calls[1][0]).toBe('/api/budget/limits/7/')
    expect(fetchMock.mock.calls[1][1]?.method).toBe('PATCH')
    expect(fetchMock.mock.calls[1][1]?.body).toBe('{"amount":"90000.00"}')
    expect(await deleteBudgetLimit(7)).toEqual({ kind: 'ok', data: null })
    expect(fetchMock.mock.calls[2][1]?.method).toBe('DELETE')
    expect(fetchMock.mock.calls[2][1]?.body).toBeUndefined()
  })
  it('refuses unsafe ids before any request', async () => {
    expect(await updateBudgetLimit(0, '1.00')).toEqual({ kind: 'error', reason: 'invalid_parameter', fields: ['id'] })
    expect(await deleteBudgetLimit(1.5)).toEqual({ kind: 'error', reason: 'invalid_parameter', fields: ['id'] })
    expect(await createBudgetLimit({ category_id: -1, currency: 'KZT', amount: '1.00' })).toEqual({ kind: 'error', reason: 'invalid_parameter', fields: ['category_id'] })
    expect(fetchMock).not.toHaveBeenCalled()
  })
  it('passes the names of refused fields and a missing limit, never the server text', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(failure('invalid_parameter', 400, { amount: ['private'] }))
      .mockResolvedValueOnce(failure('not_found', 404))
    expect(await createBudgetLimit({ category_id: 3, currency: 'KZT', amount: '0.00' })).toEqual({ kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['amount'] })
    expect(await deleteBudgetLimit(7)).toEqual({ kind: 'error', reason: 'not_found', status: 404 })
  })
})

describe('month budget and «можно тратить в день» (2026-10-13)', () => {
  const allowance = { currency: 'KZT', basis: 'budget', amount: '700000.00', spent: '287450.00', unpaid: '23000.00', unpaid_count: 2,
    days_left: 19, per_day: '20449.47', overspent: null }
  it('accepts the budget and the allowance of the dashboard, both optional and nullable', () => {
    const body = { ...dashboardFixture(), budget: { amount: '700000.00', currency: 'KZT', spent: '287450.00' }, allowance }
    expect(isDashboard(body)).toBe(true)
    expect(isDashboard({ ...body, budget: null, allowance: null })).toBe(true)
    expect(isDashboard({ ...body, allowance: { ...allowance, per_day: null, overspent: '1.00' } })).toBe(true)
    expect(isDashboard({ ...body, allowance: { ...allowance, basis: 'salary' } })).toBe(false)
    expect(isDashboard({ ...body, allowance: { ...allowance, per_day: 20449 } })).toBe(false)
    expect(isDashboard({ ...body, budget: { amount: '1.00', currency: 'KZT' } })).toBe(false)
  })
  it('reads, sets and removes the budget of the month with the CSRF token', async () => {
    const answer = { amount: '700000.00', currency: 'KZT', base_currency: 'KZT' }
    fetchMock.mockResolvedValueOnce(json({ ...answer, amount: null, currency: null })).mockResolvedValueOnce(csrf())
      .mockResolvedValueOnce(json(answer)).mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await getMonthBudget()).toEqual({ kind: 'ok', data: { amount: null, currency: null, base_currency: 'KZT' } })
    expect(await saveMonthBudget('700000.00')).toEqual({ kind: 'ok', data: answer })
    expect(fetchMock.mock.calls[2][0]).toBe('/api/budget/month/')
    expect(fetchMock.mock.calls[2][1]?.method).toBe('POST')
    expect(fetchMock.mock.calls[2][1]?.body).toBe('{"amount":"700000.00"}')
    expect((fetchMock.mock.calls[2][1]?.headers as Record<string, string>)['X-CSRFToken']).toBe(token)
    expect(await saveMonthBudget(null)).toEqual({ kind: 'ok', data: null })
    expect(fetchMock.mock.calls[3][1]?.method).toBe('DELETE')
  })
  it('sends a deferred DELETE of «Траты» with keepalive, an ordinary one without it', async () => {
    fetchMock.mockResolvedValueOnce(csrf()).mockResolvedValueOnce(new Response(null, { status: 204 })).mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await deleteReceipt(5, { keepalive: true })).toEqual({ kind: 'ok', data: null })
    expect(fetchMock.mock.calls[1][1]?.keepalive).toBe(true)
    expect(await deleteReceipt(6)).toEqual({ kind: 'ok', data: null })
    expect(fetchMock.mock.calls[2][1]).not.toHaveProperty('keepalive')
  })
})
