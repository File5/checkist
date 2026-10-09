import { useId, useMemo } from 'react'
import type { MouseEvent } from 'react'
import type { SpendingCurrency, SpendingGroupBy } from '../../api/stats'
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
import { blockTail } from './spending-tail'
import { blockView, tailSharesNote, unassignedHint } from './spending-view'
import type { BlockView, TailView } from './spending-view'

const nameHeaders: Record<SpendingGroupBy, string> = { category: 'Категория', generic: 'Обобщённый продукт', product: 'Товар', store: 'Магазин' }

/**
 * The pressed button goes away with its message, so the focus first moves to the toggle link of the same table:
 * it stays in place in every state of the composition.
 */
function keepFocus(event: MouseEvent<HTMLButtonElement>) {
  event.currentTarget.closest('table')?.querySelector<HTMLElement>('.ck-pie-action')?.focus()
}

/**
 * The row under the composition: loading, a refusal with its retry, changed data, the remark on the shares.
 * The status paragraph is there in every state of an open «Прочее», only its text changes: a live region that
 * arrives together with its text may stay unannounced.
 */
function TailStatus({ tail, count, failure: refusal, retry, refresh }: {
  tail: NonNullable<BlockView['tail']>; count: number
  /** Why the long answer did not come and what asks for it again. */
  failure?: SpendingFailure; retry?: () => void
  /** Asks for both answers again. */
  refresh: () => void
}) {
  const failure = tail.kind === 'failed' && refusal ? failureView(refusal) : undefined
  const text = tail.kind === 'loading' ? 'Загружаем состав…'
    : tail.kind === 'changed' ? 'Данные изменились. Обновите.'
      : tail.kind === 'failed' ? failure?.message ?? 'Не удалось загрузить состав.'
        : tail.sharesDiffer ? tailSharesNote : `Состав показан, строк: ${count}.`
  const quiet = tail.kind === 'ok' && !tail.sharesDiffer
  return <div className="spending-tail" data-kind={tail.kind} data-quiet={quiet ? 'true' : undefined}>
    <p className="spending-tail-status" role="status">{text}</p>
    {tail.kind === 'changed' && <button type="button" className="spending-secondary" onClick={(event) => { keepFocus(event); refresh() }}>Обновить</button>}
    {failure?.retry && retry && <button type="button" className="spending-secondary" onClick={(event) => { keepFocus(event); retry() }}>Повторить</button>}
  </div>
}

const loadingTail: TailView = { kind: 'loading' }
const failedTail: TailView = { kind: 'failed' }

/**
 * One currency: the block of the usual answer and, when «Прочее» is open, its composition from the long answer.
 * The view is kept between renders, so the rows of a long composition are not rendered again without a reason.
 */
function CurrencyBlock({ block, groupBy, query, tail, retryTail, refresh }: {
  block: SpendingCurrency; groupBy: SpendingGroupBy; query: SpendingQuery
  /** The long answer; read only while the address says `other=open`. */
  tail?: SpendingRequestState; retryTail?: () => void; refresh: () => void
}) {
  const open = query.other === 'open'
  const long = tail?.kind === 'ok' ? tail.data.currencies.find((entry) => entry.currency === block.currency) : undefined
  const phase = tail?.kind ?? 'loading'
  const failure = tail?.kind === 'error' ? tail : undefined
  const opened = useMemo((): TailView | undefined =>
    !open ? undefined : phase === 'loading' ? loadingTail : phase === 'error' ? failedTail : blockTail(block, long), [open, phase, block, long])
  const view = useMemo(() => blockView(block, groupBy, query, opened), [block, groupBy, query, opened])
  const items = useMemo(() => {
    const state = view.tail
    if (!state) return view.items
    return view.items.map((item) => item.key !== 'other' ? item : { ...item,
      childrenStatus: <TailStatus tail={state} count={item.children?.length ?? 0} failure={failure} retry={retryTail} refresh={refresh} /> })
  }, [view, failure, retryTail, refresh])
  const shownView = useMemo(() => ({ ...view, items }), [view, items])
  return <SpendingBlock view={shownView} groupBy={groupBy} />
}

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
export default function SpendingResults({ query, state, retry, last, genericName, tail, retryTail }: {
  query: SpendingQuery; state: SpendingRequestState; retry: () => void
  /** The previous answer with its own query: stays visible while the next one loads. */
  last?: Shown
  genericName?: string
  /** The long answer for the shown one: the composition of «Прочее». Read only while the address says `other=open`. */
  tail?: SpendingRequestState
  retryTail?: () => void
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
        {shown.data.currencies.map((currency) => <CurrencyBlock key={currency.currency} block={currency} groupBy={shown.data.group_by}
          query={shown.query} tail={tail} retryTail={retryTail} refresh={retry} />)}
      </div>)}
  </section>
}
