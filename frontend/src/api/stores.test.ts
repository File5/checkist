import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getStores } from './stores'
import { pageOf, storeEntry } from './test-support'

const fetchMock = vi.fn<typeof fetch>()
function reply(body: unknown) { fetchMock.mockResolvedValue(new Response(JSON.stringify(body))) }
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

describe('store directory', () => {
  it('accepts a paginated directory with empty city/address and an unknown timezone for formatter fallback', async () => {
    const body = pageOf([{ ...storeEntry, city: '', address: '', timezone: 'Unknown/Zone', receipts_count: 0 }])
    reply(body)
    expect(await getStores()).toEqual({ kind: 'ok', data: body })
  })
  it('accepts an empty first page', async () => {
    reply(pageOf([]))
    expect(await getStores()).toEqual({ kind: 'ok', data: pageOf([]) })
  })
  it.each(['d', 'de', '1', 'Я', '😀😀'])('preserves country code %s allowed by the reference model', async (country) => {
    const body = pageOf([{ ...storeEntry, country }])
    reply(body)
    expect(await getStores()).toEqual({ kind: 'ok', data: body })
  })
  it('accepts an insertion between COUNT and fetching stores', async () => {
    const body = { ...pageOf([storeEntry]), count: 0, pages: 0 }
    reply(body)
    expect(await getStores()).toEqual({ kind: 'ok', data: body })
  })
  it('encodes country, search and pagination without inventing product/currency filters', async () => {
    reply(pageOf([]))
    await getStores({ country: 'DE', q: 'магазин & +%', page: 2, page_size: 5 })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/stores/?country=DE&q=%D0%BC%D0%B0%D0%B3%D0%B0%D0%B7%D0%B8%D0%BD+%26+%2B%25&page=2&page_size=5')
  })
  it.each([
    { ...storeEntry, id: Number.MAX_SAFE_INTEGER + 1 }, { ...storeEntry, id: '7' },
    { ...storeEntry, address: null }, { ...storeEntry, timezone: null },
    { ...storeEntry, receipts_count: -1 }, { ...storeEntry, receipts_count: Number.MAX_SAFE_INTEGER + 1 },
    { ...storeEntry, country: 'Germany' },
    { ...storeEntry, country: '' }, { ...storeEntry, country: null }, { ...storeEntry, country: 12 },
  ])('rejects store schema %#', async (item) => {
    reply(pageOf([item]))
    expect(await getStores()).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
  })
})
