import { useCallback, useEffect, useId, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import type { ReactNode } from 'react'
import { getReceipts } from '../../api/receipts'
import type { Receipt, ReceiptListItem } from '../../api/receipts'
import { getJobs } from '../../api/recognition'
import type { Page } from '../../api/types'
import Pagination from '../../components/Pagination'
import RequestState from '../../components/RequestState'
import { useNarrow } from '../../lib/cards'
import { formatPurchasedOn } from '../../lib/format'
import { ownerName } from '../../lib/people'
import { numbered } from '../../lib/text'
import { buildReceiptsQuery, Link } from '../../navigation'
import { isHead, useSession } from '../../session'
import PendingSpends from '../../offline/PendingSpends'
import type { ReceiptsQuery } from '../../navigation'
import type { ReceiptsPageProps } from '../../pages/types'
import { ReceiptBlock } from './ReceiptBlock'
import { clearReceiptsNotice, getReceiptsNotice } from './delete-receipt'
import ReceiptFilters from './ReceiptFilters'
import ReceiptMedia from './ReceiptMedia'
import type { ReceiptRequestState } from './request'
import { HiddenChip, OwnerChips, SpendDays } from './SpendDays'
import type { SpendDelete } from './SpendDays'
import SpendSearch from './SpendSearch'
import { hiddenIds, undoDelete } from './undo-delete'
import type { Deletion } from './undo-delete'
import { localToday, ownerChips, reviewJobsQuery, reviewText, rowTitle, spendsCount } from './spends'
import type { OwnerChip } from './spends'
import { activeFilterCount, hasFilters, money, ownerShown, receiptParams, receiptPlace, recognizedText, recognizedValue } from './state'
import Sheet from '../../components/Sheet'
import { filtersButtonLabel } from '../../components/filters-label'
import '../../components/ResponsiveFilters.css'
import { ManualMark } from './ManualMark'
import { useReceiptRequest } from './useReceiptRequest'
import '../expense/Expense.css'
import './Receipts.css'

/** The former list of cards with thumbnails and facts. «Траты» shows days of rows on every width now (SpendDays); the
 * component stays for the screens and tests that still render a single receipt card from it. */
export function ReceiptList({ receipts, showOwner = false }: { receipts: Receipt[]; showOwner?: boolean }) {
  return <ul className="receipt-list">{receipts.map((receipt) => <li key={receipt.id} className="receipt-list-card">
    {receipt.preview_image_url && <ReceiptMedia url={receipt.preview_image_url} display={receipt.preview_thumb_url} thumbnail alt={`Миниатюра чека №${receipt.id}`} />}
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
        {showOwner && <div><dt>Добавил</dt><dd className="receipt-owner">{ownerName(receipt)}</dd></div>}
      </dl>
      {receipt.unmatched_products_count > 0 && <p className="receipt-warning">Товары не сопоставлены: {receipt.unmatched_products_count.toLocaleString('ru-RU')}</p>}
      {receipt.review_required && <p className="receipt-warning">Данные требуют проверки</p>}
      {receipt.hidden && <p className="receipt-warning" data-receipt-hidden>Скрыто</p>}
    </div>
  </li>)}</ul>
}


/** «2 фото ждут проверки · Проверить» → the jobs that wait for a person. Nothing while unknown or zero. */
export function ReviewBanner({ count }: { count: number | undefined }) {
  if (!count) return null
  return <p className="spends-review">
    <Link to={{ kind: 'jobs', query: reviewJobsQuery }}>
      <span className="spends-review-text">{reviewText(count)}</span><span className="spends-review-action" aria-hidden="true">Проверить</span>
    </Link>
  </p>
}

/** «Фильтры» of a phone beside the family chips: a round button with a funnel and the number of what is filtered.
 * Its name says the same in words («Фильтры (2)»). */
export function FiltersToggle({ count, open, sheetId, onOpen }: { count: number; open: boolean; sheetId: string; onOpen: () => void }) {
  return <button type="button" className="spends-filters-toggle" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? sheetId : undefined}
    aria-label={filtersButtonLabel(count)} onClick={onOpen}>
    <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" focusable="false"><path d="M3 6h18M6 12h12M10 18h4" /></svg>
    {count > 0 && <span className="spends-filters-count" aria-hidden="true">{count.toLocaleString('ru-RU')}</span>}
  </button>
}

/** «Удалено · Сбербанк [Отменить]» at the bottom of the screen while a deleted spend waits for the server (undo-delete.ts).
 * The live region is always there so that its text is announced; the focus inside it stops the time. */
