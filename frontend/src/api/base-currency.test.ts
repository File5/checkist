import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { baseBlock, inBase, resultInBase, withBase } from './base-currency'
import { getDashboard } from './budget'
import { dashboardFixture } from './budget-test-support'
import { record } from './schema'
import { isSpending } from './stats-schema'
import { statsFixture } from './stats-test-support'

type Body = { currencies: { currency: string }[] }
const plain = (value: unknown): value is Body => record(value) && Array.isArray(value.currencies)
  && value.currencies.every((block) => record(block) && typeof block.currency === 'string')
const excluded = [{ currency: 'GBP', receipts_count: 1, total: '5.00' }]

describe('answers in the family base currency (2026-10-13)', () => {
  it('checks the converted block by the same rules as the old ones and needs every field of the statistics', () => {
    const strict = withBase(plain)
    const body = { currencies: [{ currency: 'USD' }, { currency: 'KZT' }], base_currency: 'KZT', base: { currency: 'KZT' }, excluded }
    expect(strict(body)).toBe(true)
    expect(strict({ ...body, base: null, excluded: [] })).toBe(true)
    expect(strict({ ...body, base: { currency: 1 } })).toBe(false)
    expect(strict({ ...body, base: [] })).toBe(false)
    expect(strict({ ...body, base_currency: 'tenge' })).toBe(false)
    expect(strict({ ...body, excluded: [{ currency: 'GBP', receipts_count: -1, total: '5.00' }] })).toBe(false)
    for (const key of ['base_currency', 'base', 'excluded']) {
      const missing: Record<string, unknown> = { ...body }
      delete missing[key]
      expect(strict(missing), key).toBe(false)
    }
    // Главная of an older server: without any of them it passes; with some of them, all are needed.
    const optional = withBase(plain, baseBlock, false)
    expect(optional({ currencies: [] })).toBe(true)
    expect(optional({ currencies: [], base: null })).toBe(false)
  })
  it('reads the converted block in place of the blocks per currency; an older answer stays', () => {
    const body = { currencies: [{ currency: 'USD' }, { currency: 'KZT' }], base_currency: 'KZT', base: { currency: 'KZT' }, excluded }
    expect(inBase(body).currencies).toEqual([{ currency: 'KZT' }])
    expect(inBase({ ...body, base: null }).currencies).toEqual([])
    expect(inBase({ currencies: [{ currency: 'USD' }] })).toEqual({ currencies: [{ currency: 'USD' }] })
    const limits = { limits: [{ currency: 'USD' }], base_limits: [{ currency: 'KZT' }] }
    expect(inBase(limits, { from: 'base_limits', to: 'limits', list: true }).limits).toEqual([{ currency: 'KZT' }])
    expect(resultInBase({ kind: 'error', reason: 'network' })).toEqual({ kind: 'error', reason: 'network' })
  })
  it('validates the real examples of the server: the spends without a rate (EUR of the demo) are named', () => {
    const body = statsFixture('spending-category.json') as { base_currency: string; excluded: unknown[] }
    expect(isSpending(body)).toBe(true)
    expect(body.base_currency).toBe('KZT')
    expect(body.excluded).toEqual([expect.objectContaining({ currency: 'EUR' })])
  })
})

describe('getDashboard', () => {
  const fetchMock = vi.fn<typeof fetch>()
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('shows the month in the base currency: one block, «Другие валюты» goes away', async () => {
    const data = dashboardFixture()
    const usd = { ...data.currencies[0], currency: 'USD', spent: '20.00', limit_total: null, limited_spent: null, categories: [] }
    const base = { ...data.currencies[0], spent: '296428.80' }
    const recent = [{ ...data.recent[0], total: '20.00', currency: 'USD', base_total: '8978.80' }]
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...data, currencies: [data.currencies[0], usd], recent, base_currency: 'KZT', base, excluded: [] })))
    const result = await getDashboard('2026-10')
    expect(result.kind).toBe('ok')
    if (result.kind !== 'ok') return
    expect(result.data.currencies).toEqual([base])
    expect(result.data.recent[0].base_total).toBe('8978.80')
  })
  it('refuses a spoiled block in the base currency', async () => {
    const data = dashboardFixture()
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ ...data, base_currency: 'KZT', base: { currency: 'KZT' }, excluded: [] })))
    expect(await getDashboard()).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
  })
})
