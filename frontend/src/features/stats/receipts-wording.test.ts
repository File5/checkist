import { describe, expect, it } from 'vitest'
import { isReceiptCompare } from '../../api/stats-schema'
import { statsFixture } from '../../api/stats-test-support'
import type { CompareCurrency, CompareEffects, ReceiptCompare } from '../../api/stats'
import {
  decimalSign, decompositionBar, effectParts, fewMatchedProducts, indexAssumption, indexChangePercent, lowCoveragePercent, noLinesNote, noMatchedNote,
  plural, priceIndexSummary, refundsNote, sideFacts, signedAmount, signedPercent, verdict,
} from './receipts-wording'

/** Non-breaking spaces of the number format read as ordinary ones in the expectations. */
const plain = (text: string | null) => (text ?? '').replace(/[\u00a0\u202f]/g, ' ')
function compare(name: string): ReceiptCompare {
  const body = statsFixture(name)
  if (!isReceiptCompare(body)) throw new Error(`${name} does not match the runtime schema`)
  return body
}
const main = compare('compare-2020-2026.json')
const [eur, kzt] = main.currencies
/** The demo block with other terms; the sum of the terms still equals the change. */
function block(change: string | null, effects: Partial<CompareEffects> | null, patch: Partial<CompareCurrency> = {}): CompareCurrency {
  return {
    ...eur, change: { avg_receipt: change, avg_receipt_percent: change === null ? null : eur.change.avg_receipt_percent },
    effects: effects && { ...eur.effects!, ...effects }, ...patch,
  }
}

describe('signs and signed numbers', () => {
  it.each([['18.71', 1], ['-3.10', -1], ['0.00', 0], ['-0.00', 0], ['0', 0], [null, null], ['abc', null], ['1e3', null]] as const)(
    'reads the sign of %s without a float', (value, sign) => expect(decimalSign(value)).toBe(sign))
  it('marks only a positive value with a plus', () => {
    expect(plain(signedAmount('8.65', 'EUR'))).toBe('+8,65 EUR')
    expect(plain(signedAmount('-3.10', 'EUR'))).toBe('-3,10 EUR')
    expect(plain(signedAmount('0.00', 'EUR'))).toBe('0,00 EUR')
    expect(signedAmount(null, 'EUR')).toBe('—')
    expect(plain(signedPercent('46.23'))).toBe('+46,23 %')
    expect(plain(signedPercent('-12.50'))).toBe('-12,50 %')
  })
  it.each([[1, 'поход'], [2, 'похода'], [5, 'походов'], [11, 'походов'], [21, 'поход'], [112, 'походов'], [0, 'походов']] as const)(
    'declines the noun for %i', (value, form) => expect(plural(value, ['поход', 'похода', 'походов'])).toBe(form))
})

describe('the answer in words (server fixtures)', () => {
  it('names growth, its size and the main cause for the main question of the demo', () => {
    const result = verdict(eur)
    expect(result.kind).toBe('grew')
    expect(plain(result.headline)).toBe('Средний чек вырос на 18,71 EUR (+69,27 %): с 27,01 EUR до 45,72 EUR.')
    expect(plain(result.lead)).toBe('Главная причина: стал покупать больше позиций за поход — +8,65 EUR, 46,23 % изменения.')
    expect(result.note).toBeNull()
    expect(result.parts.map((part) => [part.key, part.amount, part.percent, part.phrase, part.against])).toEqual([
      ['quantity', '8.65', '46.23', 'стал покупать больше позиций за поход', false],
      ['price', '7.39', '39.50', 'выросли цены на те же товары', false],
      ['mix', '2.67', '14.27', 'другой состав покупок: позиции в среднем дороже', false],
    ])
  })
  it('picks prices as the main cause where they outweigh quantity (KZT)', () => {
    const result = verdict(kzt)
    expect(plain(result.headline)).toBe('Средний чек вырос на 4 424,92 KZT (+144,88 %): с 3 054,29 KZT до 7 479,21 KZT.')
    expect(plain(result.lead)).toBe('Главная причина: выросли цены на те же товары — +2 822,60 KZT, 63,79 % изменения.')
  })
  it('shows quantity and the price per line when no product was bought in both periods', () => {
    const [only] = compare('compare-no-matched-products.json').currencies
    const result = verdict(only)
    expect(only.price_index).toBeNull()
    expect(result.parts.map((part) => [part.key, part.amount, part.percent])).toEqual([['quantity', '8.02', '37.55'], ['price_per_line', '13.34', null]])
    expect(result.parts[1].title).toBe('Цена позиции (цены и состав вместе)')
    expect(result.note).toBe(noMatchedNote)
    expect(result.note).toContain('рост цен нельзя отделить от смены состава')
    // The largest term has no share from the server, so none is invented.
    expect(plain(result.lead)).toBe('Главная причина: выросла средняя сумма за одну позицию — +13,34 EUR.')
  })
  it('says there is nothing to compare with when one period has no visits', () => {
    const [only] = compare('compare-one-sided.json').currencies
    const result = verdict(only)
    expect(result.kind).toBe('no-base')
    expect(result.headline).toBe('В базовом периоде походов в KZT нет, поэтому изменение среднего чека посчитать нельзя.')
    expect(plain(result.lead)).toBe('В текущем периоде: 1 поход, средний чек 7 836,00 KZT.')
    expect(result.parts).toEqual([])
    expect(effectParts(only)).toEqual([])
    expect(decompositionBar(result.parts)).toBeNull()
  })
  it('mirrors the wording when the current period is the empty one', () => {
    const [only] = compare('compare-one-sided.json').currencies
    const result = verdict({ ...only, base: only.current, current: only.base })
    expect(result.kind).toBe('no-current')
    expect(result.headline).toContain('В текущем периоде походов в KZT нет')
    expect(plain(result.lead)).toBe('В базовом периоде: 1 поход, средний чек 7 836,00 KZT.')
  })
})

