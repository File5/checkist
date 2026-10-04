import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getCategories, getCategory, getGenericProduct, getGenericProducts, getProduct, getProducts } from './catalog'
import { category, categoryDetail, detail, generic, pageOf, product } from './test-support'

const fetchMock = vi.fn<typeof fetch>()
function reply(body: unknown) { fetchMock.mockResolvedValue(new Response(JSON.stringify(body))) }
beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { vi.unstubAllGlobals() })

describe('catalog wire contract', () => {
  it('reads a flat category tree and a detail with direct children and generic briefs', async () => {
    reply({ results: [category] })
    expect(await getCategories()).toEqual({ kind: 'ok', data: { results: [category] } })
    const node = { ...categoryDetail, children: [{ ...category, id: 4, parent_id: 2, depth: 2 }] }
    reply(node)
    expect(await getCategory(2)).toEqual({ kind: 'ok', data: node })
  })
  it('keeps an orphan/cyclic parent ID while accepting the server path and depth', async () => {
    const node = { ...category, parent_id: 2, depth: 0, path: [{ id: 2, name: category.name }] }
    reply({ results: [node] })
    expect((await getCategories()).kind).toBe('ok')
  })
  it('reads generic products list and detail with countries', async () => {
    reply(pageOf([generic]))
    expect(await getGenericProducts()).toEqual({ kind: 'ok', data: pageOf([generic]) })
    reply(generic)
    expect(await getGenericProduct(5)).toEqual({ kind: 'ok', data: generic })
  })
  it('reads product list and full detail, preserving signed Decimal strings and arbitrary JSON attributes', async () => {
    reply(pageOf([product]))
    expect(await getProducts()).toEqual({ kind: 'ok', data: pageOf([product]) })
    reply(detail)
    expect(await getProduct(9)).toEqual({ kind: 'ok', data: detail })
  })
  it('accepts all documented nulls, empty strings, zero Decimal and empty arrays', async () => {
    const nullable = { ...detail, brand: null, package: null, last_observed_at: null, prices: [],
      aliases: [], stores: [], attributes: null }
    reply(nullable)
    expect(await getProduct(9)).toEqual({ kind: 'ok', data: nullable })
    const noNormalized = { ...product, package: { quantity: '0.000', unit: 'pcs' },
      prices: [{ ...product.prices[0], last: { ...product.prices[0].last,
        paid_unit_price: '0.0000', normalized_price: null, normalized_unit: null, comparable: false } }] }
    reply(pageOf([noNormalized]))
    expect((await getProducts()).kind).toBe('ok')
  })
  it.each([null, [], 'текст', true, 1, { nested: ['value', 1, false, null] }])('accepts JSON attributes %# as stored by backend', async (attributes) => {
    reply({ ...detail, attributes })
    expect((await getProduct(9)).kind).toBe('ok')
  })
  it('accepts metres as the actual normalized unit of a non-comparable package', async () => {
    const item = { ...product, prices: [{ ...product.prices[0], last: { ...product.prices[0].last,
      normalized_unit: 'm', comparable: false } }] }
    reply(pageOf([item]))
    expect((await getProducts()).kind).toBe('ok')
  })
  it('keeps a Decimal beyond Number precision untouched', async () => {
    const item = { ...product, prices: [{ ...product.prices[0], last: { ...product.prices[0].last,
      paid_unit_price: '-9999999998990000000001000000.0000' } }] }
    reply(pageOf([item]))
    expect(await getProducts()).toEqual({ kind: 'ok', data: pageOf([item]) })
  })
  it.each([
    { ...category, parent_id: null },
    { ...category, parent_id: Number.MAX_SAFE_INTEGER },
  ])('accepts nullable and maximum safe parent ID %#', async (item) => {
    reply({ results: [item] })
    expect((await getCategories()).kind).toBe('ok')
  })
  it('accepts empty tree and empty paginated first pages', async () => {
    reply({ results: [] })
    expect(await getCategories()).toEqual({ kind: 'ok', data: { results: [] } })
    reply(pageOf([]))
    expect(await getProducts()).toEqual({ kind: 'ok', data: pageOf([]) })
    reply(pageOf([]))
    expect(await getGenericProducts()).toEqual({ kind: 'ok', data: pageOf([]) })
  })
})

