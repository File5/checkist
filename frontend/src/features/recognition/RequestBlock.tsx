import type { ReactNode } from 'react'
import RequestState from '../../components/RequestState'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import { errorText } from './labels'
import type { RequestState as State } from './polling'

export default function RequestBlock<T>({ title, id, state, retry, children, errorAction }: {
  title: string; id: string; state: State<T>; retry: () => void; children: (data: T) => ReactNode; errorAction?: ReactNode
}) {
  const block = useLocalRequestFocus(state)
  return <section ref={block} className="ck-rec-panel" aria-labelledby={id} aria-busy={state.kind === 'loading'}>
    <h2 id={id} tabIndex={-1} data-request-focus-target>{title}</h2>
    {state.kind === 'loading' && <RequestState kind="loading" message="Загружаем данные…" />}
    {state.kind === 'error' && <><RequestState kind="error" message={errorText(state.error)} onRetry={retry} />{errorAction}</>}
    {state.kind === 'ok' && <>
      {state.refreshError && <div className="ck-rec-warning" role="status"><p>Не удалось обновить. Показаны последние полученные данные. {errorText(state.refreshError)}</p><button type="button" data-request-retry disabled={state.refreshing} onClick={retry}>Повторить обновление</button></div>}
      {children(state.data)}
    </>}
  </section>
}
