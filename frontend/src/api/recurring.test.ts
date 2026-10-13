import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRecognitionCsrf } from './local'
import { acceptSuggestion, decideRecurring, deleteRecurring, dismissSuggestion, getRecurringMonth, isRecurringMonth, updateRecurring } from './recurring'
import { recurringFixture } from './recurring-test-support'
import { publicFixture } from './recognition-test-support'

const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const csrf = () => json(publicFixture('csrf.json'))
const token = (publicFixture('csrf.json') as { csrf_token: string }).csrf_token
beforeEach(() => { clearRecognitionCsrf(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { clearRecognitionCsrf(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

describe('regular payments on the wire', () => {
  it('accepts the month of the contract and additive fields', () => {
    expect(isRecurringMonth(recurringFixture())).toBe(true)
    expect(isRecurringMonth({ ...recurringFixture(), extra: 1 })).toBe(true)
    expect(isRecurringMonth(recurringFixture({ payments: [], questions: [], suggestions: [], totals: [] }))).toBe(true)
  })
  it('rejects an unknown state, a due day out of the month and money that is not a decimal string', () => {
    const body = recurringFixture()
    const [first] = body.payments
    expect(isRecurringMonth({ ...body, payments: [{ ...first, state: 'late' }] })).toBe(false)
    expect(isRecurringMonth({ ...body, payments: [{ ...first, due_day: 32 }] })).toBe(false)
    expect(isRecurringMonth({ ...body, payments: [{ ...first, amount: 220000 }] })).toBe(false)
    expect(isRecurringMonth({ ...body, payments: [{ ...first, history: [{ month: '2026-13', state: 'paid' }] }] })).toBe(false)
    expect(isRecurringMonth({ ...body, questions: [{ ...body.questions[0], from_history: 'yes' }] })).toBe(false)
    expect(isRecurringMonth({ ...body, suggestions: [{ ...body.suggestions[0], store_id: 0 }] })).toBe(false)
  })

  it('reads the month, refuses a wrong one locally', async () => {
    fetchMock.mockImplementation(async () => json(recurringFixture()))
    expect(await getRecurringMonth('2026-09')).toEqual({ kind: 'ok', data: recurringFixture() })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/recurring/?month=2026-09')
    await getRecurringMonth()
    expect(fetchMock.mock.calls[1][0]).toBe('/api/recurring/')
    expect(await getRecurringMonth('2026-13')).toEqual({ kind: 'error', reason: 'invalid_parameter', fields: ['month'] })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('sends answers, suggestions and changes with the CSRF token, a 409 by its status only', async () => {
    fetchMock.mockResolvedValueOnce(csrf())
      .mockResolvedValueOnce(json({ payment_id: 2, month: '2026-09', decision: 'added', receipt_id: 55 }, 201))
      .mockResolvedValueOnce(json({ error: { code: 'already_paid', message: 'private' } }, 409))
      .mockResolvedValueOnce(json({ store_id: 9, category_id: 15, currency: 'KZT' }))
      .mockResolvedValueOnce(json({ error: { code: 'not_found', message: 'private' } }, 404))
      .mockResolvedValueOnce(json({ ...recurringFixture().payments[0], amount: '230000.00' }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
    expect(await decideRecurring(2, '2026-09', 'added')).toEqual({ kind: 'ok', data: { payment_id: 2, month: '2026-09', decision: 'added', receipt_id: 55 } })
    const [url, init] = fetchMock.mock.calls[1]
    expect(url).toBe('/api/recurring/2/decision/')
    expect(init).toMatchObject({ method: 'POST', body: JSON.stringify({ month: '2026-09', decision: 'added' }) })
    expect((init?.headers as Record<string, string>)['X-CSRFToken']).toBe(token)
    expect(await decideRecurring(2, '2026-09', 'skipped')).toMatchObject({ kind: 'error', status: 409 })
    const key = { store_id: 9, category_id: 15, currency: 'KZT' }
    expect(await dismissSuggestion(key)).toEqual({ kind: 'ok', data: key })
    expect(await acceptSuggestion(key)).toMatchObject({ kind: 'error', reason: 'not_found' })
    expect(fetchMock.mock.calls[4][0]).toBe('/api/recurring/suggestions/accept/')
    expect(await updateRecurring(1, { amount: '230000' })).toMatchObject({ kind: 'ok', data: { amount: '230000.00' } })
    expect(fetchMock.mock.calls[5][1]).toMatchObject({ method: 'PATCH', body: '{"amount":"230000"}' })
    expect(await deleteRecurring(1)).toEqual({ kind: 'ok', data: null })
    expect(fetchMock.mock.calls[6][1]).toMatchObject({ method: 'DELETE' })
  })
})
