import type { MergeLine } from '../../api/product-merges'
import { Card, CardList } from '../../lib/cards'
import type { CardFact } from '../../lib/cards'
import { formatAmount, formatPrice, formatPurchasedOn, formatQuantity } from '../../lib/format'
import { glue, numbered } from '../../lib/text'
import { Link } from '../../navigation'

/** Headings of the table of purchases: the table and the cards read the same texts. */
export interface MergeLineColumns { name: string; origin: string; date: string; store: string; quantity: string; price: string; amount: string; receipt: string }

/** The phone view of the purchases of a group: the printed name is the heading, the other cells are facts. */
export default function MergeLineCards({ lines, columns, caption, label, origin }: {
  lines: MergeLine[]; columns: MergeLineColumns; caption: string; label: string; origin: (line: MergeLine) => string
}) {
  return <CardList label={label} caption={caption}>
    {lines.map((line) => {
      const cells: CardFact[] = [
        { key: 'origin', label: columns.origin, kind: 'text', value: origin(line) },
        { key: 'date', label: columns.date, value: <time dateTime={line.purchased_on}>{formatPurchasedOn(line.purchased_on)}</time> },
        { key: 'store', label: columns.store, kind: 'text', value: <>{line.store.name.trim() || 'Не указано'}<span className="ck-merge-subtext">{[line.store.city.trim(), line.store.country].filter(Boolean).join(' · ')}</span></> },
        { key: 'quantity', label: columns.quantity, value: formatQuantity(line.quantity, line.unit) },
        { key: 'price', label: columns.price, value: formatPrice(line.unit_price, line.currency) },
        { key: 'amount', label: columns.amount, value: formatAmount(line.amount, line.currency) },
        { key: 'receipt', label: columns.receipt, value: line.receipt_id === null ? 'Чужая покупка'
          : <><Link to={{ kind: 'receipt', receiptId: line.receipt_id }}>{numbered('Чек', line.receipt_id)}</Link><span className="ck-merge-subtext">{glue('позиция', line.position)}</span></> },
      ]
      return <Card key={line.line_id} title={line.name} facts={cells} />
    })}
  </CardList>
}
