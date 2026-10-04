import type { ReactNode } from 'react'

export type RequestStateProps =
  | { kind: 'loading'; message?: string }
  // message must be a local UI translation, never a server message/exception.
  | { kind: 'error'; message?: string; onRetry: () => void; retryDisabled?: boolean }
  | { kind: 'empty'; message: string; action?: ReactNode }

/** Mount within the request's own block; loading reserves space without a fixed height. */
export default function RequestState(props: RequestStateProps) {
  const message = props.kind === 'loading' ? props.message ?? 'Загружаем данные…'
    : props.kind === 'error' ? props.message ?? 'Не удалось загрузить данные. Повторите попытку.'
      : props.message
  return (
    <div className={`request-state request-state-${props.kind}`} aria-live="polite" aria-busy={props.kind === 'loading'}>
      <p>{message}</p>
      {props.kind === 'error' && <button type="button" data-request-retry onClick={props.onRetry} disabled={props.retryDisabled}>Повторить</button>}
      {props.kind === 'empty' && props.action && <div className="request-state-action">{props.action}</div>}
    </div>
  )
}
