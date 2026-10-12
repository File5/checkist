import type { ReactNode } from 'react'

export type RequestStateProps =
  | { kind: 'loading'; message?: string }
  // message must be a local UI translation, never a server message/exception.
  | { kind: 'error'; title?: string; message?: string; onRetry: () => void; retryDisabled?: boolean; action?: ReactNode }
  | { kind: 'empty'; title?: string; message: string; action?: ReactNode }

/** Mount within the request's own block; loading reserves space without a fixed height.
 * An empty or failed state is a card: an optional short title, the words, and the action slot — «Повторить» of
 * an error first, then `action` (a link or a button: «Ещё нет трат в октябре» — «Добавить трату»). On a phone the
 * buttons and links of the slot take the whole width. */
export default function RequestState(props: RequestStateProps) {
  const message = props.kind === 'loading' ? props.message ?? 'Загружаем данные…'
    : props.kind === 'error' ? props.message ?? 'Не удалось загрузить данные. Повторите попытку.'
      : props.message
  const title = props.kind === 'loading' ? undefined : props.title
  const retry = props.kind === 'error'
    && <button type="button" data-request-retry onClick={props.onRetry} disabled={props.retryDisabled}>Повторить</button>
  const action = props.kind === 'loading' ? undefined : props.action
  return (
    <div className={`request-state request-state-${props.kind}`} aria-live="polite" aria-busy={props.kind === 'loading'}>
      {title && <p className="request-state-title"><strong>{title}</strong></p>}
      <p>{message}</p>
      {props.kind === 'error' && !action && retry}
      {action && <div className="request-state-action">{retry}{action}</div>}
    </div>
  )
}
