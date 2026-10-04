import { describe, expect, it } from 'vitest'
import { paginationItems } from './pagination-items'

describe('pagination page selection', () => {
  it('handles empty/single-page results and invalid counters without links', () => {
    for (const [page, pages] of [[1, 0], [1, 1], [0, 2], [3, 2], [1, -1], [1.5, 2], [1, NaN]]) {
      expect(paginationItems(page, pages)).toEqual([])
    }
  })
  it('includes all pages of a small result set', () => {
    expect(paginationItems(3, 5)).toEqual([1, 2, 3, 4, 5])
  })
  it('keeps boundaries and a bounded window around a large page', () => {
    expect(paginationItems(500, 1000)).toEqual([1, 'gap-before', 499, 500, 501, 'gap-after', 1000])
    expect(paginationItems(1, 1000)).toEqual([1, 2, 3, 4, 5, 'gap-after', 1000])
    expect(paginationItems(1000, 1000)).toEqual([1, 'gap-before', 996, 997, 998, 999, 1000])
  })
})
