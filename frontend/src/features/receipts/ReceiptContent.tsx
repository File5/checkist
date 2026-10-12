import type { ReactNode } from 'react'
import type { Discount, Line, Receipt, Tax } from '../../api/receipts'
import type { ReceiptImage } from '../../api/recognition'
import RecognitionIssues from '../../components/RecognitionIssues'
import { useNarrow } from '../../lib/cards'
import { imageLabels } from '../../lib/recognition-labels'
import { formatObservedAt, formatPercent, formatPurchasedOn, formatQuantity } from '../../lib/format'
import { ownerName } from '../../lib/people'
import { glue, numbered } from '../../lib/text'
import { Link } from '../../navigation'
import ReceiptLineLeaders from './ReceiptLineLeaders'
import type { LineColumns } from './ReceiptLineLeaders'
import { categoryTone } from '../../lib/category-tone'
import { DownloadOriginal } from '../recognition/MediaImage'
import ReceiptMedia from './ReceiptMedia'
import { money, price, receiptPlace, recognizedText, recognizedValue, unknown } from './state'
import { sourceMark, withoutSourceMark } from './spends'
import type { NamedObject } from '../../api/types'

const lineKinds: Record<Line['kind'], string> = {
  product: 'Товар', service: 'Услуга', deposit: 'Залог', deposit_return: 'Возврат залога',
}
/** One source of the headings for the table and for the cards of the phone view. */
const lineColumns: LineColumns = ['Строка и товар каталога', 'Количество', 'Цена', 'Сумма', 'Скидка', 'Оплачено']
const linesCaption = 'Строки в порядке печати на чеке'
export function CategoryChip({ category, hint = false }: { category: NamedObject; hint?: boolean }) {
  return <span className="receipt-line-chip" data-tone={categoryTone(category.id)}>
    {hint && <span className="receipt-visually-hidden">Категория: </span>}{category.name}</span>
}

/**
 * The header of a receipt or a spend, inside its card: the place, the date, who added it and where it came from, the
 * total as the hero figure of the page, the categories of its lines, then the other facts as rows. `photo` — the
 * thumbnail of the receipt photo on a phone.
 */
export function ReceiptHeader({ receipt, showOwner = false, photo, categories = [] }: {
  receipt: Receipt; showOwner?: boolean; photo?: ReactNode; categories?: NamedObject[]
}) {
  const { store } = receipt
  const manual = receipt.source === 'manual'
  // A spend imported from a bank statement names the statement in its note: the header says it as the source.
  const note = withoutSourceMark(receipt.note)
  return <div className="receipt-head">
    <div className="receipt-head-top">
      <div className="receipt-head-main">
        <h3 className="receipt-store-name">{receiptPlace(receipt)}</h3>
        <dl className="receipt-head-meta">
          {/* The time of a manual spend is the moment of entry, not of the purchase: only the date is shown. */}
          {manual ? <div><dt>Дата покупки</dt><dd><time dateTime={receipt.purchased_on}>{recognizedValue(formatPurchasedOn(receipt.purchased_on))}</time></dd></div>
            : <div><dt>Дата и время покупки</dt><dd><time dateTime={receipt.purchased_at}>{recognizedValue(formatObservedAt(receipt.purchased_at, store?.timezone))}</time></dd></div>}
          {showOwner && <div><dt>Добавил</dt><dd className="receipt-owner">{ownerName(receipt)}</dd></div>}
          <div><dt>Откуда</dt><dd>{sourceMark(receipt.source, receipt.note)}</dd></div>
        </dl>
      </div>
      {photo}
    </div>
    <p className="receipt-head-total"><span className="receipt-head-label">Итог</span>
      <span className="ck-hero-figure">{money(receipt.total, receipt.currency)}</span></p>
    {categories.length > 0 && <ul className="receipt-head-chips" aria-label="Категории">
      {categories.map((category) => <li key={category.id}><CategoryChip category={category} /></li>)}
    </ul>}
    {receipt.unmatched_products_count > 0 && <p className="receipt-warning">Товары не сопоставлены: {receipt.unmatched_products_count.toLocaleString('ru-RU')}</p>}
    {receipt.review_required && <p className="receipt-warning">Данные требуют проверки. Проверьте несопоставленные товары и замечания к изображениям.</p>}
    <dl className="receipt-facts">
      {note && <div><dt>Комментарий</dt><dd>{note}</dd></div>}
      {/* A place typed by hand has no address to read: the empty rows of a spend are left out. */}
      {store && (!manual || store.address.trim()) && <div><dt>Адрес</dt><dd>{recognizedText(store.address)}</dd></div>}
      {store && (!manual || store.city.trim()) && <div><dt>Город и страна</dt><dd>{recognizedText(store.city)} · {store.country}</dd></div>}
      {/* A manual spend is always a sale without discounts and taxes: those rows say nothing about it. */}
      {!manual && <div><dt>Операция</dt><dd>{receipt.operation === 'refund' ? 'Возврат' : 'Продажа'}</dd></div>}
      {!manual && <div><dt>Сумма скидок</dt><dd className="receipt-number ck-figures">{money(receipt.discount_total, receipt.currency)}</dd></div>}
      <div><dt>Валюта</dt><dd>{receipt.currency}</dd></div>
      {!manual && <div><dt>Налог в ценах</dt><dd>{receipt.prices_include_tax ? 'Включён' : 'Не включён'}</dd></div>}
    </dl>
  </div>
}

/** The crops of the receipt: the heading with the status under it, the picture, «Скачать оригинал» and the job in one row of
 * quiet links, then the notes of the recognition. */
