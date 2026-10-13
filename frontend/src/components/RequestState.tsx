import type { ReactNode } from 'react'
import Skeleton from './Skeleton'
import type { SkeletonShape } from './Skeleton'

export type RequestStateProps = (
  /** `shape` — what the skeleton looks like (components/Skeleton.tsx); `page` by default. */
  | { kind: 'loading'; message?: string; shape?: SkeletonShape }
  // message must be a local UI translation, never a server message/exception.
  | { kind: 'error'; title?: string; message?: string; onRetry: () => void; retryDisabled?: boolean; action?: ReactNode }
  | { kind: 'empty'; title?: string; message: string; action?: ReactNode }
) & {
  /** Inside a panel that is the card already: the words and the action without a card of their own. */
  compact?: boolean
}

/** Mount within the request's own block; loading draws a skeleton of the coming content in about its height (the
 * words stay for a screen reader only) — never a bare «Загружаем…» line.
 * An empty or failed state is a card: an optional short title, the words, and the action slot — «Повторить» of
 * an error first, then `action` (a link or a button: «Ещё нет трат в октябре» — «Добавить трату»). On a phone the
 * buttons and links of the slot take the whole width. */
export default function RequestState(props: RequestStateProps) {
  if (props.kind === 'loading') {
    const shape = props.shape ?? 'page'
    // «Главная» and «Траты» draw cards of their own: their skeleton stands on the page, not in one more card.
    const bare = !props.compact && shape !== 'page'
    return (
      <div className={`request-state request-state-loading${props.compact ? ' request-state-compact' : ''}${bare ? ' request-state-bare' : ''}`} aria-live="polite" aria-busy="true">
        <p className="ck-skel-message">{props.message ?? 'Загружаем данные…'}</p>
        <Skeleton shape={shape} compact={props.compact} />
      </div>
    )
  }
  const message = props.kind === 'error' ? props.message ?? 'Не удалось загрузить данные. Повторите попытку.' : props.message
  const retry = props.kind === 'error'
    && <button type="button" data-request-retry onClick={props.onRetry} disabled={props.retryDisabled}>Повторить</button>
  return (
    <div className={`request-state request-state-${props.kind}${props.compact ? ' request-state-compact' : ''}`} aria-live="polite" aria-busy={false}>
      {props.title && <p className="request-state-title"><strong>{props.title}</strong></p>}
      <p>{message}</p>
      {props.kind === 'error' && !props.action && retry}
      {props.action && <div className="request-state-action">{retry}{props.action}</div>}
    </div>
  )
}
