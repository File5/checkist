import { useCallback, useMemo } from 'react'
import { getReceipts } from '../../api/receipts'
import type { Receipt, ReceiptListItem } from '../../api/receipts'
import { getJobs } from '../../api/recognition'
import type { Page } from '../../api/types'
import Pagination from '../../components/Pagination'
import RequestState from '../../components/RequestState'
import { useNarrow } from '../../lib/cards'
import { formatPurchasedOn } from '../../lib/format'
import { numbered } from '../../lib/text'
import { buildReceiptsQuery, Link } from '../../navigation'
import { useSession } from '../../session'
import type { ReceiptsQuery } from '../../navigation'
import type { ReceiptsPageProps } from '../../pages/types'
import { ReceiptBlock } from './ReceiptBlock'
import ReceiptFilters from './ReceiptFilters'
import ReceiptMedia from './ReceiptMedia'
import type { ReceiptRequestState } from './request'
import { OwnerChips, SpendDays } from './SpendDays'
import { localToday, ownerChips, reviewJobsQuery, reviewText } from './spends'
import type { OwnerChip } from './spends'
import { hasFilters, money, ownerShown, receiptParams, receiptPlace, recognizedText, recognizedValue } from './state'
import { ManualMark } from './ManualMark'
import { useReceiptRequest } from './useReceiptRequest'
import './Receipts.css'

export function ReceiptList({ receipts, showOwner = false }: { receipts: Receipt[]; showOwner?: boolean }) {
  return <ul className="receipt-list">{receipts.map((receipt) => <li key={receipt.id} className="receipt-list-card">
    {receipt.preview_image_url && <ReceiptMedia url={receipt.preview_image_url} thumbnail alt={`Миниатюра чека №${receipt.id}`} />}
    <div className="receipt-list-content">
      <h3><Link to={`/receipts/${receipt.id}`}>{receiptPlace(receipt)} · {numbered(receipt.source === 'manual' ? 'трата' : 'чек', receipt.id)}</Link>
        {receipt.source === 'manual' && <> <ManualMark /></>}</h3>
      {receipt.store ? <p className="receipt-note">{recognizedText(receipt.store.city)} · {recognizedText(receipt.store.address)}</p>
        : receipt.note && <p className="receipt-note">{receipt.note}</p>}
      <dl className="receipt-facts">
        <div><dt>Дата покупки</dt><dd><time dateTime={receipt.purchased_on}>{recognizedValue(formatPurchasedOn(receipt.purchased_on))}</time></dd></div>
        <div><dt>Итог</dt><dd className="receipt-number receipt-total">{money(receipt.total, receipt.currency)}</dd></div>
        <div><dt>Строк</dt><dd>{receipt.lines_count.toLocaleString('ru-RU')}</dd></div>
        <div><dt>Операция</dt><dd>{receipt.operation === 'refund' ? 'Возврат' : 'Продажа'}</dd></div>
        {showOwner && <div><dt>Добавил</dt><dd className="receipt-owner">{receipt.owner}</dd></div>}
      </dl>
      {receipt.unmatched_products_count > 0 && <p className="receipt-warning">Товары не сопоставлены: {receipt.unmatched_products_count.toLocaleString('ru-RU')}</p>}
      {receipt.review_required && <p className="receipt-warning">Данные требуют проверки</p>}
    </div>
  </li>)}</ul>
}


/** «2 фото ждут проверки» → the jobs that wait for a person. Nothing while unknown or zero. */
export function ReviewBanner({ count }: { count: number | undefined }) {
  if (!count) return null
  return <p className="spends-review">
    <Link to={{ kind: 'jobs', query: reviewJobsQuery }}>{reviewText(count)}</Link>
  </p>
}

export function ReceiptsView({ query, state, retry, showOwner = false, narrow = false, chips = [], review, today = localToday() }: {
  query: ReceiptsQuery; state: ReceiptRequestState<Page<ReceiptListItem>>; retry: () => void; showOwner?: boolean
  /** A phone: days and rows instead of the cards of the wide screen. */
  narrow?: boolean
  chips?: OwnerChip[]
  /** Jobs waiting for a person; `undefined` while unknown. */
  review?: number
  today?: string
}) {
  const recovery = state.kind === 'error' && state.reason === 'page_out_of_range'
    ? <Link className="action-link" to={{ kind: 'receipts', query: { ...query, page: 1 } }}>На первую страницу</Link>
    : state.kind === 'error' && ['invalid_parameter', 'invalid_request'].includes(state.reason)
      ? <Link className="action-link" to="/receipts">Сбросить фильтры</Link> : undefined
  return <div className="receipts-page">
    <OwnerChips chips={chips} query={query} />
    <ReviewBanner count={review} />
    <div className="receipt-actions">
      <Link className="action-link receipt-primary" to="/receipts/upload">Загрузить фото</Link>
      <Link className="action-link receipt-primary" to="/receipts/new">Добавить трату</Link>
      <Link className="action-link" to="/recognition/jobs">Обработка</Link>
    </div>
    <ReceiptFilters query={query} failure={state.kind === 'error' ? state : undefined} />
    <ReceiptBlock title="Список чеков" state={state} retry={retry} recovery={recovery}>
      {state.kind === 'ok' && (state.data.results.length ? <>
        <p className="receipt-note" role="status">Чеков: {state.data.count.toLocaleString('ru-RU')} · Страница {state.data.page.toLocaleString('ru-RU')} из {state.data.pages.toLocaleString('ru-RU')}</p>
        {narrow ? <SpendDays receipts={state.data.results} today={today} showOwner={showOwner} />
          : <ReceiptList receipts={state.data.results} showOwner={showOwner} />}
        <Pagination page={state.data.page} pages={state.data.pages}
          buildPageHref={(page) => `/receipts${buildReceiptsQuery({ ...query, page })}`} label="Страницы чеков" />
      </> : <RequestState kind="empty" message={hasFilters(query) ? 'По выбранным фильтрам чеков нет.' : 'Чеков пока нет. Загрузите первое фото чека.'}
        action={<Link className="action-link" to={hasFilters(query) ? '/receipts' : '/receipts/upload'}>{hasFilters(query) ? 'Сбросить фильтры' : 'Загрузить фото'}</Link>} />)}
    </ReceiptBlock>
    {state.kind === 'loading' && <p className="receipt-note">Страница {query.page.toLocaleString('ru-RU')}</p>}
  </div>
}

export default function ReceiptsPage({ query }: ReceiptsPageProps) {
  const { page, store, product, country, currency, operation, date_from, date_to, q, owner, page_size, ordering } = query
  const load = useCallback((signal: AbortSignal) => getReceipts(receiptParams({
    page, store, product, country, currency, operation, date_from, date_to, q, owner, page_size, ordering,
  }), { signal }), [page, store, product, country, currency, operation, date_from, date_to, q, owner, page_size, ordering])
  const request = useReceiptRequest(load)
  const loadReview = useCallback((signal: AbortSignal) => getJobs({ needs_review: reviewJobsQuery.needs_review, page_size: 1 }, { signal }), [])
  const review = useReceiptRequest(loadReview)
  const session = useSession()
  const chips = useMemo(() => ownerChips(session, owner), [session, owner])
  const narrow = useNarrow()
  return <ReceiptsView query={query} state={request.state} retry={request.retry} showOwner={ownerShown(session)} narrow={narrow}
    chips={chips} review={review.state.kind === 'ok' ? review.state.data.count : undefined} />
}
