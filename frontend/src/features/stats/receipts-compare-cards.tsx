import type { CompareCurrency, CompareProduct } from '../../api/stats'
import { Card, CardList } from '../../lib/cards'
import type { CardFact } from '../../lib/cards'
import { formatAmount, formatPrice, formatQuantity } from '../../lib/format'
import { glue } from '../../lib/text'
import { Link } from '../../navigation'
import { signedAmount, signedPercent } from './receipts-wording'
import type { EffectPart } from './receipts-wording'

/** Column headings of the terms: the screen keeps one object for the table and for the cards. */
export interface EffectColumns { term: string; amount: string; share: string }
export const effectsCaption = 'Слагаемые в сумме дают изменение среднего чека точно. Полоса над таблицей показывает те же числа: заштрихованные части уменьшают чек.'
export const effectsTotalTitle = 'Изменение среднего чека'

/**
 * Column headings of the matched products: the screen keeps one object for the table and for the cards. A pair of
 * periods is two columns of the table («Цена было», «Цена стало») and one fact of a card («Цена»: было → стало).
 */
export interface ProductColumns { product: string; price: string; priceChange: string; quantity: string; amount: string }

const effectShare = (part: EffectPart) => (part.percent === null ? '—' : signedPercent(part.percent))

/** The terms of the change on a phone: a card per term, the total of the table is the last card. */
export function EffectCards({ block, parts, columns, labelledBy }: { block: CompareCurrency; parts: readonly EffectPart[]; columns: EffectColumns; labelledBy: string }) {
  const { change, currency } = block
  return (
    <CardList labelledBy={labelledBy} caption={effectsCaption}>
      {parts.map((part) => (
        <Card key={part.key}
          title={<>
            <span className={`stats-swatch stats-effect-${part.key}`} data-sign={part.sign < 0 ? 'negative' : 'positive'} aria-hidden="true" />
            <span className="stats-effect-title">{part.title}</span>
            <span className="stats-effect-phrase">{part.phrase}{part.against && ' — действует против общего изменения'}</span>
          </>}
          facts={[
            { key: 'amount', label: columns.amount, value: signedAmount(part.amount, currency) },
            { key: 'share', label: columns.share, value: effectShare(part) },
          ]} />
      ))}
      <Card tone="total" title={effectsTotalTitle}
        facts={[
          { key: 'amount', label: columns.amount, value: signedAmount(change.avg_receipt, currency) },
          {
            key: 'share', label: columns.share,
            value: change.avg_receipt_percent === null ? '—' : <>{signedPercent(change.avg_receipt_percent)} <span className="stats-number-note">к базовому чеку</span></>,
          },
        ]} />
    </CardList>
  )
}

/** «было → стало»: each value keeps one line, the arrow stays with the first one, a break is possible only after it. */
function pair(key: string, label: string, base: string, current: string): CardFact {
  return {
    key, label, kind: 'text',
    value: <><span className="stats-number">{glue(base, '→')}</span> <span className="stats-number">{current}</span></>,
  }
}

/** The matched products on a phone: a card per product, a pair of periods is one fact. */
export function ProductCards({ block, columns, caption, labelledBy }: { block: CompareCurrency; columns: ProductColumns; caption: string; labelledBy: string }) {
  const { currency, products } = block
  return (
    <CardList labelledBy={labelledBy} caption={caption}>
      {products.map((item: CompareProduct) => (
        <Card key={`${item.product.id}-${item.unit}`}
          title={<Link to={{ kind: 'product', productId: item.product.id, query: { page: 1 } }}>{item.product.name}</Link>}
          facts={[
            pair('price', columns.price, formatPrice(item.base.price, currency, item.unit), formatPrice(item.current.price, currency, item.unit)),
            { key: 'price-change', label: columns.priceChange, value: signedPercent(item.price_change_percent) },
            pair('quantity', columns.quantity, formatQuantity(item.base.quantity, item.unit), formatQuantity(item.current.quantity, item.unit)),
            pair('amount', columns.amount, formatAmount(item.base.amount, currency), formatAmount(item.current.amount, currency)),
          ]} />
      ))}
    </CardList>
  )
}
