import type { Ref } from 'react'
import type { ClassificationState } from '../../api/product-classifications'
import { focusOwnerAttribute } from '../../components/local-request-focus'
import type { RequestState as State } from '../recognition/polling'
import type { ActionState } from './actions'
import ClassificationBlock from './ClassificationBlock'
import { runText } from './labels'
import { canRequestRun } from './state'

const ownFocus = { [focusOwnerAttribute]: '' }

/** «Предложить категории»: unavailable without candidates, during an active run, any other action or with the local API off. */
export function RunButton({ state, action, unavailable, onRun }: {
  state: ClassificationState | undefined; action: ActionState; unavailable: boolean; onRun: () => void
}) {
  const busy = action.kind === 'pending'
  return <button type="button" disabled={busy || unavailable || !state || !canRequestRun(state)} onClick={onRun}>
    {busy && action.action.type === 'run' ? 'Ставим в очередь…' : 'Предложить категории'}
  </button>
}

/** Block «Предположение категорий»: counters, the run with the worker, the start button and its result. */
export default function StatePanel({ state, action, unavailable, onRun, onRetry, resultRef }: {
  state: State<ClassificationState>; action: ActionState; unavailable: boolean
  onRun: () => void; onRetry: () => void; resultRef?: Ref<HTMLParagraphElement>
}) {
  const data = state.kind === 'ok' ? state.data : undefined
  const own = action.kind !== 'idle' && action.kind !== 'pending' && action.action.type === 'run' ? action : undefined
  return <ClassificationBlock title="Предположение категорий" id="class-state-title" state={state} retry={onRetry}
    tail={<div className="ck-class-run-actions" {...ownFocus}>
      <div className="ck-class-actions">
        <RunButton state={data} action={action} unavailable={unavailable} onRun={onRun} />
        {data && data.unclassified_count === 0 && <span className="ck-class-note">Товаров без категории нет.</span>}
      </div>
      <p ref={resultRef} tabIndex={-1} role="status" aria-live="polite" className={own?.kind === 'failed' ? 'ck-class-error' : 'ck-class-result'}>
        {own ? own.message : ''}
      </p>
    </div>}>
    {(current) => {
      const run = runText(current)
      return <>
        <p className="ck-class-counters">Ожидают подтверждения: {current.pending_count.toLocaleString('ru-RU')}. Без категории: {current.unclassified_count.toLocaleString('ru-RU')}.</p>
        {run && <p className={run.warning ? 'ck-class-warning' : 'ck-class-run'} role="status" aria-live="polite">{run.text}</p>}
        {current.auto_suggest && <p className="ck-class-note">Автозапуск после импорта чека включён.</p>}
      </>
    }}
  </ClassificationBlock>
}
