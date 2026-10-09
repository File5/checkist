import type { MergeGroup, MergeLine } from '../../api/product-merges'
import type { Page } from '../../api/types'
import RequestState from '../../components/RequestState'
import { formatAmount, formatPrice, formatPurchasedOn, formatQuantity } from '../../lib/format'
import { useNarrow } from '../../lib/cards'
import { glue, numbered } from '../../lib/text'
import { Link } from '../../navigation'
import { ReceiptPagination } from '../receipts/ReceiptBlock'
import { countedWhole, memberName } from './labels'
import MergeLineCards from './MergeLineCards'
import type { MergeLineColumns } from './MergeLineCards'

/** Column headings: the table and the cards of a phone read the same texts. */
const columns: MergeLineColumns = {
  name: 'Напечатанное название', origin: 'Исходная запись', date: 'Дата', store: 'Магазин', quantity: 'Количество', price: 'Цена', amount: 'Сумма', receipt: 'Чек',
}

/** Purchases of the group: the printed name of every line and the record it belonged to before the merge. */
export default function MergeLines({ group, lines, onPage }: { group: MergeGroup; lines: Page<MergeLine>; onPage: (page: number) => void }) {
  const narrow = useNarrow()
  if (lines.results.length === 0) {
    return <RequestState kind="empty" message={group.status === 'cancelled'
      ? 'Слияние отменено: покупки возвращены исходным товарам и в группе больше не числятся.' : 'Покупок в группе нет.'} />
  }
  const origin = (line: MergeLine) => {
    if (line.origin_product_id === null) return 'Добавлена после слияния'
    const member = group.members.find((item) => item.product_id === line.origin_product_id)
    return `№${line.origin_product_id}${member ? `: ${memberName(member)}` : ''}`
  }
  const caption = `${countedWhole(lines.count, 'покупка', 'покупки', 'покупок')} · страница ${lines.page.toLocaleString('ru-RU')} из ${(lines.pages || 1).toLocaleString('ru-RU')}. Название — как напечатано в чеке.`
  return <>
    {narrow ? <MergeLineCards lines={lines.results} columns={columns} caption={caption} label="Покупки группы" origin={origin} />
    : <div className="ck-merge-table-scroll" role="region" aria-label="Таблица покупок группы, прокручивается по горизонтали" tabIndex={0}>
      <table className="ck-merge-table ck-merge-lines">
        <caption>{caption}</caption>
        <thead><tr>
          <th scope="col" className="ck-merge-name-head">{columns.name}</th><th scope="col">{columns.origin}</th><th scope="col">{columns.date}</th><th scope="col">{columns.store}</th>
          <th scope="col">{columns.quantity}</th><th scope="col">{columns.price}</th><th scope="col">{columns.amount}</th><th scope="col">{columns.receipt}</th>
        </tr></thead>
        <tbody>{lines.results.map((line) => <tr key={line.line_id}>
          <th scope="row">{line.name}</th>
          <td className="ck-merge-text">{origin(line)}</td>
          <td><time dateTime={line.purchased_on}>{formatPurchasedOn(line.purchased_on)}</time></td>
          <td className="ck-merge-text">{line.store.name.trim() || 'Не указано'}<span className="ck-merge-subtext">{[line.store.city.trim(), line.store.country].filter(Boolean).join(' · ')}</span></td>
          <td className="ck-merge-number">{formatQuantity(line.quantity, line.unit)}</td>
          <td className="ck-merge-number">{formatPrice(line.unit_price, line.currency)}</td>
          <td className="ck-merge-number">{formatAmount(line.amount, line.currency)}</td>
          <td className="ck-merge-whole">{line.receipt_id === null ? 'Чужая покупка'
            : <><Link to={{ kind: 'receipt', receiptId: line.receipt_id }}>{numbered('Чек', line.receipt_id)}</Link><span className="ck-merge-subtext">{glue('позиция', line.position)}</span></>}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    <ReceiptPagination page={lines.page} pages={lines.pages} onPage={onPage} label="Страницы покупок группы" />
  </>
}
