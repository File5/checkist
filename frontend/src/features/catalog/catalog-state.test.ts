import { describe, expect, it } from 'vitest'
import type { Category } from '../../api/types'
import { buildRoute, parseRoute } from '../../navigation'
import type { CatalogQuery, CatalogRoute } from '../../navigation'
import { categoryTree, emptyProducts, failureView, fieldError, productsParams, resetFilters, searchError, withGeneric, withPage, withSearch } from './catalog-state'

const query: CatalogQuery = { q: 'молоко', generic: 7, page: 4 }
const route: CatalogRoute = { kind: 'category', categoryId: 9, query }
const category = (id: number, depth: number, path: number[], parent_id: number | null): Category => ({
  id, name: `Категория ${id}`, parent_id, depth, path: path.map((id) => ({ id, name: `Категория ${id}` })),
  children_count: 0, generic_products_count: 0, products_count: 0, products_total: 0,
})

describe('catalog query transitions', () => {
  it('trims submitted searches, retains generic and resets only page', () => {
    expect(withSearch(query, '  сыр  ')).toEqual({ q: 'сыр', generic: 7, page: 1 })
    expect(withSearch(query, '   ')).toEqual({ generic: 7, page: 1 })
    expect(query.page).toBe(4)
  })
  it('changing or clearing generic retains the submitted search and resets page', () => {
    expect(withGeneric(query, 8)).toEqual({ q: 'молоко', generic: 8, page: 1 })
    expect(withGeneric(query)).toEqual({ q: 'молоко', page: 1 })
    expect(() => withGeneric(query, Number.MAX_SAFE_INTEGER + 1)).toThrow(RangeError)
  })
  it('paging and recovery retain filters; reset retains category scope', () => {
    expect(withPage(route, 1)).toEqual({ ...route, query: { ...query, page: 1 } })
    expect(resetFilters(route)).toEqual({ kind: 'category', categoryId: 9, query: { page: 1 } })
  })
  it('builds request filters for the entire category branch, without invented client filters', () => {
    expect(productsParams(query, 9)).toEqual({ q: 'молоко', generic: 7, category: 9, page: 4 })
    expect(productsParams({ page: 1 })).toEqual({ page: 1 })
    expect(productsParams(query)).toEqual({ q: 'молоко', generic: 7, page: 4 })
  })
  it('query URLs round-trip search punctuation and Unicode through History routes', () => {
    const filtered = { ...route, query: withSearch(query, 'молоко & сыр + 2%') }
    const href = buildRoute(filtered)
    expect(href).not.toContain('& сыр')
    expect(parseRoute(href)).toEqual(filtered)
    expect(parseRoute(buildRoute(withPage(filtered, 3)))).toEqual(withPage(filtered, 3))
    expect(parseRoute(buildRoute(route))).toEqual(route) // Back to the previous query.
  })
})

describe('search validation before requests', () => {
  it('gives a short-query hint and accepts an empty search as reset', () => {
    expect(searchError(' м ')).toContain('не менее 2')
    expect(searchError('  ')).toBeUndefined()
    expect(searchError('молоко')).toBeUndefined()
    expect(() => withSearch(query, 'м')).toThrow(RangeError)
  })
  it('counts code points, rejects more than 100 and unsafe characters', () => {
    expect(searchError('😀'.repeat(100))).toBeUndefined()
    expect(searchError('😀'.repeat(101))).toContain('не более 100')
    expect(searchError('ab\n')).toContain('недопустимые')
    expect(searchError('ab\u0085')).toContain('недопустимые')
    expect(searchError('ab\ud800')).toContain('недопустимые')
  })
})

describe('server category hierarchy', () => {
  it('uses path/depth even when parent_id forms a cycle and child precedes parent', () => {
    const leaf = category(3, 2, [1, 2, 3], 1)
    const root = category(1, 0, [1], 2)
    const child = category(2, 1, [1, 2], 1)
    const tree = categoryTree([leaf, root, child])
    expect(tree).toHaveLength(1)
    expect(tree[0].category.id).toBe(1)
    expect(tree[0].children[0].category.id).toBe(2)
    expect(tree[0].children[0].children[0].category.id).toBe(3)
  })
  it('keeps direct children visible when their ancestor is absent from the response', () => {
    const categories = [category(3, 1, [1, 3], 1), category(2, 1, [1, 2], 1)]
    expect(categoryTree(categories).map(({ category }) => category.id)).toEqual([3, 2])
    expect(categories[0].path).toHaveLength(2)
  })
  it('handles empty and deep repaired paths without following parent_id recursively', () => {
    expect(categoryTree([])).toEqual([])
    const categories = Array.from({ length: 200 }, (_, index) => category(index + 1, index,
      Array.from({ length: index + 1 }, (_, ancestor) => ancestor + 1), index === 0 ? 200 : index))
    const tree = categoryTree(categories)
    let node = tree[0]
    for (let depth = 1; depth < 200; depth += 1) node = node.children[0]
    expect(node.category.id).toBe(200)
  })
})

describe('empty and error states', () => {
  it('distinguishes no matches, a branch with children, an empty leaf and empty catalog', () => {
    expect(emptyProducts(query, true, 2)).toContain('Ничего не найдено')
    expect(emptyProducts({ page: 1, generic: 7 }, false)).toContain('Ничего не найдено')
    expect(emptyProducts({ page: 1 }, true, 2)).toBe('Выберите подкатегорию.')
    expect(emptyProducts({ page: 1 }, true)).toContain('В этой категории')
    expect(emptyProducts({ page: 1 }, false)).toBe('Каталог пока пуст.')
  })
  it('separates missing object from invalid page, without treating them as retry errors', () => {
    expect(failureView({ kind: 'error', reason: 'not_found', status: 404 }).kind).toBe('missing')
    expect(failureView({ kind: 'error', reason: 'page_out_of_range', status: 404 }).kind).toBe('page')
  })
  it.each(['invalid_parameter', 'invalid_request', 'range_too_large'] as const)('requires correction for 400 %s', (reason) => {
    expect(failureView({ kind: 'error', reason, status: 400 }).kind).toBe('fields')
  })
  it('even an invalid response with HTTP 400 offers correction instead of repeating the same query', () => {
    expect(failureView({ kind: 'error', reason: 'invalid_response', status: 400 }).kind).toBe('fields')
    expect(fieldError({ kind: 'error', reason: 'invalid_parameter', fields: ['q'] }, 'q')).toContain('Исправьте запрос')
    expect(fieldError({ kind: 'error', reason: 'invalid_parameter', fields: ['q'] }, 'generic')).toBeUndefined()
  })
  it.each(['network', 'server', 'timeout', 'invalid_response'] as const)('offers explicit retry for %s', (reason) => {
    expect(failureView({ kind: 'error', reason }).kind).toBe('retry')
  })
})
