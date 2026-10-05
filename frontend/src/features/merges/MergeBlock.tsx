import type { ReactNode } from 'react'
import RequestState from '../../components/RequestState'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import type { RequestState as State } from '../recognition/polling'
import { errorText } from './labels'

/** One independent read of the merge API: heading, loading, refusal with retry, last data with a refresh warning. */
export default function MergeBlock<T>({ title, id, state, retry, children, recovery }: {
  title: string; id: string; state: State<T>; retry: () => void; children: (data: T) => ReactNode
  /** Replaces «Повторить» where a retry cannot help: a missing group or page. */
  recovery?: ReactNode
}) {
  const block = useLocalRequestFocus(state)
  return <section ref={block} className="ck-merge-panel" aria-labelledby={id} aria-busy={state.kind === 'loading'}>
    <h2 id={id} tabIndex={-1} data-request-focus-target>{title}</h2>
    {state.kind === 'loading' && <RequestState kind="loading" message="Загружаем данные…" />}
    {state.kind === 'error' && (recovery
      ? <RequestState kind="empty" message={errorText(state.error)} action={recovery} />
      : <RequestState kind="error" message={errorText(state.error)} onRetry={retry} />)}
    {state.kind === 'ok' && <>
      {state.refreshError && <div className="ck-merge-warning" role="status">
        <p>Не удалось обновить данные, показаны последние полученные. {errorText(state.refreshError)}</p>
        <button type="button" data-request-retry disabled={state.refreshing} onClick={retry}>Повторить обновление</button>
      </div>}
      {children(state.data)}
    </>}
  </section>
}
