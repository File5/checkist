import type { Job } from '../../api/recognition'
import type { ActionState, JobAction } from './actions'

export default function ActionButtons({ job, state, run, busy = false, onReview }: {
  job: Job; state: ActionState; run: (id: number, action: JobAction) => Promise<void>
  /** A crop confirmation is in flight: only one mutation of the job screen at a time. */
  busy?: boolean
  /** Leads to the crops that wait for a person. While the job needs review this is the main action:
   * a retry asks the model again and cannot add what the paper does not print. */
  onReview?: () => void
}) {
  const pending = state.kind === 'pending'
  const locked = pending || busy
  const cancelled = state.kind === 'message' && state.id === job.id && state.cancelSubmitted
  const addressed = state.kind !== 'idle' && state.id === job.id
  const review = job.review_required && onReview !== undefined
  return <div className="ck-rec-action-block">
    <div className="ck-rec-actions">
      {review && <button type="button" onClick={onReview}>Проверить и подтвердить</button>}
      <button type="button" className="ck-rec-cancel" disabled={!job.actions.can_cancel || locked || cancelled} onClick={() => { void run(job.id, 'cancel') }}>{addressed && pending && state.action === 'cancel' ? 'Запрашиваем отмену…' : 'Отменить'}</button>
      <button type="button" className={review ? 'ck-review-secondary' : undefined} disabled={!job.actions.can_retry || locked} onClick={() => { void run(job.id, 'retry') }}>{addressed && pending && state.action === 'retry' ? 'Создаём задание…' : 'Повторить обработку'}</button>
    </div>
    <p role="status" aria-live="polite">{addressed && state.kind === 'message' ? state.message : ''}</p>
  </div>
}
