import { Link } from '../../navigation'
import type { PricePoint, Store } from '../../api/types'
import { Card, CardList } from '../../lib/cards'
import type { CardFact } from '../../lib/cards'
import { formatObservedAt, formatPrice, formatPurchasedOn } from '../../lib/format'
import { numbered } from '../../lib/text'
import { storeLabel } from './state'

/** Headings of the history columns: the table and the cards show the same texts, in this order. */
export type HistoryColumns = Record<'store' | 'date' | 'list' | 'paid' | 'normalized' | 'purchase', string>

/** The phone view of the price history: one card per purchase, the store is its heading.
    A foreign purchase has no receipt or position: the card is identified by its place on the page. */
export default function PriceHistoryCards({ points, stores, columns, caption, label }: {
  points: PricePoint[]; stores: Map<number, Store>; columns: HistoryColumns; caption: string; label: string
}) {
  return (
    <CardList label={label} caption={caption}>
      {points.map((point, index) => {
        const store = stores.get(point.store.id)
        const facts: CardFact[] = [
          { key: 'date', label: columns.date, value: <><time dateTime={point.purchased_on}>{formatPurchasedOn(point.purchased_on)}</time>{point.own && <span className="product-subtext"><time dateTime={point.observed_at}>{formatObservedAt(point.observed_at, store?.timezone)}</time></span>}</> },
          { key: 'list', label: columns.list, value: formatPrice(point.list_unit_price, point.currency, point.unit) },
          { key: 'paid', label: columns.paid, value: formatPrice(point.paid_unit_price, point.currency, point.unit) },
          { key: 'normalized', label: columns.normalized, value: <>{point.normalized_price === null ? <span className="product-cell-text">Нет данных для пересчёта</span> : formatPrice(point.normalized_price, point.currency, point.normalized_unit)}
            {!point.comparable && <span className="product-subtext product-cell-text">Не сопоставимо с базовой единицей товара</span>}</> },
          { key: 'purchase', label: columns.purchase, value: point.own ? <>Моя · <Link to={{ kind: 'receipt', receiptId: point.receipt_id }}>{numbered('Чек', point.receipt_id)}</Link></> : 'Чужая' },
        ]
        return <Card key={index} title={storeLabel(store ?? point.store)} facts={facts} />
      })}
    </CardList>
  )
}