describe('the answer in words (other signs)', () => {
  it('describes a lower receipt and its terms with the opposite words', () => {
    const lower = block('-6.50', { quantity: '-4.00', price: '-1.50', mix: '-1.00', quantity_percent: '61.54', price_percent: '23.08', mix_percent: '15.38' }, {
      change: { avg_receipt: '-6.50', avg_receipt_percent: '-14.22' }, base: { ...eur.base, avg_receipt: '45.72' }, current: { ...eur.current, avg_receipt: '39.22' },
    })
    const result = verdict(lower)
    expect(result.kind).toBe('fell')
    expect(plain(result.headline)).toBe('Средний чек снизился на 6,50 EUR (-14,22 %): с 45,72 EUR до 39,22 EUR.')
    expect(plain(result.lead)).toBe('Главная причина: стал покупать меньше позиций за поход — -4,00 EUR, 61,54 % изменения.')
    expect(result.parts.map((part) => part.phrase)).toEqual([
      'стал покупать меньше позиций за поход', 'снизились цены на те же товары', 'другой состав покупок: позиции в среднем дешевле',
    ])
    expect(result.parts.some((part) => part.against)).toBe(false)
  })
  it('marks a term that pulls against the change and never names it the main cause', () => {
    const mixed = block('2.00', { quantity: '-5.00', price: '6.00', mix: '1.00', quantity_percent: '-250.00', price_percent: '300.00', mix_percent: '50.00' })
    const result = verdict(mixed)
    expect(result.kind).toBe('grew')
    expect(result.parts.map((part) => [part.key, part.sign, part.against])).toEqual([['quantity', -1, true], ['price', 1, false], ['mix', 1, false]])
    expect(plain(result.lead)).toBe('Главная причина: выросли цены на те же товары — +6,00 EUR, 300,00 % изменения.')
  })
  it('says the terms cancelled out when the receipt did not change', () => {
    const flat = block('0.00', { quantity: '3.00', price: '-3.00', mix: '0.00', quantity_percent: null, price_percent: null, mix_percent: null }, {
      change: { avg_receipt: '0.00', avg_receipt_percent: '0.00' },
    })
    const result = verdict(flat)
    expect(result.kind).toBe('same')
    expect(plain(result.headline)).toBe('Средний чек не изменился: 45,72 EUR в обоих периодах.')
    expect(result.lead).toBe('Слагаемые уравновесили друг друга.')
    expect(result.parts.map((part) => [part.phrase, part.against, part.percent])).toEqual([
      ['стал покупать больше позиций за поход', false, null], ['снизились цены на те же товары', false, null], ['состав покупок на чек не повлиял', false, null],
    ])
    const still = verdict(block('0.00', { quantity: '0.00', price: '0.00', mix: '0.00' }, { change: { avg_receipt: '0.00', avg_receipt_percent: null } }))
    expect(still.lead).toBeNull()
    expect(decompositionBar(still.parts)).toBeNull()
  })
  it('keeps the change but explains the missing terms when a period has no product lines', () => {
    const result = verdict(block('18.71', null))
    expect(result.kind).toBe('grew')
    expect(result.headline).toContain('Средний чек вырос на')
    expect(result.parts).toEqual([])
    expect(result.lead).toBeNull()
    expect(result.note).toBe(noLinesNote)
  })
  it('omits the percent the server could not give', () => {
    const result = verdict(block('18.71', {}, { change: { avg_receipt: '18.71', avg_receipt_percent: null } }))
    expect(plain(result.headline)).toBe('Средний чек вырос на 18,71 EUR: с 27,01 EUR до 45,72 EUR.')
  })
})

