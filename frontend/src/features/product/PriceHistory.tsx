import { Link } from '../../navigation'
import type { HistoryQuery, NavigationTarget } from '../../navigation'
import type { PriceHistory as HistoryData, Store } from '../../api/types'
import RequestState from '../../components/RequestState'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import Pagination from '../../components/Pagination'
import { formatObservedAt, formatPrice, formatPurchasedOn } from '../../lib/format'
import { numbered } from '../../lib/text'
import ProductRequestState from './ProductRequestState'
import { hasFilters, storeLabel } from './state'
import type { RequestState as LoadState } from './state'

export default function PriceHistory({ state, query, stores, retry, reset, buildPageHref }: {
  state: LoadState<HistoryData>; query: HistoryQuery; stores: Store[]; retry: () => void; reset: () => void
  buildPageHref: (page: number) => NavigationTarget
}) {
  const block = useLocalRequestFocus(state)
  const knownStores = new Map(stores.map((store) => [store.id, store]))
  return (
    <section ref={block} className="product-panel" aria-labelledby="product-history-heading" aria-busy={state.kind === 'loading'}>
      <h2 id="product-history-heading" tabIndex={-1} data-request-focus-target>История цен</h2>
      {state.kind === 'loading' && <RequestState kind="loading" message="Загружаем историю покупок…" />}
      {state.kind === 'error' && <ProductRequestState failure={state} retry={retry} reset={reset} firstPage={buildPageHref(1)} />}
      {state.kind === 'ok' && (state.data.results.length === 0
        ? <RequestState kind="empty" message={hasFilters(query) ? 'Нет записей по выбранным фильтрам' : 'Покупок этого товара пока нет'} action={hasFilters(query) && <button type="button" onClick={reset}>Сбросить фильтры</button>} />
        : <>
          <p className="product-note" role="status">Наблюдений: {state.data.count.toLocaleString('ru-RU')}. Сначала новые покупки.</p>
          <p className="product-note" id="product-history-scroll">Если таблица не помещается по ширине, она прокручивается внутри рамки: выберите её клавишей Tab и используйте стрелки. Магазин остаётся на месте.</p>
          <div className="product-table-scroll" role="region" aria-label="История цен по магазинам" aria-describedby="product-history-scroll" tabIndex={0}>
            <table className="product-table">
              <caption>Наблюдения покупок из чеков</caption>
              <thead><tr>
                <th scope="col">Магазин и адрес</th><th scope="col">Дата</th>
                <th scope="col" className="product-number">До скидки</th>
                <th scope="col" className="product-number">После скидки</th>
                <th scope="col" className="product-number">За базовую единицу</th>
                <th scope="col">Покупка</th>
              </tr></thead>
              {/* The store is the row header and the first column: it stays in place while the table scrolls sideways.
                  A foreign purchase has no receipt or position: the row is identified by its place on the page. */}
              <tbody>{state.data.results.map((point, index) => {
                const store = knownStores.get(point.store.id)
                return <tr key={index}>
                  <th scope="row">{storeLabel(store ?? point.store)}</th>
                  <td><time dateTime={point.purchased_on}>{formatPurchasedOn(point.purchased_on)}</time>{point.own && <span className="product-subtext"><time dateTime={point.observed_at}>{formatObservedAt(point.observed_at, store?.timezone)}</time></span>}</td>
                  <td className="product-number">{formatPrice(point.list_unit_price, point.currency, point.unit)}</td>
                  <td className="product-number">{formatPrice(point.paid_unit_price, point.currency, point.unit)}</td>
                  <td className="product-number">{point.normalized_price === null ? <span className="product-cell-text">Нет данных для пересчёта</span> : formatPrice(point.normalized_price, point.currency, point.normalized_unit)}
                    {!point.comparable && <span className="product-subtext product-cell-text">Не сопоставимо с базовой единицей товара</span>}
                  </td>
                  <td>{point.own ? <>Моя · <Link to={{ kind: 'receipt', receiptId: point.receipt_id }}>{numbered('Чек', point.receipt_id)}</Link></> : 'Чужая'}</td>
                </tr>
              })}</tbody>
            </table>
          </div>
          <Pagination page={state.data.page} pages={state.data.pages} buildPageHref={buildPageHref} label="Страницы истории цен" />
        </>)}
    </section>
  )
}
