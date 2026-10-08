/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProductPrices, getProductPriceSummary } from './prices'
import { foreignPoint, history, pageOf, point, store, summary, total } from './test-support'

/** The backend's own example of a page with a foreign point; never a second copy of it. */
const foreignFixture = (): unknown => JSON.parse(readFileSync(
  new URL('../../../backend/api/tests/fixtures/auth/prices_foreign_point.json', import.meta.url), 'utf8'))
const withoutOwn = (item: object): object => Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'own'))
const receiptFields = ['observed_at', 'quantity', 'discount_amount', 'receipt_id', 'position'] as const

const fetchMock = vi.fn<typeof fetch>()
function reply(body: unknown, status = 200) { fetchMock.mockResolvedValue(new Response(JSON.stringify(body), { status })) }
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

describe('price history', () => {
  it('preserves exact signed and zero prices, nullable normalization, store brief, receipt and position', async () => {
    reply(history)
    expect(await getProductPrices(9)).toEqual({ kind: 'ok', data: history })
  })
  it('accepts an empty history page with its product', async () => {
    const body = { ...history, ...pageOf([], 200) }
    reply(body)
    expect(await getProductPrices(9)).toEqual({ kind: 'ok', data: body })
  })
  it('accepts position zero alongside other positions and receipts without dropping points', async () => {
    const points = [{ ...point, position: 0 }, { ...point, position: 1 }, { ...point, receipt_id: 13, position: 0 }]
    const body = { ...history, ...pageOf(points, 200) }
    reply(body)
    expect(await getProductPrices(9)).toEqual({ kind: 'ok', data: body })
  })
  it('accepts rows inserted between the backend count and history page query', async () => {
    const body = { ...history, count: 0, pages: 0 }
    reply(body)
    expect(await getProductPrices(9)).toEqual({ kind: 'ok', data: body })
  })
  it.each([['d', 'e'], ['de', 'eur'], ['1', '12'], ['Я', '¤'], ['😀😀', '😀😀😀']])(
    'preserves stored country/currency codes %s/%s in points and summary', async (country, currency) => {
      const body = { ...history, results: [{ ...point, store: { ...point.store, country }, currency }] }
      reply(body)
      expect(await getProductPrices(9)).toEqual({ kind: 'ok', data: body })
      const aggregate = { ...summary, groups: [{ ...summary.groups[0], country, currency }] }
      reply(aggregate)
      expect(await getProductPriceSummary(9)).toEqual({ kind: 'ok', data: aggregate })
    },
  )
  it('accepts normalized prices and actual metres without marking them comparable with litres', async () => {
    const points = [
      { ...point, normalized_price: '1.2353', normalized_unit: 'l', comparable: true },
      { ...point, normalized_price: '-0.0000', normalized_unit: 'm', comparable: false },
    ]
    reply({ ...history, ...pageOf(points, 500) })
    expect((await getProductPrices(9)).kind).toBe('ok')
  })
  it.each([
    { ...history, product: { ...history.product, id: Number.MAX_SAFE_INTEGER + 1 } },
    { ...history, page_size: 501 }, { ...history, results: null }, { ...history, product: null },
    ...[
      { ...point, receipt_id: Number.MAX_SAFE_INTEGER + 1 },
      { ...point, store: { ...point.store, id: Number.MAX_SAFE_INTEGER + 1 } },
      ...[-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '0', null, true].map((position) => ({ ...point, position })),
      { ...point, observed_at: '2026-10-04T25:00:00Z' }, { ...point, purchased_on: '2026-04-31' },
      { ...point, paid_unit_price: -1.05 }, { ...point, list_unit_price: '1.05' }, { ...point, quantity: '1.00' },
      { ...point, discount_amount: 'NaN' }, { ...point, unit: 'lb' }, { ...point, currency: null },
      { ...point, normalized_price: '1.0000', normalized_unit: null },
      { ...point, comparable: true }, { ...point, normalized_unit: 'l' },
      { ...point, store: { ...point.store, country: '' } },
      { ...point, store: { ...point.store, country: 'DEU' } },
      { ...point, currency: 'EURO' }, { ...point, currency: '' }, { ...point, currency: 123 },
    ].map((item) => ({ ...history, results: [item] })),
  ])('rejects invalid envelope/point schema %#', async (body) => {
    reply(body)
    expect(await getProductPrices(9)).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
  })
  it('keeps a malformed mandatory point as an error of the whole history block', async () => {
    reply({ ...history, ...pageOf([point, { ...point, position: -1 }], 200) })
    expect(await getProductPrices(9)).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
  })
  it('accepts the backend page with my and a foreign purchase and keeps the hidden receipt fields null', async () => {
    const body = foreignFixture()
    reply(body)
    const result = await getProductPrices(71)
    expect(result).toEqual({ kind: 'ok', data: body })
    if (result.kind !== 'ok') return
    expect(result.data.results.map((item) => item.own)).toEqual([true, false])
    for (const field of receiptFields) {
      expect(result.data.results[0][field], field).not.toBeNull()
      expect(result.data.results[1][field], field).toBeNull()
    }
  })
  it('accepts a page of foreign purchases only, even when they match in every visible field', async () => {
    const body = { ...history, ...pageOf([foreignPoint, foreignPoint], 200) }
    reply(body)
    expect(await getProductPrices(9)).toEqual({ kind: 'ok', data: body })
  })
  it.each([
    ['my purchase without own', withoutOwn(point)],
    ['foreign purchase without own', withoutOwn(foreignPoint)],
    ...['true', 1, 0, null].map((own) => [`own = ${JSON.stringify(own)}`, { ...point, own }] as [string, object]),
    ['my purchase marked foreign', { ...point, own: false }],
    ['foreign purchase marked mine', { ...foreignPoint, own: true }],
    ...receiptFields.map((field) => [`my purchase with null ${field}`, { ...point, [field]: null }] as [string, object]),
    ...receiptFields.map((field) => [`foreign purchase with ${field}`, { ...foreignPoint, [field]: point[field] }] as [string, object]),
  ])('rejects %s', async (_name, item) => {
    reply({ ...history, results: [item] })
    expect(await getProductPrices(9)).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
  })
  it('sends all history filters, canonical path and descending ordering', async () => {
    reply(history)
    await getProductPrices(9, { store: 7, country: 'de', currency: 'eur', date_from: '2026-01-01',
      date_to: '2026-10-04', ordering: '-observed_at', page: 2, page_size: 1 }, { baseUrl: 'http://localhost:18000/api///' })
    expect(fetchMock.mock.calls[0][0]).toBe('http://localhost:18000/api/products/9/prices/?store=7&country=de&currency=eur&date_from=2026-01-01&date_to=2026-10-04&ordering=-observed_at&page=2&page_size=1')
  })
})

