import { describe, expect, it } from 'vitest'
import { buildReceiptsQuery, parseReceiptsQuery } from '../../navigation'
import type { ReceiptsQuery } from '../../navigation'
import { applyMe } from '../../session'
import { resetSession } from '../../session/store'
import { applyFilters, errorMessage, filterDraft, hasFilters, money, price, receiptParams, recognizedText } from './state'

describe('receipt URL filters and display values', () => {
  it('uses newest purchases first while honouring an explicit sort', () => {
    expect(receiptParams({ page: 1 })).toEqual({ page: 1, ordering: '-purchased_at' })
    expect(receiptParams({ page: 2, ordering: 'purchased_at' })).toEqual({ page: 2, ordering: 'purchased_at' })
  })
  it('applies the search/period/operation and resets page while preserving link filters', () => {
    const query: ReceiptsQuery = { page: 5, store: 51, product: 61, country: 'DE', currency: 'EUR', page_size: 2 }
    const result = applyFilters(query, { ...filterDraft(query), q: '  молоко & хлеб  ', date_from: '2026-10-01', date_to: '2026-10-04', operation: 'sale' })
    expect(result.errors).toEqual({})
    expect(result.query).toEqual({ ...query, page: 1, q: 'молоко & хлеб', date_from: '2026-10-01', date_to: '2026-10-04', operation: 'sale', ordering: '-purchased_at' })
    const url = new URL(`/receipts${buildReceiptsQuery(result.query)}`, 'http://checkist.local')
    expect(url.searchParams.get('q')).toBe('молоко & хлеб')
    expect(url.searchParams.get('page')).toBeNull()
    expect(parseReceiptsQuery(url.search).query).toEqual(result.query)
  })
  it('restores URL values for History transitions without losing filters on pagination', () => {
    const query = parseReceiptsQuery('?q=MILCH&date_from=2026-10-04&date_to=2026-10-04&operation=refund&ordering=purchased_at&page=3').query
    expect(filterDraft(query)).toEqual({ q: 'MILCH', date_from: '2026-10-04', date_to: '2026-10-04', operation: 'refund', ordering: 'purchased_at' })
    expect(parseReceiptsQuery(buildReceiptsQuery({ ...query, page: 4 })).query).toEqual({ ...query, page: 4 })
  })
  it.each(['a', 'a'.repeat(101), 'ab\ncd', 'ab\u0000cd', 'ab\ud800'])('rejects an invalid search %j before navigation', (q) => {
    expect(applyFilters({ page: 1 }, { ...filterDraft({ page: 1 }), q }).errors.q).toBeTruthy()
  })
  it.each([
    ['2026-02-30', '', 'date_from'], ['2026-10-05', '2026-10-04', 'date_from'], ['', '2026-13-01', 'date_to'],
  ])('validates calendar and inclusive range %s–%s', (date_from, date_to, field) => {
    expect(applyFilters({ page: 1 }, { ...filterDraft({ page: 1 }), date_from, date_to }).errors).toHaveProperty(field)
  })
  it('accepts equal bounds and clears visible filters without clearing product/store context', () => {
    const query = { page: 4, q: 'MILCH', store: 51, date_from: '2026-10-01' }
    const cleared = applyFilters(query, filterDraft({ page: 1 }))
    expect(cleared.query).toEqual({ page: 1, store: 51, ordering: '-purchased_at' })
    expect(cleared.errors).toEqual({})
    expect(applyFilters({ page: 1 }, { ...filterDraft({ page: 1 }), date_from: '2026-10-04', date_to: '2026-10-04' }).errors).toEqual({})
  })
  it('does not count page or sort as an empty-result filter', () => {
    expect(hasFilters({ page: 3, page_size: 2, ordering: 'purchased_at' })).toBe(false)
    expect(hasFilters({ page: 1, currency: 'EUR' })).toBe(true)
  })
  it('keeps Decimal precision, zero and negative refunds, and labels unknowns', () => {
    expect(money('9999999999999999.12', 'EUR')).toBe('9 999 999 999 999 999,12 EUR')
    expect(money('0.00', 'EUR')).toBe('0,00 EUR')
    expect(price('-1.2345', 'EUR')).toBe('-1,2345 EUR')
    expect(money('-2.38', 'EUR')).toBe('-2,38 EUR')
    expect(money(null, 'EUR')).toBe('Не распознано')
    expect(money('2.38')).toBe('2,38')
    expect(recognizedText('  ')).toBe('Не распознано')
  })
  it('names the missing right instead of the local mode to a user of accounts', () => {
    const denied = { kind: 'error' as const, reason: 'permission_denied' as const }
    const former = errorMessage(denied)
    const me = (mode: 'accounts' | 'local_single') =>
      ({ mode, user: { id: 3, username: 'anna', is_staff: false }, permissions: { moderate_catalog: mode === 'local_single' }, csrf_token: 'token' })
    try {
      applyMe(me('accounts'))
      expect(errorMessage(denied)).toBe('Нет права модератора каталога.')
      expect(errorMessage({ kind: 'error', reason: 'page_out_of_range' })).toContain('первую страницу')
      for (const enter of [() => applyMe(me('local_single')), () => applyMe(null)]) { enter(); expect(errorMessage(denied)).toBe(former) }
    } finally { resetSession() }
    expect(former).toContain('локальном режиме')
  })
  it('uses local messages for inaccessible local API and stale pages', () => {
    expect(errorMessage({ kind: 'error', reason: 'permission_denied' })).toContain('локальном режиме')
    expect(errorMessage({ kind: 'error', reason: 'page_out_of_range' })).toContain('первую страницу')
  })
})
