import { useCallback } from 'react'
import { getReceipts } from '../../api/receipts'
import type { Receipt } from '../../api/receipts'
import type { Page } from '../../api/types'
import Pagination from '../../components/Pagination'
import RequestState from '../../components/RequestState'
import { formatPurchasedOn } from '../../lib/format'
import { numbered } from '../../lib/text'
import { buildReceiptsQuery, Link } from '../../navigation'
import type { ReceiptsQuery } from '../../navigation'
import type { ReceiptsPageProps } from '../../pages/types'
import { ReceiptBlock } from './ReceiptBlock'
import ReceiptFilters from './ReceiptFilters'
import ReceiptMedia from './ReceiptMedia'
import type { ReceiptRequestState } from './request'
import { hasFilters, money, receiptParams, recognizedText, recognizedValue } from './state'
import { useReceiptRequest } from './useReceiptRequest'
import './Receipts.css'

export function ReceiptList({ receipts }: { receipts: Receipt[] }) {
  return <ul className="receipt-list">{receipts.map((receipt) => <li key={receipt.id} className="receipt-list-card">
    {receipt.preview_image_url && <ReceiptMedia url={receipt.preview_image_url} thumbnail alt={`Миниатюра чека №${receipt.id}`} />}
    <div className="receipt-list-content">
      <h3><Link to={`/receipts/${receipt.id}`}>{recognizedText(receipt.store.name)} · {numbered('чек', receipt.id)}</Link></h3>
      <p className="receipt-note">{recognizedText(receipt.store.city)} · {recognizedText(receipt.store.address)}</p>
      <dl className="receipt-facts">
        <div><dt>Дата покупки</dt><dd><time dateTime={receipt.purchased_on}>{recognizedValue(formatPurchasedOn(receipt.purchased_on))}</time></dd></div>
        <div><dt>Итог</dt><dd className="receipt-number receipt-total">{money(receipt.total, receipt.currency)}</dd></div>
        <div><dt>Строк</dt><dd>{receipt.lines_count.toLocaleString('ru-RU')}</dd></div>
        <div><dt>Операция</dt><dd>{receipt.operation === 'refund' ? 'Возврат' : 'Продажа'}</dd></div>
      </dl>
      {receipt.unmatched_products_count > 0 && <p className="receipt-warning">Товары не сопоставлены: {receipt.unmatched_products_count.toLocaleString('ru-RU')}</p>}
      {receipt.review_required && <p className="receipt-warning">Данные требуют проверки</p>}
    </div>
  </li>)}</ul>
}

export function ReceiptsView({ query, state, retry }: {
  query: ReceiptsQuery; state: ReceiptRequestState<Page<Receipt>>; retry: () => void
}) {
  const recovery = state.kind === 'error' && state.reason === 'page_out_of_range'
    ? <Link className="action-link" to={{ kind: 'receipts', query: { ...query, page: 1 } }}>На первую страницу</Link>
    : state.kind === 'error' && ['invalid_parameter', 'invalid_request'].includes(state.reason)
      ? <Link className="action-link" to="/receipts">Сбросить фильтры</Link> : undefined
  return <div className="receipts-page">
    <div className="receipt-actions">
      <Link className="action-link receipt-primary" to="/receipts/upload">Загрузить фото</Link>
      <Link className="action-link" to="/recognition/jobs">Обработка</Link>
    </div>
    <ReceiptFilters query={query} failure={state.kind === 'error' ? state : undefined} />
    <ReceiptBlock title="Список чеков" state={state} retry={retry} recovery={recovery}>
      {state.kind === 'ok' && (state.data.results.length ? <>
        <p className="receipt-note" role="status">Чеков: {state.data.count.toLocaleString('ru-RU')} · Страница {state.data.page.toLocaleString('ru-RU')} из {state.data.pages.toLocaleString('ru-RU')}</p>
        <ReceiptList receipts={state.data.results} />
        <Pagination page={state.data.page} pages={state.data.pages}
          buildPageHref={(page) => `/receipts${buildReceiptsQuery({ ...query, page })}`} label="Страницы чеков" />
      </> : <RequestState kind="empty" message={hasFilters(query) ? 'По выбранным фильтрам чеков нет.' : 'Чеков пока нет. Загрузите первое фото чека.'}
        action={<Link className="action-link" to={hasFilters(query) ? '/receipts' : '/receipts/upload'}>{hasFilters(query) ? 'Сбросить фильтры' : 'Загрузить фото'}</Link>} />)}
    </ReceiptBlock>
    {state.kind === 'loading' && <p className="receipt-note">Страница {query.page.toLocaleString('ru-RU')}</p>}
  </div>
}

export default function ReceiptsPage({ query }: ReceiptsPageProps) {
  const { page, store, product, country, currency, operation, date_from, date_to, q, page_size, ordering } = query
  const load = useCallback((signal: AbortSignal) => getReceipts(receiptParams({
    page, store, product, country, currency, operation, date_from, date_to, q, page_size, ordering,
  }), { signal }), [page, store, product, country, currency, operation, date_from, date_to, q, page_size, ordering])
  const request = useReceiptRequest(load)
  return <ReceiptsView query={query} state={request.state} retry={request.retry} />
}
