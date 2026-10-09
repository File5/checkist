import type { Spending, SpendingCurrency } from '../../api/stats'

/** Exact cents of a wire amount: the helpers never go through a float. */
export const cents = (amount: string) => BigInt(amount.replace('.', ''))
const wire = (value: bigint) => {
  const digits = (value < 0n ? -value : value).toString().padStart(3, '0')
  return `${value < 0n ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`
}

/**
 * The usual answer made of a long one, as the server cuts it: the first `keep` regular items stay, the rest and the
 * «прочее» of the long answer are folded into one «прочее». The share of the roll-up is the caller's: only the
 * server knows it. The examples of the backend hold no pair «short and long answer of one request».
 */
export function shortBlock(long: SpendingCurrency, keep: number, share: string | null = '50.00'): SpendingCurrency {
  const regular = long.items.filter((item) => item.id !== null)
  const folded = regular.slice(keep)
  const count = folded.length + (long.other?.count ?? 0)
  const amount = folded.reduce((total, item) => total + cents(item.amount), long.other ? cents(long.other.amount) : 0n)
  return {
    ...long,
    items: [...regular.slice(0, keep), ...long.items.filter((item) => item.id === null)],
    other: count > 0 ? { count, amount: wire(amount), share_percent: share } : null,
  }
}
export const shortAnswer = (long: Spending, keep: number, share?: string | null): Spending =>
  ({ ...long, currencies: long.currencies.map((block) => shortBlock(block, keep, share)) })
