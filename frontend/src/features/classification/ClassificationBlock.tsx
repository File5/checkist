import type { ReactNode } from 'react'
import RequestState from '../../components/RequestState'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import type { RequestState as State } from '../recognition/polling'
import { errorText } from './labels'

/** One independent read of the classification API: heading, loading, refusal with retry, last data with a refresh warning. */
export default function ClassificationBlock<T>({ title, id, state, retry, children, recovery, lead, tail }: {
  title: string; id: string; state: State<T>; retry: () => void; children: (data: T) => ReactNode
  /** Replaces «Повторить» where a retry cannot help: a missing page. */
  recovery?: ReactNode
  /** Mounted in every state, before and after the data: filters, action buttons and their result messages. */
  lead?: ReactNode; tail?: ReactNode
}) {
  const block = useLocalRequestFocus(state)
  return <section ref={block} className="ck-class-panel" aria-labelledby={id} aria-busy={state.kind === 'loading'}>
    <h2 id={id} tabIndex={-1} data-request-focus-target>{title}</h2>
    {lead}
    {state.kind === 'loading' && <RequestState kind="loading" message="Загружаем данные…" />}
    {state.kind === 'error' && (recovery
      ? <RequestState kind="empty" message={errorText(state.error)} action={recovery} />
      : <RequestState kind="error" message={errorText(state.error)} onRetry={retry} />)}
    {state.kind === 'ok' && <>
      {state.refreshError && <div className="ck-class-warning" role="status">
        <p>Не удалось обновить данные, показаны последние полученные. {errorText(state.refreshError)}</p>
        <button type="button" data-request-retry disabled={state.refreshing} onClick={retry}>Повторить обновление</button>
      </div>}
      {children(state.data)}
    </>}
    {tail}
  </section>
}
