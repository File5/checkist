import { describe, expect, it } from 'vitest'
import { isReceiptListItem } from '../api/receipts-schema'
import { publicFixture } from '../api/recognition-test-support'
import { buildReceiptsQuery, buildRoute, parseReceiptsQuery, parseRoute } from './routes'

describe('«Траты»: the family filter in the address', () => {
  it('reads a username of the family and keeps it in a canonical place of the query', () => {
    expect(parseReceiptsQuery('?owner=liza&page=2')).toEqual({ query: { owner: 'liza', page: 2 }, invalidFields: [] })
    expect(parseReceiptsQuery('?owner=%D0%9B%D0%B8%D0%B7%D0%B0')).toEqual({ query: { owner: 'Лиза', page: 1 }, invalidFields: [] })
    expect(parseReceiptsQuery('?owner=a.b%2Bc-d_e%40f').query.owner).toBe('a.b+c-d_e@f')
    expect(buildReceiptsQuery({ page: 3, ordering: 'purchased_at', owner: 'liza', q: 'MILCH' })).toBe('?q=MILCH&owner=liza&page=3&ordering=purchased_at')
    expect(buildRoute({ kind: 'receipts', query: { page: 1, owner: 'andrey' } })).toBe('/receipts?owner=andrey')
  })

  it('treats an empty owner as no filter and takes the last of repeated ones', () => {
    expect(parseReceiptsQuery('?owner=').query).toEqual({ page: 1 })
    expect(parseReceiptsQuery('?owner=%20%20').query).toEqual({ page: 1 })
    expect(parseReceiptsQuery('?owner=andrey&owner=liza').query.owner).toBe('liza')
  })

  it('refuses what cannot be a username instead of sending it to the server', () => {
    for (const owner of ['two%20words', '%3Cb%3E', 'x'.repeat(151), '%00', 'a%2Fb']) {
      const parsed = parseReceiptsQuery(`?owner=${owner}`)
      expect(parsed.invalidFields, owner).toEqual(['owner'])
      expect(parsed.query.owner, owner).toBeUndefined()
    }
    expect(parseReceiptsQuery(`?owner=${'x'.repeat(150)}`).invalidFields).toEqual([])
    expect(parseRoute('/receipts?owner=two%20words')).toMatchObject({ kind: 'invalid-query', fields: ['owner'] })
    expect(() => buildReceiptsQuery({ page: 1, owner: 'two words' })).toThrow(RangeError)
  })

  it('parses the route with the owner together with other filters', () => {
    expect(parseRoute('/receipts?owner=liza&currency=kzt')).toEqual({ kind: 'receipts', query: { owner: 'liza', currency: 'KZT', page: 1 } })
  })
})

describe('«Траты»: the list item of the API', () => {
  const item = (publicFixture('receipts.json') as { results: Record<string, unknown>[] }).results[0]

  it('accepts the item with the two list fields, with null and without them (an older server)', () => {
    expect(item.first_line).toBe('MILCH 1 L')
    expect(item.category).toEqual({ id: 81, name: 'Тест', icon: null })
    expect(isReceiptListItem(item)).toBe(true)
    expect(isReceiptListItem({ ...item, first_line: null, category: null })).toBe(true)
    const older = { ...item }
    delete older.first_line
    delete older.category
    expect(isReceiptListItem(older)).toBe(true)
  })

  it('refuses list fields of a wrong shape', () => {
    expect(isReceiptListItem({ ...item, first_line: 5 })).toBe(false)
    expect(isReceiptListItem({ ...item, category: { id: 'x', name: 'Тест' } })).toBe(false)
    expect(isReceiptListItem({ ...item, category: 'Тест' })).toBe(false)
  })
})
