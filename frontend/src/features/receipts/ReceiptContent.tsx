import type { Discount, Line, Receipt, Tax } from '../../api/receipts'
import type { ReceiptImage } from '../../api/recognition'
import { imageLabels, issueLabels } from '../../lib/recognition-labels'
import { formatObservedAt, formatPercent, formatQuantity } from '../../lib/format'
import { Link } from '../../navigation'
import ReceiptMedia from './ReceiptMedia'
import { money, price, recognizedText, recognizedValue, unknown } from './state'

const lineKinds: Record<Line['kind'], string> = {
  product: 'Товар', service: 'Услуга', deposit: 'Залог', deposit_return: 'Возврат залога',
}
export function ReceiptHeader({ receipt }: { receipt: Receipt }) {
  return <>
    <h3 className="receipt-store-name">{recognizedText(receipt.store.name)}</h3>
    <dl className="receipt-facts">
      <div><dt>Адрес</dt><dd>{recognizedText(receipt.store.address)}</dd></div>
      <div><dt>Город и страна</dt><dd>{recognizedText(receipt.store.city)} · {receipt.store.country}</dd></div>
      <div><dt>Дата и время покупки</dt><dd><time dateTime={receipt.purchased_at}>{recognizedValue(formatObservedAt(receipt.purchased_at, receipt.store.timezone))}</time></dd></div>
      <div><dt>Операция</dt><dd>{receipt.operation === 'refund' ? 'Возврат' : 'Продажа'}</dd></div>
      <div><dt>Итог</dt><dd className="receipt-number receipt-total">{money(receipt.total, receipt.currency)}</dd></div>
      <div><dt>Сумма скидок</dt><dd className="receipt-number">{money(receipt.discount_total, receipt.currency)}</dd></div>
      <div><dt>Валюта</dt><dd>{receipt.currency}</dd></div>
      <div><dt>Налог в ценах</dt><dd>{receipt.prices_include_tax ? 'Включён' : 'Не включён'}</dd></div>
    </dl>
    {receipt.unmatched_products_count > 0 && <p className="receipt-warning">Товары не сопоставлены: {receipt.unmatched_products_count.toLocaleString('ru-RU')}</p>}
    {receipt.review_required && <p className="receipt-warning">Данные требуют проверки. Проверьте несопоставленные товары и замечания к изображениям.</p>}
  </>
}

export function ReceiptImages({ images, receiptId }: { images: ReceiptImage[]; receiptId: number }) {
  return <ul className="receipt-images">{images.map((image) => <li className="receipt-image-card" key={image.id}>
    <h3>Фото №{image.photo_id} · вырезка {image.position}</h3>
    <ReceiptMedia url={image.image_url} alt={`Вырезка ${image.position} с фото №${image.photo_id}, чек №${receiptId}`} />
    <p>{imageLabels[image.status]}</p>
    {image.issues.length > 0 && <ul className="receipt-warning" aria-label="Замечания распознавания">{image.issues.map((issue, index) =>
      <li key={`${issue.code}-${issue.field}-${index}`}>{issueLabels[issue.code]}</li>)}</ul>}
    <Link className="action-link" to={`/recognition/jobs/${image.job_id}`}>Задание №{image.job_id}</Link>
  </li>)}</ul>
}

export function LineReference({ lineId, lines }: { lineId: number; lines: Line[] }) {
  const line = lines.find((candidate) => candidate.id === lineId)
  return line ? <a href={`#receipt-line-${line.id}`}>Строка {line.position}: {recognizedText(line.name)}</a>
    : <span>Строка ID {lineId} (на другой странице строк)</span>
}

export function CurrencyNote({ currency }: { currency?: string }) {
  return !currency ? <p className="receipt-warning">Валюта: {unknown}. Загрузите сведения о чеке, чтобы увидеть валюту сумм.</p> : null
}

export function ReceiptLines({ lines, currency }: { lines: Line[]; currency?: string }) {
  return <>
    <CurrencyNote currency={currency} />
    <p className="receipt-note">«Оплачено» учитывает скидку строки. Скидка всего чека по строкам не распределяется.</p>
    <div className="receipt-table-scroll" role="region" aria-label="Таблица строк чека, прокручивается по горизонтали" tabIndex={0}>
      <table className="receipt-lines-table">
        <caption>Строки в порядке печати на чеке</caption>
        <thead><tr>{['Строка и товар каталога', 'Количество', 'Цена', 'Сумма', 'Скидка', 'Оплачено'].map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{lines.map((line) => <tr id={`receipt-line-${line.id}`} key={line.id} tabIndex={-1}>
          <th scope="row">
            <span className="receipt-note">Строка {line.position} · {lineKinds[line.kind]}</span>
            <span className="receipt-printed-name">{recognizedText(line.name)}</span>
            {line.product ? <Link className="receipt-product-link" to={`/catalog/products/${line.product.id}`}>Товар каталога: {recognizedText(line.product.name)}</Link>
              : <span className="receipt-warning">Товар не сопоставлен</span>}
            {line.parent_id !== null && <span className="receipt-line-relation">{line.kind === 'deposit' || line.kind === 'deposit_return' ? 'Залог к ' : 'Связь с '}<LineReference lineId={line.parent_id} lines={lines} /></span>}
            {lines.filter((child) => child.parent_id === line.id).map((child) => <span className="receipt-line-relation" key={child.id}>
              {lineKinds[child.kind]}: <LineReference lineId={child.id} lines={lines} />
            </span>)}
          </th>
          <td className="receipt-number">{recognizedValue(formatQuantity(line.quantity, line.unit))}</td>
          <td className="receipt-number">{price(line.unit_price, currency)}</td>
          <td className="receipt-number">{money(line.amount, currency)}</td>
          <td className="receipt-number">{money(line.discount_amount, currency)}</td>
          <td className="receipt-number">{money(line.paid_amount, currency)}</td>
        </tr>)}</tbody>
      </table>
    </div>
  </>
}

export function ReceiptDiscounts({ discounts, lines, currency }: { discounts: Discount[]; lines: Line[]; currency?: string }) {
  return <><CurrencyNote currency={currency} /><ul className="receipt-detail-list">{discounts.map((discount) => <li key={discount.id}>
    <h3>{recognizedText(discount.name)}</h3>
    <p className="receipt-number">{money(discount.amount, currency)}</p>
    <p className="receipt-note">{discount.line_id === null ? 'Скидка на весь чек' : <>Скидка к <LineReference lineId={discount.line_id} lines={lines} /></>}</p>
  </li>)}</ul></>
}

export function ReceiptTaxes({ taxes, currency }: { taxes: Tax[]; currency?: string }) {
  return <><CurrencyNote currency={currency} /><ul className="receipt-detail-list">{taxes.map((tax) => <li key={tax.id}>
    <h3>{tax.tax_rate.kind === 'exempt' ? 'Без НДС' : `НДС ${recognizedValue(formatPercent(tax.tax_rate.rate))}`} · {tax.tax_rate.country}</h3>
    <p className="receipt-note">Код на чеке: {recognizedText(tax.tax_code)}</p>
    <dl className="receipt-facts">
      <div><dt>Без налога</dt><dd className="receipt-number">{money(tax.net, currency)}</dd></div>
      <div><dt>Налог</dt><dd className="receipt-number">{money(tax.tax, currency)}</dd></div>
      <div><dt>С налогом</dt><dd className="receipt-number">{money(tax.gross, currency)}</dd></div>
    </dl>
  </li>)}</ul></>
}
