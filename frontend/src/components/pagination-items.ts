export type PaginationItem = number | 'gap-before' | 'gap-after'

/** At most seven page links, even for a large result set. pages=0 is a valid empty API result. */
export function paginationItems(page: number, pages: number): PaginationItem[] {
  if (!Number.isSafeInteger(page) || page < 1 || !Number.isSafeInteger(pages) || pages < 0) return []
  if (pages <= 1 || page > pages) return []
  if (pages <= 7) return Array.from({ length: pages }, (_, index) => index + 1)
  const start = Math.max(2, Math.min(page - 1, pages - 4))
  const end = Math.min(pages - 1, Math.max(page + 1, 5))
  const result: PaginationItem[] = [1]
  if (start > 2) result.push('gap-before')
  for (let number = start; number <= end; number++) result.push(number)
  if (end < pages - 1) result.push('gap-after')
  result.push(pages)
  return result
}