describe('price summary', () => {
  it('reads totals, dated first/last, nullable change, signed Decimal and period buckets', async () => {
    reply(summary)
    expect(await getProductPriceSummary(9)).toEqual({ kind: 'ok', data: summary })
  })
  it.each(['country', 'store', 'none'] as const)('reads group_by=%s with its actual fields', async (group_by) => {
    const head = group_by === 'country' ? { country: 'DE' } : group_by === 'store' ? { store } : {}
    const body = { product: history.product, price: 'list', group_by, interval: 'none',
      groups: [{ ...head, currency: 'EUR', unit: 'pcs', total: { ...total, change_percent: '-3.81' }, buckets: [] }] }
    reply(body)
    expect(await getProductPriceSummary(9, { group_by, price: 'list' })).toEqual({ kind: 'ok', data: body })
  })
  it.each(['day', 'week', 'month'] as const)('reads interval=%s', async (interval) => {
    const body = { ...summary, interval }
    reply(body)
    expect((await getProductPriceSummary(9, { interval })).kind).toBe('ok')
  })
  it('requires skipped_without_normalized only in normalized mode and preserves empty groups', async () => {
    const body = { ...summary, price: 'normalized', skipped_without_normalized: 0, groups: [] }
    reply(body)
    expect(await getProductPriceSummary(9, { price: 'normalized' })).toEqual({ kind: 'ok', data: body })
    const empty = { ...summary, groups: [] }
    reply(empty)
    expect(await getProductPriceSummary(9)).toEqual({ kind: 'ok', data: empty })
  })
  it('accepts separately grouped currency/unit values without merging or filling missing periods', async () => {
    const group = summary.groups[0]
    const body = { ...summary, groups: [group, { ...group, currency: 'RUB', unit: 'l' }] }
    reply(body)
    expect(await getProductPriceSummary(9)).toEqual({ kind: 'ok', data: body })
  })
  it.each([
    { ...summary, price: 'other' }, { ...summary, group_by: 'other' }, { ...summary, interval: 'year' },
    { ...summary, product: { ...history.product, id: Number.MAX_SAFE_INTEGER + 1 } },
    { ...summary, groups: null }, { ...summary, price: 'normalized' },
    { ...summary, price: 'normalized', skipped_without_normalized: -1 },
    { ...summary, skipped_without_normalized: 0 }, { ...summary, interval: 'none' },
    { ...summary, group_by: 'store' }, { ...summary, group_by: 'none' },
    { ...summary, group_by: 'store', groups: [{ ...summary.groups[0], store }] },
    { ...summary, group_by: 'store', groups: [{ currency: 'EUR', unit: 'pcs', total, buckets: [],
      store: { ...store, id: Number.MAX_SAFE_INTEGER + 1 } }] },
    ...[
      { ...summary.groups[0], unit: null }, { ...summary.groups[0], country: null },
      { ...summary.groups[0], total: { ...total, change_percent: 0 } },
      { ...summary.groups[0], total: { ...total, count: 0 } },
      { ...summary.groups[0], total: { ...total, first: null } },
      { ...summary.groups[0], total: { ...total, min: null } },
      { ...summary.groups[0], buckets: null },
      { ...summary.groups[0], buckets: [{ ...summary.groups[0].buckets[0], count: 0 }] },
      { ...summary.groups[0], buckets: [{ ...summary.groups[0].buckets[0], period_start: '2026-02-30' }] },
      { ...summary.groups[0], buckets: [{ ...summary.groups[0].buckets[0], last: null }] },
    ].map((group) => ({ ...summary, groups: [group] })),
  ])('rejects summary schema %#', async (body) => {
    reply(body)
    expect(await getProductPriceSummary(9)).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
  })
  it('sends shared filters plus summary controls without history pagination', async () => {
    reply(summary)
    await getProductPriceSummary(9, { store: 7, country: 'DE', currency: 'EUR', date_from: '2026-01-01',
      date_to: '2026-10-04', group_by: 'store', interval: 'none', price: 'paid' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/products/9/prices/summary/?store=7&country=DE&currency=EUR&date_from=2026-01-01&date_to=2026-10-04&group_by=store&interval=none&price=paid')
  })
  it.each([0, Number.MAX_SAFE_INTEGER + 1, Infinity])('does not send unsafe product/store ID %s', async (id) => {
    expect(await getProductPrices(id)).toMatchObject({ kind: 'error', reason: 'invalid_parameter' })
    expect(await getProductPriceSummary(id)).toMatchObject({ kind: 'error', reason: 'invalid_parameter' })
    expect(await getProductPrices(9, { store: id })).toMatchObject({ kind: 'error', reason: 'invalid_parameter', fields: ['store'] })
    expect(await getProductPriceSummary(9, { store: id })).toMatchObject({ kind: 'error', reason: 'invalid_parameter' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