describe('decomposition bar', () => {
  it('splits the width in proportion to the terms of the demo', () => {
    const bar = decompositionBar(effectParts(eur))!
    expect(bar.negative).toEqual([])
    expect(bar.zero).toBe(0)
    expect(bar.positive.map((segment) => [segment.key, segment.share])).toEqual([['quantity', 46.23], ['price', 39.5], ['mix', 14.27]])
  })
  it('puts lowering terms left of zero and keeps the widths within the bar', () => {
    const bar = decompositionBar(effectParts(block('2.00', { quantity: '-5.00', price: '6.00', mix: '1.00' })))!
    expect(bar.negative.map((segment) => [segment.key, segment.sign, segment.share])).toEqual([['quantity', -1, 41.67]])
    expect(bar.positive.map((segment) => [segment.key, segment.share])).toEqual([['price', 50], ['mix', 8.33]])
    expect(bar.zero).toBe(41.67)
    expect([...bar.negative, ...bar.positive].reduce((sum, segment) => sum + segment.share, 0)).toBeCloseTo(100, 1)
  })
  it('skips a zero term', () => {
    const bar = decompositionBar(effectParts(block('-3.00', { quantity: '0.00', price: '-2.00', mix: '-1.00' })))!
    expect(bar.negative.map((segment) => segment.key)).toEqual(['price', 'mix'])
    expect(bar.zero).toBe(100)
  })
})

describe('price index', () => {
  it.each([['1.2404', '24.04'], ['1.7853', '78.53'], ['1.0000', '0.00'], ['0.9700', '-3.00'], ['0.9995', '-0.05'], ['2', '100.00'], ['1.05', '5.00'], ['x', null]] as const)(
    'turns the index %s into the exact percent %s', (index, percent) => expect(indexChangePercent(index)).toBe(percent))
  it('states the growth, the matched products and the coverage of both periods', () => {
    const summary = priceIndexSummary(eur.price_index!)
    expect(plain(summary.headline)).toBe('Цены на товары, купленные в обоих периодах, выросли на 24,04 % (индекс Фишера 1,2404).')
    expect(summary.detail).toBe('Ласпейрес 1,2403 · Пааше 1,2405')
    expect(summary.matched).toBe('Индекс посчитан по товарам, купленным в обоих периодах: 24 товара.')
    expect(plain(summary.coverage)).toBe('Покрытие: на них приходится 96,97 % трат на товары в базовом периоде и 79,05 % — в текущем.')
    expect(summary.warning).toBeNull()
    expect(indexAssumption).toContain('перенесён на всю корзину')
    expect(indexAssumption).toContain('в админке')
  })
  it('words a fall and an unchanged level', () => {
    expect(plain(priceIndexSummary({ ...eur.price_index!, fisher: '0.9700' }).headline)).toContain('снизились на 3,00 % (индекс Фишера 0,9700)')
    expect(plain(priceIndexSummary({ ...eur.price_index!, fisher: '1.0000' }).headline)).toContain('не изменились (индекс Фишера 1,0000)')
  })
  it('warns when either period is covered below the threshold or the products are few', () => {
    const index = eur.price_index!
    expect(lowCoveragePercent).toBe(50)
    expect(priceIndexSummary({ ...index, coverage_current_percent: '49.99' }).warning).toContain('Низкое покрытие')
    expect(priceIndexSummary({ ...index, coverage_base_percent: '12.00' }).warning).toContain('Низкое покрытие')
    expect(priceIndexSummary({ ...index, coverage_current_percent: '50.00' }).warning).toBeNull()
    const few = priceIndexSummary({ ...index, matched_products: fewMatchedProducts - 1 })
    expect(few.warning).toContain('Мало совпавших товаров (4 товара)')
    expect(priceIndexSummary({ ...index, matched_products: fewMatchedProducts }).warning).toBeNull()
  })
})

describe('period cards', () => {
  it('formats the facts of a period from the wire decimals', () => {
    expect(sideFacts(eur.base, 'EUR').map(([label, value]) => [label, plain(value)])).toEqual([
      ['Походов в магазин', '48 (3,99 в месяц)'], ['Средний чек', '27,01 EUR'], ['Медианный чек', '27,28 EUR'],
      ['Позиций на чек', '11,5'], ['Сумма на позицию', '2,35 EUR'], ['Потрачено всего', '1 296,41 EUR'],
    ])
  })
  it('leaves the averages of a period without visits empty instead of zero', () => {
    const [only] = compare('compare-one-sided.json').currencies
    expect(sideFacts(only.base, 'KZT').map(([, value]) => plain(value))).toEqual(['0 (0 в месяц)', '—', '—', '—', '—', '0,00 KZT'])
  })
  it('mentions excluded refunds only when there are any', () => {
    expect(refundsNote(eur)).toBe('Возвраты в расчёт не входят: в базовом периоде исключено 0, в текущем — 1.')
    expect(refundsNote(kzt)).toBeNull()
  })
})
