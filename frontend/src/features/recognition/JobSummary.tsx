import type { Job } from '../../api/recognition'
import { formatObservedAt } from '../../lib/format'
import { issueLabels, jobLabels, stageText } from './labels'

export default function JobSummary({ job, announce = false }: { job: Job; announce?: boolean }) {
  return <div className="ck-rec-summary">
    <p className={`ck-rec-status ck-rec-status-${job.status}`} aria-live={announce ? 'polite' : undefined} aria-atomic={announce ? true : undefined}>{jobLabels[job.status]} · {stageText(job)}</p>
    <dl className="ck-rec-facts">
      <div><dt>Найдено чеков</dt><dd>{job.progress.detected === null ? 'Ещё неизвестно' : job.progress.detected}</dd></div>
      <div><dt>Обработано</dt><dd>{job.progress.completed}</dd></div>
      <div><dt>Сохранено</dt><dd>{job.progress.imported}</dd></div>
      <div><dt>Переиспользовано</dt><dd>{job.progress.reused}</dd></div>
      <div><dt>Требуют проверки</dt><dd>{job.progress.review}</dd></div>
      <div><dt>Ошибок</dt><dd>{job.progress.failed}</dd></div>
      <div><dt>Отменено</dt><dd>{job.progress.cancelled}</dd></div>
    </dl>
    <p className="ck-rec-note">Счётчики исходов могут пересекаться: сохранённый чек тоже может требовать проверки.</p>
    <p>Создано: <time dateTime={job.created_at}>{formatObservedAt(job.created_at)}</time></p>
    {job.started_at && <p>Начато: <time dateTime={job.started_at}>{formatObservedAt(job.started_at)}</time></p>}
    {job.finished_at && <p>Завершено: <time dateTime={job.finished_at}>{formatObservedAt(job.finished_at)}</time></p>}
    {job.stalled && <p className="ck-rec-warning">Воркер давно не обновлял состояние. Задание может ожидать восстановления обработки.</p>}
    {job.error && <p className="ck-rec-error">Ошибка задания: {issueLabels[job.error.code]}</p>}
    {job.review_required && <p className="ck-rec-warning">Есть данные, требующие проверки. Посмотрите причины у вырезок.</p>}
  </div>
}
