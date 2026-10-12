import type { Category } from '../../api/types'
import { formatMoney } from '../../lib/money'
import { glue } from '../../lib/text'
import type { ExportPreview } from './export-api'

/** A category of the picker: the tree order, its depth and the path «Продукты / Молочное». */
export type CategoryOption = { id: number; name: string; depth: number; path: string }

/** The flat list of `/api/categories/` in the order of the tree: parents first, brothers by name. A node whose parent is
 * missing (or in a cycle) stands as a root. */
export function categoryOptions(categories: readonly Category[]): CategoryOption[] {
  const known = new Map(categories.map((category) => [category.id, category]))
  const children = new Map<number | null, Category[]>()
  for (const category of categories) {
    const parent = category.parent_id !== null && known.has(category.parent_id) ? category.parent_id : null
    children.set(parent, [...(children.get(parent) ?? []), category])
  }
  const byName = (a: Category, b: Category) => a.name.localeCompare(b.name, 'ru') || a.id - b.id
  const result: CategoryOption[] = []
  const seen = new Set<number>()
  const walk = (parent: number | null, depth: number, path: string[]) => {
    for (const category of [...(children.get(parent) ?? [])].sort(byName)) {
      if (seen.has(category.id)) continue
      seen.add(category.id)
      const own = [...path, category.name]
      result.push({ id: category.id, name: category.name, depth, path: own.join(' / ') })
      walk(category.id, depth + 1, own)
    }
  }
  walk(null, 0, [])
  return result
}

/** The categories whose path holds `search` (any case); all of them for an empty search. */
export function matchingCategories(options: readonly CategoryOption[], search: string): CategoryOption[] {
  const needle = search.trim().toLocaleLowerCase('ru')
  return needle ? options.filter((option) => option.path.toLocaleLowerCase('ru').includes(needle)) : [...options]
}

export function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100
  const units = count % 10
  if (tens >= 11 && tens <= 14) return many
  if (units === 1) return one
  if (units >= 2 && units <= 4) return few
  return many
}

const grouped = (count: number) => String(count).replace(/\B(?=(\d{3})+(?!\d))/g, ' ')

export type PreviewPart = { text: string; figure?: boolean }

/** «Будет выгружено: 3 чека, 4 строки, сумма 1 235 EUR · 2 500 KZT»; numbers are figures, currencies never added. */
export function previewText(data: ExportPreview): PreviewPart[] {
  const { receipts_count: receipts, lines_count: lines, currencies } = data.summary
  if (receipts === 0) return [{ text: 'Под фильтры не попал ни один чек: файл будет без трат.' }]
  const parts: PreviewPart[] = [
    { text: 'Будет выгружено: ' },
    { text: glue(grouped(receipts), plural(receipts, 'чек', 'чека', 'чеков')), figure: true },
    { text: ', ' },
    { text: glue(grouped(lines), plural(lines, 'строка', 'строки', 'строк')), figure: true },
  ]
  if (currencies.length) {
    parts.push({ text: ', сумма ' })
    currencies.forEach((block, index) => {
      if (index) parts.push({ text: ' · ' })
      parts.push({ text: formatMoney(block.total, block.currency), figure: true })
    })
  }
  return parts
}

/** More receipts than one file may hold: the server would refuse with `export_too_large`. */
export function tooLarge(data: ExportPreview): boolean {
  return data.summary.receipts_count > data.summary.max_receipts
}
