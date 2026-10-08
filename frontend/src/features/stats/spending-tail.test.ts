import { describe, expect, it } from 'vitest'
import { statsFixture } from '../../api/stats-test-support'
import type { Spending, SpendingCurrency } from '../../api/stats'
import { blockTail } from './spending-tail'
import { cents, shortBlock } from './spending-tail-test-support'

const read = (name: string) => statsFixture(name) as Spending
const generic = () => read('spending-generic.json').currencies[0]
const ids = (items: readonly { id: number | null }[]) => items.map((item) => item.id)

describe('composition of «Прочее»: the usual answer and the long one of the same request', () => {
  it('takes the regular items of the long answer after the first ones, in the order of the server', () => {
    const long = generic()
    const short = shortBlock(long, 2)
    expect(ids(short.items)).toEqual([15, 11, null, null, null])
    expect(short.other).toEqual({ count: 12, amount: '6145.09', share_percent: '50.00' })
    const tail = blockTail(short, long)
    expect(tail).toEqual({ kind: 'ok', items: long.items.slice(2, 5), rest: long.other, sharesDiffer: false })
    expect(tail?.kind === 'ok' && ids(tail.items)).toEqual([13, 3, 6])
  })
  it('keeps the two identities of the pair: the counts and, in whole cents, the amounts', () => {
    for (const name of ['spending-generic.json', 'spending-product.json', 'spending-store.json', 'spending-category.json']) {
      for (const long of read(name).currencies) {
        const short = shortBlock(long, 1)
        const tail = blockTail(short, long)
        if (short.other === null) { expect(tail).toBeUndefined(); continue }
        if (tail?.kind !== 'ok') throw new Error(`${name} ${long.currency}: the pair was refused`)
        expect(tail.items.length + (tail.rest?.count ?? 0)).toBe(short.other.count)
        const sum = tail.items.reduce((total, item) => total + cents(item.amount), tail.rest ? cents(tail.rest.amount) : 0n)
        expect(sum).toBe(cents(short.other.amount))
        expect(tail.items.every((item) => item.id !== null)).toBe(true)
      }
    }
  })
  it('has no remainder when the whole list fitted the long answer', () => {
    const long = read('spending-store.json').currencies[0]
    expect(long.other).toBeNull()
    expect(blockTail(shortBlock(long, 1), long)).toEqual({ kind: 'ok', items: [long.items[1]], rest: null, sharesDiffer: false })
  })
  it('shows the remainder alone when the long answer is not longer than the usual one', () => {
    const long = generic()
    expect(blockTail(long, long)).toEqual({ kind: 'ok', items: [], rest: long.other, sharesDiffer: false })
  })
  it('has nothing to open in a block without «Прочее», whatever the long answer holds', () => {
    const block = read('spending-store.json').currencies[0]
    expect(blockTail(block, block)).toBeUndefined()
    expect(blockTail(block, undefined)).toBeUndefined()
    expect(blockTail(block, generic())).toBeUndefined()
  })
  it('notices another base of the shares by the first items: equal amounts, different shares', () => {
    const long = generic()
    const short = shortBlock(long, 2)
    short.items[0] = { ...short.items[0], share_percent: '40.01' }
    expect(blockTail(short, long)).toMatchObject({ kind: 'ok', sharesDiffer: true })
    // A share that is absent on one side only is a different base too.
    const refund = shortBlock(long, 2)
    refund.items[1] = { ...refund.items[1], share_percent: null }
    expect(blockTail(refund, long)).toMatchObject({ kind: 'ok', sharesDiffer: true })
  })

  type Edit = (long: SpendingCurrency) => SpendingCurrency | undefined
  const changed = (edit: Edit) => {
    const long = generic()
    return blockTail(shortBlock(long, 2), edit(long))
  }
  it.each<[string, Edit]>([
    ['the currency is absent in the long answer', () => undefined],
    ['the block is of another currency', (long) => ({ ...long, currency: 'KZT' })],
    ['the sum of lines differs', (long) => ({ ...long, totals: { ...long.totals, lines_paid: '13083.67' } })],
    ['the first items come in another order', (long) => ({ ...long, items: [long.items[1], long.items[0], ...long.items.slice(2)] })],
    ['an amount of a first item differs', (long) => ({ ...long, items: [{ ...long.items[0], amount: '5184.92' }, ...long.items.slice(1)] })],
    ['a first item is another row with the same id', (long) => ({ ...long, items: [{ ...long.items[0], direct: true }, ...long.items.slice(1)] })],
    ['the long answer is shorter than the usual one', (long) => ({ ...long, items: long.items.slice(4) })],
    ['an item appeared in the tail', (long) => ({ ...long, other: long.other && { ...long.other, count: long.other.count + 1 } })],
    ['an item left the tail', (long) => ({ ...long, items: [...long.items.slice(0, 4), ...long.items.slice(5)] })],
    ['the remainder vanished', (long) => ({ ...long, other: null })],
  ])('refuses the pair when %s', (_name, edit) => {
    expect(changed(edit)).toEqual({ kind: 'changed' })
  })
  it('compares amounts as the wire strings, never as numbers', () => {
    // 5184.91 and 5184.910 are one number and two different answers of the server: the pair is not trusted.
    expect(changed((long) => ({ ...long, items: [{ ...long.items[0], amount: '5184.910' }, ...long.items.slice(1)] }))).toEqual({ kind: 'changed' })
  })
})
