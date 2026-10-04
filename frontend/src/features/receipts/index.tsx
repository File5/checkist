import RequestState from '../../components/RequestState'
import { Link } from '../../navigation'
import type { ReceiptPageProps, ReceiptsPageProps } from '../../pages/types'

// I3 replaces this directory. Stable exports/props (from pages/types):
// ReceiptsPage({query}: ReceiptsPageProps), ReceiptPage({receiptId, returnTo?}: ReceiptPageProps).
// App owns the single h1. Local request state/pagination belong to the feature.
export function ReceiptsPage({ query }: ReceiptsPageProps) {
  return <RequestState kind="empty" message={`Список чеков готовится. Страница ${query.page}.`} action={<Link to="/receipts/upload">Загрузить фото</Link>} />
}
export function ReceiptPage({ receiptId, returnTo }: ReceiptPageProps) {
  return <RequestState kind="empty" message={`Страница чека №${receiptId} готовится. Данные ещё не запрашиваются.`} action={<Link to={returnTo ?? '/receipts'}>К чекам</Link>} />
}
