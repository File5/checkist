/** Words and numbers of the comparison of two periods. Pure: wire decimals in, ready texts out. */
import { decimalNumber } from '../../api/stats'
import type { CompareCurrency, ComparePriceIndex, CompareSide } from '../../api/stats'
import type { CurrencyCode, Decimal } from '../../api/types'
import { formatAmount, formatIndex, formatPercent, formatPrice, formatQuantity } from '../../lib/format'

export type Sign = -1 | 0 | 1
/** Sign of a wire decimal without turning money into a float; `null` for an absent or broken value. */
export function decimalSign(value: Decimal | null | undefined): Sign | null {
  const match = typeof value === 'string' ? /^(-?)(\d+)(?:\.(\d+))?$/.exec(value) : null
  if (!match) return null
  if (!/[1-9]/.test(match[2] + (match[3] ?? ''))) return 0
  return match[1] ? -1 : 1
}
const unsigned = (value: Decimal) => value.replace(/^-/, '')
const plus = (value: Decimal | null, text: string) => (decimalSign(value) === 1 ? `+${text}` : text)
/** «+8,65 EUR», «-3,10 EUR», «0,00 EUR». */
export const signedAmount = (value: Decimal | null, currency: CurrencyCode) => plus(value, formatAmount(value, currency))
export const signedPercent = (value: Decimal | null) => plus(value, formatPercent(value))
/** An index or a ratio with up to four places and no unit. */
const count = (value: number) => value.toLocaleString('ru-RU')
export function plural(value: number, forms: readonly [string, string, string]): string {
  const tens = Math.abs(value) % 100
  const ones = tens % 10
  return tens > 10 && tens < 20 ? forms[2] : ones === 1 ? forms[0] : ones >= 2 && ones <= 4 ? forms[1] : forms[2]
}
const visits = (value: number) => `${count(value)} ${plural(value, ['поход', 'похода', 'походов'])}`

/** Facts of one period for its card; averages of a period without visits stay «—». */
export function sideFacts(side: CompareSide, currency: CurrencyCode): [string, string][] {
  return [
    ['Походов в магазин', `${count(side.receipts_count)} (${formatQuantity(side.receipts_per_month)} в месяц)`],
    ['Средний чек', formatAmount(side.avg_receipt, currency)],
    ['Медианный чек', formatAmount(side.median_receipt, currency)],
    ['Позиций на чек', formatQuantity(side.lines_per_receipt)],
    ['Сумма на позицию', formatPrice(side.paid_per_line, currency)],
    ['Потрачено всего', formatAmount(side.total, currency)],
  ]
}
export function refundsNote(block: CompareCurrency): string | null {
  const { base, current } = block
  if (!base.refunds_excluded && !current.refunds_excluded) return null
  return `Возвраты в расчёт не входят: в базовом периоде исключено ${count(base.refunds_excluded)}, в текущем — ${count(current.refunds_excluded)}.`
}

export type EffectKey = 'quantity' | 'price' | 'mix' | 'price_per_line'
export interface EffectPart {
  key: EffectKey
  title: string
  /** What happened, in words that follow the sign. */
  phrase: string
  amount: Decimal
  /** Share of the change of the average receipt; `null` when the receipt did not change. */
  percent: Decimal | null
  sign: Sign
  /** Pulls the receipt the other way than it actually went. */
  against: boolean
}
const titles: Record<EffectKey, string> = {
  quantity: 'Количество позиций', price: 'Цены на те же товары', mix: 'Состав покупок', price_per_line: 'Цена позиции (цены и состав вместе)',
}
const phrases: Record<EffectKey, Record<Sign, string>> = {
  quantity: { 1: 'стал покупать больше позиций за поход', [-1]: 'стал покупать меньше позиций за поход', 0: 'число позиций за поход не изменилось' },
  price: { 1: 'выросли цены на те же товары', [-1]: 'снизились цены на те же товары', 0: 'цены на те же товары не изменились' },
  mix: {
    1: 'другой состав покупок: позиции в среднем дороже', [-1]: 'другой состав покупок: позиции в среднем дешевле', 0: 'состав покупок на чек не повлиял',
  },
  price_per_line: {
    1: 'выросла средняя сумма за одну позицию', [-1]: 'снизилась средняя сумма за одну позицию', 0: 'средняя сумма за одну позицию не изменилась',
  },
}
/**
 * Terms of the change: quantity + price + mix, or quantity + price per line when no product was bought in both periods.
 * Empty when the server could not decompose (`effects: null`).
 */
