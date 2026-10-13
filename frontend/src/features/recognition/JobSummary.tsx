import type { Job } from '../../api/recognition'
import { formatObservedAt } from '../../lib/format'
import { issueLabels, jobLabels, stageText } from './labels'

/** `compact` — a row of the jobs list on a phone: the status pill, the date and the warnings; counters and the other
 * dates fold under «Счётчики и время». */
export default function JobSummary({ job, announce = false, compact = false }: { job: Job; announce?: boolean; compact?: boolean }) {
  const facts = <dl className="ck-rec-facts">
    <div><dt>Найдено чеков</dt><dd>{job.progress.detected === null ? 'Ещё неизвестно' : job.progress.detected}</dd></div>
    <div><dt>Обработано</dt><dd>{job.progress.completed}</dd></div>
    <div><dt>Сохранено</dt><dd>{job.progress.imported}</dd></div>
    <div><dt>Переиспользовано</dt><dd>{job.progress.reused}</dd></div>
    <div><dt>Требуют проверки</dt><dd>{job.progress.review}</dd></div>
    <div><dt>Ошибок</dt><dd>{job.progress.failed}</dd></div>
    <div><dt>Отменено</dt><dd>{job.progress.cancelled}</dd></div>
  </dl>
  const note = <p className="ck-rec-note">Счётчики исходов могут пересекаться: сохранённый чек тоже может требовать проверки. После подтверждения вырезки человеком счётчики и статус задания пересчитываются.</p>
  const created = <p>Создано: <time dateTime={job.created_at}>{formatObservedAt(job.created_at)}</time></p>
  const times = <>
    {job.started_at && <p>Начато: <time dateTime={job.started_at}>{formatObservedAt(job.started_at)}</time></p>}
    {job.finished_at && <p>Завершено: <time dateTime={job.finished_at}>{formatObservedAt(job.finished_at)}</time></p>}
  </>
  const warnings = <>
    {job.stalled && <p className="ck-rec-warning">Воркер давно не обновлял состояние. Задание может ожидать восстановления обработки.</p>}
    {job.error && <p className="ck-rec-error">Ошибка задания: {issueLabels[job.error.code]}</p>}
    {job.review_required && <p className="ck-rec-warning">Есть данные, требующие проверки. Посмотрите причины у вырезок.</p>}
  </>
  return <div className={`ck-rec-summary${compact ? ' ck-rec-summary-compact' : ''}`}>
    <p className={`ck-rec-status ck-rec-status-${job.status}${compact ? ' ck-rec-pill' : ''}`} aria-live={announce ? 'polite' : undefined} aria-atomic={announce ? true : undefined}>{jobLabels[job.status]} · {stageText(job)}</p>
    {compact
      ? <>{created}{warnings}<details className="ck-rec-more"><summary>Счётчики и время</summary>{facts}{note}{times}</details></>
      : <>{facts}{note}{created}{times}{warnings}</>}
  </div>
}
