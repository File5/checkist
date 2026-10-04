import type { PriceSummary as SummaryData } from '../../api/types'
import RequestState from '../../components/RequestState'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import { formatPercent, formatPrice, formatPurchasedOn, formatUnit } from '../../lib/format'
import ProductRequestState from './ProductRequestState'
import { storeLabel } from './state'
import type { RequestState as LoadState } from './state'

export default function PriceSummary({ state, retry, reset }: {
  state: LoadState<SummaryData>; retry: () => void; reset: () => void
}) {
  const block = useLocalRequestFocus(state)
  return (
    <section ref={block} className="product-panel" aria-labelledby="product-summary-heading" aria-busy={state.kind === 'loading'}>
      <h2 id="product-summary-heading" data-request-focus-target tabIndex={-1}>Сводка по магазинам</h2>
      <p className="product-note">Цены после скидок строки за весь выбранный период. Каждая валюта и единица показаны отдельно. Средняя — невзвешенная.</p>
      {state.kind === 'loading' && <RequestState kind="loading" message="Загружаем сводку цен…" />}
      {state.kind === 'error' && <ProductRequestState failure={state} retry={retry} reset={reset} />}
      {state.kind === 'ok' && state.data.group_by === 'store' && (state.data.groups.length === 0
        ? <RequestState kind="empty" message="Нет наблюдений для сводки по выбранным фильтрам" />
        : <ul className="product-summary-list">{state.data.groups.map((group) => (
          <li className="product-summary-group" key={`${group.store.id}:${group.currency}:${group.unit}`}>
            <h3>{storeLabel(group.store)}</h3>
            <p className="product-summary-unit">{group.currency} / {formatUnit(group.unit)}</p>
            <dl className="product-facts">
              <div><dt>Число покупок</dt><dd className="product-number">{group.total.count.toLocaleString('ru-RU')}</dd></div>
              <div><dt>Минимальная</dt><dd className="product-number">{formatPrice(group.total.min, group.currency, group.unit)}</dd></div>
              <div><dt>Максимальная</dt><dd className="product-number">{formatPrice(group.total.max, group.currency, group.unit)}</dd></div>
              <div><dt>Средняя</dt><dd className="product-number">{formatPrice(group.total.avg, group.currency, group.unit)}</dd></div>
              <div><dt>Первая цена</dt><dd className="product-number">{formatPrice(group.total.first.price, group.currency, group.unit)}<span className="product-subtext"><time dateTime={group.total.first.purchased_on}>{formatPurchasedOn(group.total.first.purchased_on)}</time></span></dd></div>
              <div><dt>Последняя цена</dt><dd className="product-number">{formatPrice(group.total.last.price, group.currency, group.unit)}<span className="product-subtext"><time dateTime={group.total.last.purchased_on}>{formatPurchasedOn(group.total.last.purchased_on)}</time></span></dd></div>
              <div><dt>Изменение</dt><dd className="product-number">{group.total.change_percent === null ? 'Нет данных для расчёта' : formatPercent(group.total.change_percent)}</dd></div>
            </dl>
          </li>
        ))}</ul>)}
    </section>
  )
}