export function effectParts(block: CompareCurrency): EffectPart[] {
  const { effects } = block
  if (!effects) return []
  const direction = decimalSign(block.change.avg_receipt) ?? 0
  const part = (key: EffectKey, amount: Decimal, percent: Decimal | null): EffectPart => {
    const sign = decimalSign(amount) ?? 0
    return { key, title: titles[key], phrase: phrases[key][sign], amount, percent, sign, against: sign !== 0 && direction !== 0 && sign !== direction }
  }
  const quantity = part('quantity', effects.quantity, effects.quantity_percent)
  if (effects.price === null || effects.mix === null) return [quantity, part('price_per_line', effects.price_per_line, null)]
  return [quantity, part('price', effects.price, effects.price_percent), part('mix', effects.mix, effects.mix_percent)]
}

export type VerdictKind = 'grew' | 'fell' | 'same' | 'no-base' | 'no-current'
export interface Verdict {
  kind: VerdictKind
  /** How the average receipt changed, with the money and the percent. */
  headline: string
  /** The main cause, or what the other period looked like when there is nothing to compare with. */
  lead: string | null
  parts: EffectPart[]
  /** Why the terms are fewer than three or absent. */
  note: string | null
}
export const noMatchedNote = 'Товаров, купленных в обоих периодах, нет, поэтому рост цен нельзя отделить от смены состава покупок. Вместо них показана общая «цена позиции»: насколько изменилась средняя сумма за одну позицию чека.'
export const noLinesNote = 'Разложить изменение на слагаемые нельзя: в одном из периодов в чеках нет товарных строк.'

function oneSided(block: CompareCurrency, empty: 'base' | 'current'): Verdict {
  const side = empty === 'base' ? block.current : block.base
  const [emptyName, otherName] = empty === 'base' ? ['базовом', 'текущем'] : ['текущем', 'базовом']
  return {
    kind: empty === 'base' ? 'no-base' : 'no-current',
    headline: `В ${emptyName} периоде походов в ${block.currency} нет, поэтому изменение среднего чека посчитать нельзя.`,
    lead: `В ${otherName} периоде: ${visits(side.receipts_count)}, средний чек ${formatAmount(side.avg_receipt, block.currency)}.`,
    parts: [], note: null,
  }
}
/** The answer to «why did the average receipt change» for one currency. */
export function verdict(block: CompareCurrency): Verdict {
  const { currency, base, current, change } = block
  if (base.avg_receipt === null) return oneSided(block, 'base')
  if (current.avg_receipt === null || change.avg_receipt === null) return oneSided(block, 'current')
  const direction = decimalSign(change.avg_receipt) ?? 0
  const kind: VerdictKind = direction > 0 ? 'grew' : direction < 0 ? 'fell' : 'same'
  const percent = change.avg_receipt_percent === null ? '' : ` (${signedPercent(change.avg_receipt_percent)})`
  const headline = kind === 'same'
    ? `Средний чек не изменился: ${formatAmount(current.avg_receipt, currency)} в обоих периодах.`
    : `Средний чек ${kind === 'grew' ? 'вырос' : 'снизился'} на ${formatAmount(unsigned(change.avg_receipt), currency)}${percent}: с ${formatAmount(base.avg_receipt, currency)} до ${formatAmount(current.avg_receipt, currency)}.`
  const parts = effectParts(block)
  if (!parts.length) return { kind, headline, lead: null, parts, note: noLinesNote }
  const note = parts.some((part) => part.key === 'price_per_line') ? noMatchedNote : null
  if (kind === 'same') {
    return { kind, headline, lead: parts.some((part) => part.sign !== 0) ? 'Слагаемые уравновесили друг друга.' : null, parts, note }
  }
  // The largest term that pulls the same way as the receipt went.
  const main = parts.filter((part) => part.sign === direction)
    .sort((a, b) => Math.abs(decimalNumber(b.amount) ?? 0) - Math.abs(decimalNumber(a.amount) ?? 0))[0]
  const share = main?.percent ? `, ${formatPercent(main.percent)} изменения` : ''
  const lead = main ? `Главная причина: ${main.phrase} — ${signedAmount(main.amount, currency)}${share}.` : null
  return { kind, headline, lead, parts, note }
}