describe('invalid catalog schemas', () => {
  it.each([
    null, [], {}, { results: null }, { results: [null] }, { results: [{ ...category, id: '2' }] },
    { results: [{ ...category, parent_id: Number.MAX_SAFE_INTEGER + 1 }] },
    { results: [{ ...category, path: [{ id: Number.MAX_SAFE_INTEGER + 1, name: 'unsafe' }] }] },
    { results: [{ ...category, depth: -1 }] }, { results: [{ ...category, products_total: 1.1 }] },
  ])('rejects tree schema %#', async (body) => {
    reply(body)
    expect(await getCategories()).toEqual({ kind: 'error', reason: 'invalid_response', status: 200 })
  })
  it.each([
    { ...categoryDetail, children: null }, { ...categoryDetail, generic_products: {} },
    { ...categoryDetail, generic_products: [{ ...categoryDetail.generic_products[0], id: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...categoryDetail, children: [{ ...category, id: 0 }] },
  ])('rejects category detail schema %#', async (body) => {
    reply(body)
    expect((await getCategory(2))).toMatchObject({ kind: 'error', reason: 'invalid_response' })
  })
  it.each([
    { ...generic, id: Number.MAX_SAFE_INTEGER + 1 }, { ...generic, countries: null }, { ...generic, countries: [null] },
    { ...generic, base_unit: 'ml' }, { ...generic, category: { ...generic.category, path: null } },
    { ...generic, products_count: '1' },
  ])('rejects generic schema %# in both endpoints', async (body) => {
    reply(body)
    expect((await getGenericProduct(5)).kind).toBe('error')
    reply(pageOf([body]))
    expect((await getGenericProducts()).kind).toBe('error')
  })
  it.each([
    { ...product, id: Number.MAX_SAFE_INTEGER + 1 }, { ...product, brand: { id: Number.MAX_SAFE_INTEGER + 1, name: '' } },
    { ...product, generic: { ...product.generic, id: Number.MAX_SAFE_INTEGER + 1 } },
    { ...product, category: { ...product.category, id: Number.MAX_SAFE_INTEGER + 1 } },
    { ...product, prices: [{ ...product.prices[0], last: { ...product.prices[0].last, store_id: Number.MAX_SAFE_INTEGER + 1 } }] },
    { ...product, package: { quantity: 850, unit: 'ml' } }, { ...product, prices: null },
    { ...product, last_observed_at: '2026-02-30T12:00:00Z' }, { ...product, last_observed_at: '2026-10-04T00:00:00+02:00' },
    { ...product, prices: [{ ...product.prices[0], last: { ...product.prices[0].last, paid_unit_price: '1e2' } }] },
    { ...product, prices: [{ ...product.prices[0], last: { ...product.prices[0].last, normalized_price: null } }] },
    { ...product, prices: [{ ...product.prices[0], last: { ...product.prices[0].last, comparable: false } }] },
  ])('rejects product schema %#', async (body) => {
    reply(pageOf([body]))
    expect((await getProducts())).toMatchObject({ kind: 'error', reason: 'invalid_response' })
  })
  it.each([
    { ...detail, aliases: null }, { ...detail, aliases: [{ raw_name: 'missing fields' }] },
    { ...detail, stores: [{ ...detail.stores[0], id: Number.MAX_SAFE_INTEGER + 1 }] },
    { ...detail, stores: [{ ...detail.stores[0], last_purchased_on: '2026-02-29' }] },
    { ...detail, alternatives_count: null },
  ])('rejects detail schema %#', async (body) => {
    reply(body)
    expect((await getProduct(9))).toMatchObject({ kind: 'error', reason: 'invalid_response' })
  })
  it.each([
    { results: [product] }, { ...pageOf([product]), count: '1' }, { ...pageOf([product]), pages: null },
    { ...pageOf([product]), page: 0 }, { ...pageOf([product]), page_size: 201 },
    { ...pageOf([product]), pages: 2 }, { ...pageOf([]), page: 2 },
    { ...pageOf([product]), count: Number.MAX_SAFE_INTEGER + 1 },
    { ...pageOf([product]), results: {} },
    { ...pageOf([product]), count: 51, page: 2, pages: 2, results: [product, product] },
  ])('rejects pagination envelope %#', async (body) => {
    reply(body)
    expect((await getProducts())).toMatchObject({ kind: 'error', reason: 'invalid_response' })
  })
})

describe('catalog queries', () => {
  it('encodes UTF-8, literal percent/plus, separators and booleans using the public prefix', async () => {
    reply(pageOf([]))
    await getProducts({ q: 'молоко & +/?#%', category: 2, generic: 5, brand: 3, country: 'RU',
      has_prices: false, ordering: '-last_observed_at', page: 2, page_size: 24 }, { baseUrl: ' /api//v1/// ' })
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toBe('/api/v1/products/?q=%D0%BC%D0%BE%D0%BB%D0%BE%D0%BA%D0%BE+%26+%2B%2F%3F%23%25&category=2&generic=5&brand=3&country=RU&has_prices=0&ordering=-last_observed_at&page=2&page_size=24')
    reply(pageOf([]))
    await getProducts({ has_prices: true, q: undefined })
    expect(fetchMock.mock.calls[1][0]).toBe('/api/products/?has_prices=1')
  })
  it('supports category search and generic category/search/page filters', async () => {
    reply({ results: [] })
    await getCategories({ q: 'сыр &' })
    expect(fetchMock.mock.calls[0][0]).toBe('/api/categories/?q=%D1%81%D1%8B%D1%80+%26')
    reply(pageOf([]))
    await getGenericProducts({ category: 2, q: 'молоко', page: 1, page_size: 5 })
    const query = new URL(String(fetchMock.mock.calls[1][0]), 'http://localhost').searchParams
    expect(Object.fromEntries(query)).toEqual({ category: '2', q: 'молоко', page: '1', page_size: '5' })
  })
  it.each([0, -1, 1.1, Number.MAX_SAFE_INTEGER + 1, NaN, Infinity])('rejects unsafe/invalid input ID %s before fetch', async (id) => {
    expect(await getCategory(id)).toMatchObject({ kind: 'error', reason: 'invalid_parameter', fields: ['id'] })
    expect(await getGenericProduct(id)).toMatchObject({ kind: 'error', reason: 'invalid_parameter' })
    expect(await getProduct(id)).toMatchObject({ kind: 'error', reason: 'invalid_parameter' })
    expect(await getProducts({ category: id, generic: id, brand: id })).toMatchObject({ kind: 'error', reason: 'invalid_parameter' })
    expect(await getGenericProducts({ category: id })).toMatchObject({ kind: 'error', reason: 'invalid_parameter' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
