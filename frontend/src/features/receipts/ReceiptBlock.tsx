import { useId } from 'react'
import type { ReactNode } from 'react'
import RequestState from '../../components/RequestState'
import { paginationItems } from '../../components/pagination-items'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import type { ReceiptRequestState } from './request'
import { errorMessage } from './state'

/**
 * One block of a receipt screen with its own request: a card with a heading (`aside` — a quiet count at the right of it),
 * the loading, the error with «Повторить» or a recovery, then the content. `bare` — no card of its own (the days of
 * «Траты» on a phone are the cards): the heading stays for a screen reader and for the focus after a retry.
 */
export function ReceiptBlock<T>({ title, state, retry, recovery, children, id, aside, bare = false, className }: {
  title: string; state: ReceiptRequestState<T>; retry: () => void; recovery?: ReactNode; children: ReactNode; id?: string
  aside?: ReactNode; bare?: boolean; className?: string
}) {
  const heading = useId()
  const block = useLocalRequestFocus(state)
  const classes = [bare ? 'receipt-bare' : 'receipt-panel', className].filter(Boolean).join(' ')
  const h2 = <h2 id={heading} data-request-focus-target tabIndex={-1} className={bare ? 'receipt-visually-hidden' : undefined}>{title}</h2>
  return <section id={id} ref={block} className={classes} aria-labelledby={heading} aria-busy={state.kind === 'loading'}>
    {aside && state.kind === 'ok' ? <div className="receipt-block-head">{h2}{aside}</div> : h2}
    {state.kind === 'loading' && <RequestState kind="loading" message={`Загружаем: ${title.toLocaleLowerCase('ru-RU')}…`} />}
    {state.kind === 'error' && (recovery
      ? <RequestState kind="empty" message={errorMessage(state)} action={recovery} />
      : <RequestState kind="error" message={errorMessage(state)} onRetry={retry} />)}
    {state.kind === 'ok' && children}
  </section>
}

/** Detail pagination stays local; the shell's receipt route has no block query props. */
export function ReceiptPagination({ page, pages, onPage, label }: {
  page: number; pages: number; onPage: (page: number) => void; label: string
}) {
  const items = paginationItems(page, pages)
  if (!items.length) return null
  return <nav className="pagination receipt-pagination" aria-label={label}><ul>
    {page > 1 && <li><button type="button" onClick={() => onPage(page - 1)}>Предыдущая</button></li>}
    {items.map((item) => <li key={item}>{typeof item === 'number'
      ? <button type="button" aria-label={`Страница ${item.toLocaleString('ru-RU')}`} aria-current={item === page ? 'page' : undefined}
        disabled={item === page} onClick={() => onPage(item)}>{item.toLocaleString('ru-RU')}</button>
      : <span aria-hidden="true">…</span>}</li>)}
    {page < pages && <li><button type="button" onClick={() => onPage(page + 1)}>Следующая</button></li>}
  </ul></nav>
}