export interface BarSegment { key: EffectKey; title: string; sign: -1 | 1; /** Percent of the bar's width. */ share: number }
export interface DecompositionBar { negative: BarSegment[]; positive: BarSegment[]; /** Where zero stands, percent from the left. */ zero: number }
/** Diverging bar: terms that lower the receipt go left of zero, terms that raise it go right. Widths are for drawing only. */
export function decompositionBar(parts: readonly EffectPart[]): DecompositionBar | null {
  const sized = parts.map((part) => ({ part, size: Math.abs(decimalNumber(part.amount) ?? 0) })).filter((entry) => entry.part.sign !== 0 && entry.size > 0)
  const total = sized.reduce((sum, entry) => sum + entry.size, 0)
  if (!(total > 0)) return null
  const segments = sized.map(({ part, size }): BarSegment => ({
    key: part.key, title: part.title, sign: part.sign as -1 | 1, share: Math.round((size / total) * 10000) / 100,
  }))
  const negative = segments.filter((segment) => segment.sign < 0)
  return {
    negative, positive: segments.filter((segment) => segment.sign > 0),
    zero: Math.round(negative.reduce((sum, segment) => sum + segment.share, 0) * 100) / 100,
  }
}

/** Below this share of spending the matched products say little about the whole basket. */
export const lowCoveragePercent = 50
export const fewMatchedProducts = 5
export const indexAssumption = 'Допущение: рост цен измерен только на товарах, купленных в обоих периодах, и перенесён на всю корзину. Товары, которые покупались лишь в одном периоде, и строки чека без сопоставленного товара в индекс не входят — их влияние попадает в «состав покупок». Сопоставить строки с товарами и поправить каталог можно в админке.'

/** `(index − 1) × 100` of a four-place index, exactly, as a wire decimal with two places. */
export function indexChangePercent(index: Decimal): Decimal | null {
  const match = /^(\d+)(?:\.(\d{1,4}))?$/.exec(index)
  if (!match) return null
  const difference = BigInt(match[1] + (match[2] ?? '').padEnd(4, '0')) - 10000n
  const digits = (difference < 0n ? -difference : difference).toString().padStart(3, '0')
  return `${difference < 0n ? '-' : ''}${digits.slice(0, -2)}.${digits.slice(-2)}`
}
export interface PriceIndexSummary {
  headline: string
  /** Laspeyres and Paasche, for the small print. */
  detail: string
  matched: string
  coverage: string
  /** Set when the index stands on too little of the spending. */
  warning: string | null
}
export function priceIndexSummary(index: ComparePriceIndex): PriceIndexSummary {
  const change = indexChangePercent(index.fisher)
  const direction = decimalSign(change) ?? 0
  const fisher = `индекс Фишера ${formatIndex(index.fisher)}`
  const headline = direction === 0
    ? `Цены на товары, купленные в обоих периодах, не изменились (${fisher}).`
    : `Цены на товары, купленные в обоих периодах, ${direction > 0 ? 'выросли' : 'снизились'} на ${formatPercent(unsigned(change!))} (${fisher}).`
  const products = `${count(index.matched_products)} ${plural(index.matched_products, ['товар', 'товара', 'товаров'])}`
  const lowest = Math.min(decimalNumber(index.coverage_base_percent) ?? 0, decimalNumber(index.coverage_current_percent) ?? 0)
  const warning = lowest < lowCoveragePercent
    ? `Низкое покрытие: на совпавшие товары приходится меньше половины трат хотя бы одного периода. Деление на «цены» и «состав» здесь ненадёжно — уверенно можно говорить только о «количестве» и о сумме «цен» и «состава» вместе.`
    : index.matched_products < fewMatchedProducts
      ? `Мало совпавших товаров (${products}): индекс цен опирается на считаные покупки, деление на «цены» и «состав» приблизительно.`
      : null
  return {
    headline,
    detail: `Ласпейрес ${formatIndex(index.laspeyres)} · Пааше ${formatIndex(index.paasche)}`,
    matched: `Индекс посчитан по товарам, купленным в обоих периодах: ${products}.`,
    coverage: `Покрытие: на них приходится ${formatPercent(index.coverage_base_percent)} трат на товары в базовом периоде и ${formatPercent(index.coverage_current_percent)} — в текущем.`,
    warning,
  }
}