export function UndoBar({ pending, onUndo, onHold, onRelease, focus = false }: {
  pending: Deletion | null; onUndo: () => void; onHold?: () => void; onRelease?: () => void
  /** The deletion came from a keyboard: the focus moves to «Отменить» (and the time waits while it is there). */
  focus?: boolean
}) {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => { if (pending && focus) button.current?.focus() }, [pending, focus])
  return <div className="spends-undo-region" role="status">
    {pending && <div className="spends-undo" onFocus={onHold}
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onRelease?.() }}>
      <span className="spends-undo-text">Удалено · {pending.title}</span>
      <button ref={button} type="button" className="spends-undo-action" onClick={onUndo}>Отменить</button>
    </div>}
  </div>
}

export function ReceiptsView({ query, state, retry, showOwner = false, narrow = false, chips = [], review, today = localToday(), pending, notice, head = false,
  hidden, onDelete, undo, failure }: {
  /** Spends deleted on this screen (waiting, sent or gone): not shown, the count goes down with them. */
  hidden?: ReadonlySet<number>
  /** Swipe and «Удалить» of a spend by hand; left out — the rows are plain links. */
  onDelete?: SpendDelete
  /** The bar «Удалено · Отменить». */
  undo?: ReactNode
  /** A refused deletion: the row is back, the reason above the list. */
  failure?: string
  /** The family head: the chip «Показать скрытые». */
  head?: boolean
  query: ReceiptsQuery; state: ReceiptRequestState<Page<ReceiptListItem>>; retry: () => void; showOwner?: boolean
  /** A phone: the filters behind a round button and a sheet instead of the form in the page. */
  narrow?: boolean
  chips?: OwnerChip[]
  /** Jobs waiting for a person; `undefined` while unknown. */
  review?: number
  today?: string
  /** Spends waiting on the phone (offline mode), above everything else. */
  pending?: ReactNode
  /** Shown once after a receipt or a spend was deleted. */
  notice?: string
}) {
  const [filtersOpen, setFiltersOpen] = useState(false)
  const sheetId = useId()
  const recovery = state.kind === 'error' && state.reason === 'page_out_of_range'
    ? <Link className="action-link" to={{ kind: 'receipts', query: { ...query, page: 1 } }}>На первую страницу</Link>
    : state.kind === 'error' && ['invalid_parameter', 'invalid_request'].includes(state.reason)
      ? <Link className="action-link" to="/receipts">Сбросить фильтры</Link> : undefined
  const filtered = hasFilters(query)
  const closeFilters = () => setFiltersOpen(false)
  const filters = <>
    <HiddenChip query={query} head={head} onToggle={closeFilters} />
    <ReceiptFilters query={query} failure={state.kind === 'error' ? state : undefined} />
  </>
  // Adding a spend is the «＋» of the navigation; the list keeps only the way to the processing of photos, quietly.
  const jobs = <p className="spends-jobs"><Link to="/recognition/jobs">Обработка фото</Link></p>
  const results = state.kind === 'ok' ? state.data.results.filter((receipt) => !hidden?.has(receipt.id)) : []
  const removed = state.kind === 'ok' ? state.data.results.length - results.length : 0
  return <div className={`receipts-page spends-page${narrow ? ' spends-page-narrow' : ''}`}>
    {notice && <p className="expense-notice" role="status">{notice}</p>}
    {failure && <p className="receipt-warning spends-delete-failure" role="alert">{failure}</p>}
    {pending}
    <SpendSearch query={query} failure={state.kind === 'error' ? state : undefined} />
    {/* Who added it, and on a phone the round «Фильтры» at the end of the same line: the form opens in a sheet. */}
    <div className="spends-toolbar">
      <OwnerChips chips={chips} query={query} />
      {narrow ? <FiltersToggle count={activeFilterCount(query)} open={filtersOpen} sheetId={sheetId} onOpen={() => setFiltersOpen(true)} /> : filters}
    </div>
    {narrow && <Sheet open={filtersOpen} onClose={closeFilters} title="Фильтры" id={sheetId}>
      {/* A filter form submitted inside the sheet has done its work: the sheet closes after the form's own handler. */}
      <div className="ck-filters-sheet" onSubmit={closeFilters}>
        {filters}
      </div>
    </Sheet>}
    <ReviewBanner count={review} />
    {/* The days are the cards themselves: the block keeps its heading for a screen reader only. */}
    <ReceiptBlock title="Список трат" state={state} retry={retry} recovery={recovery} bare>
      {/* A page whose spends were all just deleted keeps its count and pages: the list is not «empty». */}
      {state.kind === 'ok' && (results.length || removed ? <>
        <SpendDays receipts={results} today={today} showOwner={showOwner} onDelete={onDelete} />
        <p className="receipt-note spends-count" role="status">{spendsCount(state.data.count - removed)} · Страница {state.data.page.toLocaleString('ru-RU')} из {state.data.pages.toLocaleString('ru-RU')}</p>
        <Pagination page={state.data.page} pages={state.data.pages}
          buildPageHref={(page) => `/receipts${buildReceiptsQuery({ ...query, page })}`} label="Страницы трат" />
      </> : <RequestState kind="empty" title={filtered ? 'Ничего не нашлось' : 'Трат пока нет'}
        message={query.q ? `По запросу «${query.q}» трат нет.` : filtered ? 'По выбранным фильтрам трат нет.' : 'Загрузите первое фото чека или добавьте трату.'}
        action={query.q ? <Link className="action-link" to={{ kind: 'receipts', query: { ...query, q: undefined, page: 1 } }}>Сбросить поиск</Link>
          : filtered ? <Link className="action-link" to="/receipts">Сбросить фильтры</Link>
            : <><Link className="action-link" to="/receipts/upload">Загрузить фото</Link><Link className="action-link" to="/receipts/new">Добавить трату</Link></>} />)}
    </ReceiptBlock>
    {state.kind === 'loading' && <p className="receipt-note spends-count">Страница {query.page.toLocaleString('ru-RU')}</p>}
    {jobs}
    {undo}
  </div>
}

