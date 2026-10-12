import { describe, expect, it } from 'vitest'
import { buildRoute, parseRoute } from '../../navigation'
import { activeFilters, apiParams, buildExportQuery, exportHref, parseExportQuery, periodRange, toggled } from './export-query'
import { exportDocumentUrl, isExportPreview } from './export-api'
import { categoryOptions, matchingCategories, plural, previewText, tooLarge } from './export-state'
import type { Category } from '../../api/types'
import type { ExportPreview } from './export-api'

const today = '2026-10-12'

describe('the address of «Выгрузка»', () => {
  it('reads every filter and builds the same address back', () => {
    const search = '?period=custom&from=2026-09-01&to=2026-09-30&category=3,7&source=photo,statement&owner=andrey,liza&store=12&currency=kzt&sections=lines,media'
    const query = parseExportQuery(search)
    expect(query).toEqual({
      period: 'custom', from: '2026-09-01', to: '2026-09-30', category: [3, 7], source: ['photo', 'statement'],
      owner: ['andrey', 'liza'], store: [12], currency: 'KZT', sections: ['lines', 'media'],
    })
    expect(parseExportQuery(buildExportQuery(query))).toEqual(query)
    expect(exportHref({})).toBe('/export')
  })

  it('drops wrong values instead of refusing the page', () => {
    expect(parseExportQuery('?period=week&from=2026-02-30&category=x,0,5&source=paper&currency=12&store=-1')).toEqual({ category: [5] })
    expect(parseExportQuery('?period=custom&from=2026-10-05&to=2026-10-01')).toEqual({ period: 'custom', from: '2026-10-05' })
    // From and to belong to «Свой период» only.
    expect(parseExportQuery('?from=2026-10-01')).toEqual({})
    // The default sections never stand in the address; an empty choice does.
    expect(parseExportQuery('?sections=summary,lines,categories,stores,limits')).toEqual({})
    expect(buildExportQuery({ sections: [] })).toBe('?sections=')
    expect(parseExportQuery('?sections=')).toEqual({ sections: [] })
  })

  it('is a route of the shell', () => {
    const route = parseRoute('/export?period=all&owner=liza')
    expect(route).toEqual({ kind: 'export', query: { period: 'all', owner: ['liza'] } })
    expect(buildRoute({ kind: 'export', query: { period: 'all', owner: ['liza'] } })).toBe('/export?period=all&owner=liza')
  })
})

describe('periods and the query of /api/export/', () => {
  it.each([
    [{}, { from: '2026-10-01', to: '2026-10-31' }],
    [{ period: 'last-month' as const }, { from: '2026-09-01', to: '2026-09-30' }],
    [{ period: '3-months' as const }, { from: '2026-08-01', to: '2026-10-31' }],
    [{ period: 'year' as const }, { from: '2026-01-01', to: '2026-12-31' }],
    [{ period: 'all' as const }, {}],
    [{ period: 'custom' as const, from: '2026-05-02' }, { from: '2026-05-02' }],
  ])('%j → %j', (query, range) => {
    expect(periodRange(query, today)).toEqual(range)
  })

  it('crosses the year for «Прошлый месяц» in January', () => {
    expect(periodRange({ period: 'last-month' }, '2027-01-15')).toEqual({ from: '2026-12-01', to: '2026-12-31' })
  })

  it('always exports receipts, with the chosen sections or the given list', () => {
    expect(apiParams({ category: [3], source: ['manual'], currency: 'EUR' }, today)).toEqual({
      from: '2026-10-01', to: '2026-10-31', category: '3', source: 'manual', currency: 'EUR',
      include: 'receipts,lines,categories,stores,limits,summary',
    })
    expect(apiParams({ period: 'all', sections: ['media'] }, today)).toEqual({ include: 'receipts,media' })
    expect(apiParams({ period: 'all' }, today, ['summary', 'stores']).include).toBe('summary,stores')
  })

  it('links the document: a download and an open', () => {
    expect(exportDocumentUrl({ period: 'all', owner: ['liza'] }, today, true)).toBe('/api/export/?owner=liza&include=receipts%2Clines%2Ccategories%2Cstores%2Climits%2Csummary&download=1')
    expect(exportDocumentUrl({ period: 'all' }, today, false)).not.toContain('download')
  })

  it('counts active filters and toggles values', () => {
    expect(activeFilters({})).toBe(0)
    expect(activeFilters({ period: 'all', category: [1], currency: 'EUR' })).toBe(3)
    expect(toggled([1, 2], 2)).toEqual([1])
    expect(toggled(undefined, 'x')).toEqual(['x'])
  })
})

const category = (id: number, name: string, parent_id: number | null): Category => ({
  id, name, parent_id, path: [], depth: 0, children_count: 0, generic_products_count: 0, products_count: 0, products_total: 0,
})

describe('the category picker', () => {
  const options = categoryOptions([category(3, 'Молочное', 1), category(1, 'Продукты', null), category(7, 'Дом', null), category(9, 'Сыры', 3)])

  it('orders the tree with depths and paths', () => {
    expect(options).toEqual([
      { id: 7, name: 'Дом', depth: 0, path: 'Дом' },
      { id: 1, name: 'Продукты', depth: 0, path: 'Продукты' },
      { id: 3, name: 'Молочное', depth: 1, path: 'Продукты / Молочное' },
      { id: 9, name: 'Сыры', depth: 2, path: 'Продукты / Молочное / Сыры' },
    ])
  })

  it('finds by any part of the path, any case', () => {
    expect(matchingCategories(options, 'МОЛОЧ').map((option) => option.id)).toEqual([3, 9])
    expect(matchingCategories(options, '  ')).toHaveLength(4)
  })
})

const preview = (receipts: number, lines: number, currencies: ExportPreview['summary']['currencies'], max = 20000): ExportPreview => ({
  people: [{ username: 'andrey', display_name: 'Андрей' }], stores: [],
  summary: { receipts_count: receipts, lines_count: lines, max_receipts: max, currencies },
})

describe('the preview line', () => {
  it('says counts and sums per currency, never adding currencies', () => {
    const data = preview(3, 21, [
      { currency: 'EUR', receipts_count: 1, lines_count: 1, total: '12.30' },
      { currency: 'KZT', receipts_count: 2, lines_count: 20, total: '125000.00' },
    ])
    expect(isExportPreview(data)).toBe(true)
    const text = previewText(data).map((part) => part.text).join('')
    expect(text).toBe('Будет выгружено: 3 чека, 21 строка, сумма 13 EUR · 125 000 KZT')
    expect(previewText(data).filter((part) => part.figure)).toHaveLength(4)
  })

  it('says when nothing matches and when the file is too large', () => {
    expect(previewText(preview(0, 0, []))[0].text).toContain('ни один чек')
    expect(tooLarge(preview(20001, 0, []))).toBe(true)
    expect(tooLarge(preview(20000, 0, []))).toBe(false)
  })

  it('declines Russian words', () => {
    expect([1, 2, 5, 11, 22, 112].map((count) => plural(count, 'чек', 'чека', 'чеков'))).toEqual(['чек', 'чека', 'чеков', 'чеков', 'чека', 'чеков'])
  })

  it('refuses an answer without the summary', () => {
    expect(isExportPreview({ people: [], stores: [] })).toBe(false)
  })
})
