import type { Job } from '../../api/recognition'
import type { ActionState, JobAction } from './actions'

export default function ActionButtons({ job, state, run, busy = false }: {
  job: Job; state: ActionState; run: (id: number, action: JobAction) => Promise<void>
  /** A crop confirmation is in flight: only one mutation of the job screen at a time. */
  busy?: boolean
}) {
  const pending = state.kind === 'pending'
  const locked = pending || busy
  const cancelled = state.kind === 'message' && state.id === job.id && state.cancelSubmitted
  const addressed = state.kind !== 'idle' && state.id === job.id
  return <div className="ck-rec-action-block">
    <div className="ck-rec-actions">
      <button type="button" disabled={!job.actions.can_cancel || locked || cancelled} onClick={() => { void run(job.id, 'cancel') }}>{addressed && pending && state.action === 'cancel' ? 'Запрашиваем отмену…' : 'Отменить'}</button>
      <button type="button" disabled={!job.actions.can_retry || locked} onClick={() => { void run(job.id, 'retry') }}>{addressed && pending && state.action === 'retry' ? 'Создаём задание…' : 'Повторить обработку'}</button>
    </div>
    <p role="status" aria-live="polite">{addressed && state.kind === 'message' ? state.message : ''}</p>
  </div>
}
