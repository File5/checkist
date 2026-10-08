import type { MergeGroup, MergeLine } from '../../api/product-merges'
import type { Page } from '../../api/types'
import RequestState from '../../components/RequestState'
import { formatAmount, formatPrice, formatPurchasedOn, formatQuantity } from '../../lib/format'
import { glue, numbered } from '../../lib/text'
import { Link } from '../../navigation'
import { ReceiptPagination } from '../receipts/ReceiptBlock'
import { countedWhole, memberName } from './labels'

/** Purchases of the group: the printed name of every line and the record it belonged to before the merge. */
export default function MergeLines({ group, lines, onPage }: { group: MergeGroup; lines: Page<MergeLine>; onPage: (page: number) => void }) {
  if (lines.results.length === 0) {
    return <RequestState kind="empty" message={group.status === 'cancelled'
      ? 'Слияние отменено: покупки возвращены исходным товарам и в группе больше не числятся.' : 'Покупок в группе нет.'} />
  }
  const origin = (line: MergeLine) => {
    if (line.origin_product_id === null) return 'Добавлена после слияния'
    const member = group.members.find((item) => item.product_id === line.origin_product_id)
    return `№${line.origin_product_id}${member ? `: ${memberName(member)}` : ''}`
  }
  return <>
    <div className="ck-merge-table-scroll" role="region" aria-label="Таблица покупок группы, прокручивается по горизонтали" tabIndex={0}>
      <table className="ck-merge-table ck-merge-lines">
        <caption>{countedWhole(lines.count, 'покупка', 'покупки', 'покупок')} · страница {lines.page.toLocaleString('ru-RU')} из {(lines.pages || 1).toLocaleString('ru-RU')}. Название — как напечатано в чеке.</caption>
        <thead><tr>
          <th scope="col" className="ck-merge-name-head">Напечатанное название</th><th scope="col">Исходная запись</th><th scope="col">Дата</th><th scope="col">Магазин</th>
          <th scope="col">Количество</th><th scope="col">Цена</th><th scope="col">Сумма</th><th scope="col">Чек</th>
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
    </div>
    <ReceiptPagination page={lines.page} pages={lines.pages} onPage={onPage} label="Страницы покупок группы" />
  </>
}