export function ReceiptImages({ images, receiptId }: { images: ReceiptImage[]; receiptId: number }) {
  return <ul className="receipt-images">{images.map((image) => <li className="receipt-image-card" key={image.id}>
    <div className="receipt-image-head">
      <h3>{numbered('Фото', image.photo_id)} · {glue('вырезка', image.position)}</h3>
      <p className="receipt-image-status">{imageLabels[image.status]}</p>
      {image.confirmed_at !== null && <p className="receipt-note">Подтверждено вручную: <time dateTime={image.confirmed_at}>{formatObservedAt(image.confirmed_at)}</time></p>}
    </div>
    <ReceiptMedia url={image.image_url} display={image.display_url} size={image} alt={`Вырезка ${image.position} с фото №${image.photo_id}, чек №${receiptId}`} />
    <div className="receipt-image-links">
      <DownloadOriginal url={image.download_url} />
      <Link className="action-link" to={`/recognition/jobs/${image.job_id}`}>{numbered('Задание', image.job_id)}</Link>
    </div>
    <RecognitionIssues issues={image.issues} status={image.status} />
  </li>)}</ul>
}

export function LineReference({ lineId, lines }: { lineId: number; lines: Line[] }) {
  const line = lines.find((candidate) => candidate.id === lineId)
  return line ? <a href={`#receipt-line-${line.id}`}>{glue('Строка', line.position)}: {recognizedText(line.name)}</a>
    : <span>{glue('Строка', 'ID', lineId)} (на другой странице строк)</span>
}

export function CurrencyNote({ currency }: { currency?: string }) {
  return !currency ? <p className="receipt-warning">Валюта: {unknown}. Загрузите сведения о чеке, чтобы увидеть валюту сумм.</p> : null
}

/** The content of the row heading of the table. */
function LineHeading({ line, lines }: { line: Line; lines: Line[] }) {
  return <>
    <span className="receipt-note">{glue('Строка', line.position)} · {lineKinds[line.kind]}</span>
    <span className="receipt-printed-name">{recognizedText(line.name)}</span>
    {line.product ? <Link className="receipt-product-link" to={`/catalog/products/${line.product.id}`}>Товар каталога: {recognizedText(line.product.name)}</Link>
      : line.category ? <span className="receipt-note receipt-line-category">Категория: {line.category.name}</span>
        : <span className="receipt-warning">Товар не сопоставлен</span>}
    <LineRelations line={line} lines={lines} />
  </>
}

function LineRelations({ line, lines }: { line: Line; lines: Line[] }) {
  return <>
    {line.parent_id !== null && <span className="receipt-line-relation">{line.kind === 'deposit' || line.kind === 'deposit_return' ? 'Залог к ' : 'Связь с '}<LineReference lineId={line.parent_id} lines={lines} /></span>}
    {lines.filter((child) => child.parent_id === line.id).map((child) => <span className="receipt-line-relation" key={child.id}>
      {lineKinds[child.kind]}: <LineReference lineId={child.id} lines={lines} />
    </span>)}
  </>
}

/** Under the name of a row of the phone view: the category as a chip, the number on the receipt and the kind (not for a
 * spend typed by hand: its lines were never printed), the catalog link or the unmatched mark, the relations. */
function LineDetails({ line, lines, manual }: { line: Line; lines: Line[]; manual: boolean }) {
  return <>
    {line.category && <CategoryChip category={line.category} hint />}
    {!manual && <span className="receipt-note">{glue('Строка', line.position)} · {lineKinds[line.kind]}</span>}
    {line.product ? <Link className="receipt-product-link" to={`/catalog/products/${line.product.id}`}>Товар каталога: {recognizedText(line.product.name)}</Link>
      : !line.category && !manual && <span className="receipt-warning">Товар не сопоставлен</span>}
    <LineRelations line={line} lines={lines} />
  </>
}

/** The lines of a receipt: the table on a wide screen, rows of the card on a phone. `manual` — a spend typed by hand:
 * no printed order and no discounts to explain. */
export function ReceiptLines({ lines, currency, manual = false }: { lines: Line[]; currency?: string; manual?: boolean }) {
  const narrow = useNarrow()
  return <>
    <CurrencyNote currency={currency} />
    {!manual && <p className="receipt-note">«Оплачено» учитывает скидку строки. Скидка всего чека по строкам не распределяется.</p>}
    {narrow ? <ReceiptLineLeaders lines={lines} currency={currency} columns={lineColumns} caption={manual ? undefined : linesCaption}
      details={(line) => <LineDetails line={line} lines={lines} manual={manual} />} /> : <div className="receipt-table-scroll" role="region" aria-label="Таблица строк чека, прокручивается по горизонтали" tabIndex={0}>
      <table className="receipt-lines-table">
        <caption>{linesCaption}</caption>
        <thead><tr>{lineColumns.map((label) => <th scope="col" key={label}>{label}</th>)}</tr></thead>
        <tbody>{lines.map((line) => <tr id={`receipt-line-${line.id}`} key={line.id} tabIndex={-1}>
          <th scope="row"><LineHeading line={line} lines={lines} /></th>
          <td className="receipt-number">{recognizedValue(formatQuantity(line.quantity, line.unit))}</td>
          <td className="receipt-number">{price(line.unit_price, currency)}</td>
          <td className="receipt-number">{money(line.amount, currency)}</td>
          <td className="receipt-number">{money(line.discount_amount, currency)}</td>
          <td className="receipt-number">{money(line.paid_amount, currency)}</td>
        </tr>)}</tbody>
      </table>
    </div>}
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
