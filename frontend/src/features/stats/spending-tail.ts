import type { SpendingCurrency, SpendingItem, SpendingOther, SpendingRegularItem, SpendingStoreItem } from '../../api/stats'

/** An item with an id: a category, a generic product, a product or a store. Special rows have `id: null`. */
export type SpendingTailItem = SpendingRegularItem | SpendingStoreItem

export type BlockTail =
  /**
   * `items` — what «Прочее» of the short answer consists of, in the server's order; `rest` — what did not fit the long
   * answer either. `sharesDiffer` — the shares of the two answers have different bases (see below).
   */
  | { kind: 'ok'; items: SpendingTailItem[]; rest: SpendingOther | null; sharesDiffer: boolean }
  /** The two answers do not describe the same data: nothing of the long one may be shown next to the short one. */
  | { kind: 'changed' }

const regular = (item: SpendingItem): item is SpendingTailItem => item.id !== null
const sameItem = (a: SpendingTailItem, b: SpendingTailItem) =>
  a.kind === b.kind && a.id === b.id && a.direct === b.direct && a.amount === b.amount

/**
 * The composition of «Прочее» of one currency block.
 *
 * `short` is the block of the usual answer (the server default of regular items), `long` — the block of the same
 * currency in the answer with the large `limit`. Both are slices of one sorted list, so the regular items of `long`
 * after the first `n` (`n` — the regular items of `short`) are exactly what `short.other` folds together.
 *
 * The answers were taken at different moments, so they are compared first: the sum of lines, the first `n` items
 * with their amounts and the count identity `items + rest.count = short.other.count`. Amounts are compared as the
 * wire strings: nothing here adds or converts money, and no share is recalculated.
 *
 * The shares of `long` have another base when «Прочее» holds an item that is not positive: the short answer counts
 * the roll-up by its net amount, the long one — only the positive items. That is seen on the first `n` items, whose
 * amounts are equal and whose shares are not.
 *
 * Returns `undefined` when the block has no «Прочее»: there is nothing to open.
 */
export function blockTail(short: SpendingCurrency, long: SpendingCurrency | undefined): BlockTail | undefined {
  if (short.other === null) return undefined
  if (!long || long.currency !== short.currency || long.totals.lines_paid !== short.totals.lines_paid) return { kind: 'changed' }
  const head = short.items.filter(regular)
  const all = long.items.filter(regular)
  if (all.length < head.length || !head.every((item, index) => sameItem(item, all[index]))) return { kind: 'changed' }
  const items = all.slice(head.length)
  if (items.length + (long.other?.count ?? 0) !== short.other.count) return { kind: 'changed' }
  return {
    kind: 'ok', items, rest: long.other,
    sharesDiffer: head.some((item, index) => item.share_percent !== all[index].share_percent),
  }
}
