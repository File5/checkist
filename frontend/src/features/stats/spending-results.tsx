import { useId } from 'react'
import type { SpendingGroupBy } from '../../api/stats'
import { spendingGroupings } from '../../api/stats'
import RequestState from '../../components/RequestState'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import { PieChart } from '../../lib/charts'
import { Link } from '../../navigation'
import type { SpendingQuery } from '../../navigation'
import { PeriodText } from './period'
import {
  breadcrumbs, failureView, grouping, groupingCaptions, groupingHref, groupingLabels, hasFilters, needsAddressReset, resetHref, shownResult, upHref,
} from './spending-state'
import type { Shown, SpendingFailure, SpendingRequestState } from './spending-state'
import { blockView, unassignedHint } from './spending-view'
import type { BlockView } from './spending-view'

const nameHeaders: Record<SpendingGroupBy, string> = { category: 'Категория', generic: 'Обобщённый продукт', product: 'Товар', store: 'Магазин' }

export function SpendingBlock({ view, groupBy }: { view: BlockView; groupBy: SpendingGroupBy }) {
  const heading = useId()
  return <section className="spending-currency" aria-labelledby={heading}>
    <h3 id={heading}>{view.currency}</h3>
    <dl className="spending-facts">
      <div><dt>{view.total.label}</dt><dd className="spending-total">{view.total.text}</dd></div>
      <div><dt>Чеков</dt><dd>{view.receipts}</dd></div>
      {view.total.text !== view.linesPaid && <div><dt>Сумма строк</dt><dd>{view.linesPaid}</dd></div>}
    </dl>
    <PieChart title={view.title} items={view.items} centerLabel={view.center.label} centerValue={view.center.value}
      headers={{ name: nameHeaders[groupBy], value: 'Сумма', share: 'Доля' }} linkComponent={Link}
      excludedNote="Сумма не положительная: в диаграмму не входит, доля не считается." />
    <p className="spending-note">{view.difference}</p>
    {view.needsAdminHint && <p className="spending-note">
      «Не разобрано» и строки без товара показаны как есть, новых категорий статистика не придумывает. {unassignedHint}
    </p>}
  </section>
}

function Failure({ failure, query, retry }: { failure: SpendingFailure; query: SpendingQuery; retry: () => void }) {
  const view = failureView(failure)
  if (view.retry) return <RequestState kind="error" message={view.message} onRetry={retry} />
  const reset = failure.reason === 'range_too_large' || needsAddressReset(failure)
  return <RequestState kind="empty" message={view.message}
    action={reset ? <Link className="action-link" to={resetHref(query)}>Сбросить фильтры</Link> : undefined} />
}

/** The result block: breakdown switch, the way back and one independent block per currency. */
export default function SpendingResults({ query, state, retry, last, genericName }: {
  query: SpendingQuery; state: SpendingRequestState; retry: () => void
  /** The previous answer with its own query: stays visible while the next one loads. */
  last?: Shown
  genericName?: string
}) {
  const heading = useId()
  const block = useLocalRequestFocus<HTMLElement>(state)
  const by = grouping(query)
  const shown = shownResult(state, query, last)
  const crumbs = breadcrumbs(query, shown?.data.parent, genericName)
  const up = upHref(crumbs)
  const loading = state.kind === 'loading'

  return <section ref={block} className="spending-panel" aria-labelledby={heading} aria-busy={loading}>
    <h2 id={heading} data-request-focus-target tabIndex={-1}>Траты {groupingCaptions[by]}</h2>
    <nav aria-label="Разбивка трат">
      <ul className="spending-chips">
        {spendingGroupings.map((value) => <li key={value}>
          <Link to={groupingHref(query, value)} aria-current={value === by ? 'true' : undefined}>{groupingLabels[value]}</Link>
        </li>)}
      </ul>
    </nav>
    {crumbs.length > 0 && <nav className="spending-path" aria-label="Путь в тратах">
      <ol className="spending-crumbs">
        {crumbs.map((crumb, index) => <li key={index}>
          {crumb.href ? <Link to={crumb.href}>{crumb.label}</Link> : <span aria-current="page">{crumb.label}</span>}
        </li>)}
      </ol>
      {up && <Link className="action-link" to={up}>На уровень выше</Link>}
    </nav>}
    <p className="spending-status" role="status">
      {shown && (shown.stale ? 'Обновляем данные по новым фильтрам…' : <PeriodText period={shown.data} />)}
    </p>
    {state.kind === 'error' && <Failure failure={state} query={query} retry={retry} />}
    {loading && !shown && <RequestState kind="loading" message="Загружаем траты…" />}
    {shown && (shown.data.currencies.length === 0
      ? <RequestState kind="empty"
        message={hasFilters(shown.query) ? 'По выбранным фильтрам трат нет.' : 'Чеков пока нет: статистике не из чего считать. Загрузите первое фото чека.'}
        action={hasFilters(shown.query)
          ? <Link className="action-link" to={resetHref(shown.query)}>Сбросить фильтры</Link>
          : <Link className="action-link" to="/receipts/upload">Загрузить фото</Link>} />
      : <div className="spending-blocks" data-stale={shown.stale ? 'true' : undefined}>
        <p className="spending-note">
          Суммы в разных валютах не складываются и не пересчитываются: у каждой валюты свой блок со своим итогом.
        </p>
        {shown.data.currencies.map((currency) => <SpendingBlock key={currency.currency} groupBy={shown.data.group_by}
          view={blockView(currency, shown.data.group_by, shown.query)} />)}
      </div>)}
  </section>
}
