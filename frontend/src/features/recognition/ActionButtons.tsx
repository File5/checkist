import type { Job } from '../../api/recognition'
import type { ActionState, JobAction } from './actions'

export default function ActionButtons({ job, state, run }: { job: Job; state: ActionState; run: (id: number, action: JobAction) => Promise<void> }) {
  const pending = state.kind === 'pending'
  const cancelled = state.kind === 'message' && state.id === job.id && state.cancelSubmitted
  const addressed = state.kind !== 'idle' && state.id === job.id
  return <div className="ck-rec-action-block">
    <div className="ck-rec-actions">
      <button type="button" disabled={!job.actions.can_cancel || pending || cancelled} onClick={() => { void run(job.id, 'cancel') }}>{addressed && pending && state.action === 'cancel' ? 'Запрашиваем отмену…' : 'Отменить'}</button>
      <button type="button" disabled={!job.actions.can_retry || pending} onClick={() => { void run(job.id, 'retry') }}>{addressed && pending && state.action === 'retry' ? 'Создаём задание…' : 'Повторить обработку'}</button>
    </div>
    <p role="status" aria-live="polite">{addressed && state.kind === 'message' ? state.message : ''}</p>
  </div>
}