export default function ReceiptsPage({ query }: ReceiptsPageProps) {
  const { page, store, product, country, currency, operation, date_from, date_to, q, owner, hidden, page_size, ordering } = query
  const load = useCallback((signal: AbortSignal) => getReceipts(receiptParams({
    page, store, product, country, currency, operation, date_from, date_to, q, owner, hidden, page_size, ordering,
  }), { signal }), [page, store, product, country, currency, operation, date_from, date_to, q, owner, hidden, page_size, ordering])
  const request = useReceiptRequest(load)
  const loadReview = useCallback((signal: AbortSignal) => getJobs({ needs_review: reviewJobsQuery.needs_review, page_size: 1 }, { signal }), [])
  const review = useReceiptRequest(loadReview)
  const session = useSession()
  const chips = useMemo(() => ownerChips(session, owner), [session, owner])
  const narrow = useNarrow()
  // Read once into the state; the module copy is cleared so that a later visit shows no stale notice.
  const [notice] = useState(getReceiptsNotice)
  useEffect(clearReceiptsNotice, [])
  const removal = useSyncExternalStore(undoDelete.subscribe, undoDelete.getSnapshot, undoDelete.getSnapshot)
  const [byKeyboard, setByKeyboard] = useState(false)
  // A deletion waits for its time only while the person is here: leaving the screen, hiding the tab or closing the page
  // sends it at once (keepalive), so it is never lost on the way out.
  useEffect(() => {
    const send = () => undoDelete.flush()
    const hide = () => { if (document.visibilityState === 'hidden') undoDelete.flush() }
    window.addEventListener('pagehide', send)
    document.addEventListener('visibilitychange', hide)
    return () => {
      window.removeEventListener('pagehide', send)
      document.removeEventListener('visibilitychange', hide)
      undoDelete.flush()
      undoDelete.dismiss()
    }
  }, [])
  const undo = () => {
    const id = removal.pending?.id
    undoDelete.undo()
    // The row is back: the focus goes to it, not to the top of the page.
    if (id !== undefined) requestAnimationFrame(() => document.querySelector<HTMLElement>(`a.spends-row[href="/receipts/${id}"]`)?.focus())
  }
  return <ReceiptsView notice={notice} query={query} state={request.state} retry={request.retry} showOwner={ownerShown(session)} narrow={narrow}
    chips={chips} head={isHead(session)} review={review.state.kind === 'ok' ? review.state.data.count : undefined} pending={<PendingSpends />}
    hidden={hiddenIds(removal)} failure={removal.failure?.message}
    onDelete={(receipt, keyboard) => { setByKeyboard(keyboard); undoDelete.schedule({ id: receipt.id, title: rowTitle(receipt) }) }}
    undo={<UndoBar pending={removal.pending} focus={byKeyboard} onUndo={undo} onHold={undoDelete.hold} onRelease={undoDelete.release} />} />
}
