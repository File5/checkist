import type { SpendingCurrency, SpendingGroupBy, SpendingItem } from '../../api/stats'
import { chartNumber } from '../../lib/charts'
import type { PieChartItem } from '../../lib/charts'
import { formatAmount, formatPercent, formatQuantity } from '../../lib/format'
import type { SpendingQuery } from '../../navigation/routes'
import { groupingCaptions, itemHref } from './spending-state'

/** Russian plural: 1 → one, 2–4 → few, 5+ and 11–14 → many. */
export function plural(count: number, one: string, few: string, many: string): string {
  const tens = Math.abs(count) % 100
  const units = tens % 10
  if (tens >= 11 && tens <= 14) return many
  return units === 1 ? one : units >= 2 && units <= 4 ? few : many
}
const counted = (count: number, one: string, few: string, many: string) => `${count.toLocaleString('ru-RU')} ${plural(count, one, few, many)}`
export const receiptsText = (count: number) => counted(count, 'чек', 'чека', 'чеков')
const linesText = (count: number) => counted(count, 'строка', 'строки', 'строк')

export const specialLabels = { unmatched: 'Строки без товара', service: 'Услуги', deposit: 'Залог за тару' } as const
export const otherLabel = 'Прочее'
export const unassignedHint = 'Категорию и обобщённый продукт товару назначают в админке.'
const specialNotes = {
  unmatched: 'Строки чеков, не сопоставленные с товаром каталога. Товар строке назначают в админке.',
  service: 'Строки услуг: в категории товаров не входят.',
  deposit: 'Залог и возврат тары, чистой суммой.',
} as const
const otherNouns: Record<SpendingGroupBy, [string, string, string]> = {
  category: ['категория', 'категории', 'категорий'], generic: ['обобщённый продукт', 'обобщённых продукта', 'обобщённых продуктов'],
  product: ['товар', 'товара', 'товаров'], store: ['магазин', 'магазина', 'магазинов'],
}

export function itemKey(item: SpendingItem): string {
  return item.id === null ? item.kind : `${item.direct ? 'direct' : item.kind}:${item.id}`
}

export function itemLabel(item: SpendingItem): string {
  switch (item.kind) {
    case 'unmatched': case 'service': case 'deposit': return specialLabels[item.kind]
    case 'store': return [item.name, item.city, item.country, `ID ${item.id}`].filter(Boolean).join(' · ')
    case 'category': return item.direct ? `${item.name}: товары без подкатегории` : item.name
    default: return item.name
  }
}

function itemNote(item: SpendingItem): string {
  const parts = [linesText(item.lines_count), receiptsText(item.receipts_count)]
  if (item.quantity !== null) parts.push(formatQuantity(item.quantity, item.unit))
  const facts = `${parts.join(' · ')}.`
  if (item.kind === 'unmatched' || item.kind === 'service' || item.kind === 'deposit') return `${specialNotes[item.kind]} ${facts}`
  return item.unassigned ? `${unassignedHint} ${facts}` : facts
}

/** Sectors and legend rows in the server's order; amounts are formatted from the wire strings, the number only draws. */
export function pieItems(block: SpendingCurrency, groupBy: SpendingGroupBy, query: SpendingQuery): PieChartItem[] {
  const items: PieChartItem[] = block.items.map((item) => ({
    key: itemKey(item), label: itemLabel(item), value: chartNumber(item.amount) ?? 0,
    valueText: formatAmount(item.amount, block.currency), shareText: formatPercent(item.share_percent),
    href: itemHref(query, item), note: itemNote(item),
    ...(item.id === null && { tone: 'muted' as const }),
  }))
  if (block.other) {
    const row: PieChartItem = {
      key: 'other', label: otherLabel, value: chartNumber(block.other.amount) ?? 0, tone: 'other',
      valueText: formatAmount(block.other.amount, block.currency), shareText: formatPercent(block.other.share_percent),
      note: `Ещё ${counted(block.other.count, ...otherNouns[groupBy])} с меньшими суммами, одной строкой.`,
    }
    // «Прочее» closes the regular items; the special rows stay after it, as on the server.
    const special = items.findIndex((item) => item.tone === 'muted')
    items.splice(special === -1 ? items.length : special, 0, row)
  }
  return items
}

export type BlockView = {
  currency: string
  /** Names the chart and captions its table. */
  title: string
  total: { label: string; text: string }
  receipts: string
  linesPaid: string
  /** Why the sum of receipts differs from the sum of lines, or why it is not shown. */
  difference: string
  center: { label: string; value: string }
  items: PieChartItem[]
  /** At least one row is «Не разобрано» or lines without a product. */
  needsAdminHint: boolean
}

export function differenceText(block: SpendingCurrency): string {
  const { receipts_total, lines_paid, difference } = block.totals
  if (receipts_total === null || difference === null) {
    return 'Выбрана категория или обобщённый продукт: считаются только строки сопоставленных товаров, поэтому сумма чеков и её разница с суммой строк не показываются.'
  }
  const money = (value: string) => formatAmount(value, block.currency)
  if (/^-?0+(\.0+)?$/.test(difference)) return `Сумма чеков совпадает с суммой строк: ${money(lines_paid)}.`
  return `Сумма чеков — ${money(receipts_total)}, сумма строк — ${money(lines_paid)}, разница — ${money(difference)}. `
    + 'Разница — это скидки на весь чек, налог сверх цен и округление: по строкам они не распределяются.'
}

export function blockView(block: SpendingCurrency, groupBy: SpendingGroupBy, query: SpendingQuery): BlockView {
  const { receipts_total, lines_paid, receipts_count } = block.totals
  const linesPaid = formatAmount(lines_paid, block.currency)
  return {
    currency: block.currency,
    title: `Траты ${groupingCaptions[groupBy]}, ${block.currency}`,
    total: receipts_total === null
      ? { label: 'Сумма строк товаров', text: linesPaid }
      : { label: 'Итого по чекам', text: formatAmount(receipts_total, block.currency) },
    receipts: receiptsText(receipts_count),
    linesPaid,
    difference: differenceText(block),
    center: { label: groupBy === 'store' && receipts_total !== null ? 'Сумма чеков' : 'Сумма строк', value: linesPaid },
    items: pieItems(block, groupBy, query),
    needsAdminHint: block.items.some((item) => item.unassigned || item.kind === 'unmatched'),
  }
}
