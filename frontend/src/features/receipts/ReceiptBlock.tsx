import { useId } from 'react'
import type { ReactNode } from 'react'
import RequestState from '../../components/RequestState'
import { paginationItems } from '../../components/pagination-items'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import type { ReceiptRequestState } from './request'
import { errorMessage } from './state'

export function ReceiptBlock<T>({ title, state, retry, recovery, children, id }: {
  title: string; state: ReceiptRequestState<T>; retry: () => void; recovery?: ReactNode; children: ReactNode; id?: string
}) {
  const heading = useId()
  const block = useLocalRequestFocus(state)
  return <section id={id} ref={block} className="receipt-panel" aria-labelledby={heading} aria-busy={state.kind === 'loading'}>
    <h2 id={heading} data-request-focus-target tabIndex={-1}>{title}</h2>
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
