import type { ExcludedSpends } from '../api/base-currency'
import { formatMoney } from './money'
import { glue } from './text'

const spends = (count: number) => {
  const tens = count % 100
  const units = count % 10
  if (tens >= 11 && tens <= 14) return 'трат'
  return units === 1 ? 'трата' : units >= 2 && units <= 4 ? 'траты' : 'трат'
}

/** «25 $ (1 трата)» for every currency without a rate, in the server's order. */
export function excludedList(excluded: ExcludedSpends[]): string {
  return excluded.map((item) => `${formatMoney(item.total, item.currency)} (${glue(String(item.receipts_count), spends(item.receipts_count))})`).join(', ')
}

/** The note under a total in the base currency: what it does not include and why. Empty without such spends. */
export function excludedNote(excluded: ExcludedSpends[] | undefined): string {
  if (!excluded?.length) return ''
  return `Нет курса Нацбанка на дату покупки — в итог не вошли: ${excludedList(excluded)}.`
}
