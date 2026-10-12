import { useCallback, useMemo } from 'react'
import type { ChangeEvent } from 'react'
import { getJobs } from '../../api/recognition'
import { jobStatuses } from '../../api/recognition-types'
import type { Job } from '../../api/recognition'
import type { Page } from '../../api/types'
import Pagination from '../../components/Pagination'
import RequestState from '../../components/RequestState'
import { numbered } from '../../lib/text'
import { Link, navigate } from '../../navigation'
import type { JobsPageProps } from '../../pages/types'
import { useNarrow } from '../../lib/cards'
import ActionButtons from './ActionButtons'
import JobSummary from './JobSummary'
import JobThumb from './JobThumb'
import { ResponsiveFilters } from './_tmp-foundation'
import { jobsFilterCount } from './mobile-state'
import RequestBlock from './RequestBlock'
import { isActive, jobLabels } from './labels'
import { useJobActions } from './useJobActions'
import { useRequest } from './useRequest'
const hasActive = (page: Page<Job>) => page.results.some(isActive)

export default function JobsPage({ query }: JobsPageProps) {
  const { page, page_size, status, photo, ordering, needs_review } = query
  const load = useCallback((signal: AbortSignal) => getJobs({ page, page_size, status, photo, ordering, needs_review }, { signal }), [page, page_size, status, photo, ordering, needs_review])
  const { state, request } = useRequest(load, hasActive)
  const lifecycle = useMemo(() => ({ pause: request.pause, resume: () => request.resume(), success: (job: Job, action: string) => { if (action === 'retry') navigate({ kind: 'job', jobId: job.id }) } }), [request])
  const actions = useJobActions(lifecycle)
  // A phone: rows with the miniature of the photo and a short summary, the status filter behind «Фильтры (N)».
  const narrow = useNarrow()
  const changeStatus = (event: ChangeEvent<HTMLSelectElement>) => navigate({ kind: 'jobs', query: { ...query, page: 1, status: (event.target.value || undefined) as typeof query.status } })
  return <div className="ck-rec">
    <div className="ck-rec-actions"><Link className="action-link" to="/receipts/upload">Загрузить фото</Link><Link className="action-link" to="/receipts">К чекам</Link></div>
    <div className="ck-rec-panel">
      <ResponsiveFilters count={jobsFilterCount(query)} title="Фильтры заданий">
        <label htmlFor="recognition-status-filter">Статус обработки</label>
        <select id="recognition-status-filter" value={status ?? ''} onChange={changeStatus}><option value="">Все статусы</option>{jobStatuses.map((item) => <option value={item} key={item}>{jobLabels[item]}</option>)}</select>
      </ResponsiveFilters>
      {photo && <p>Задания <span className="ck-rec-pair">{numbered('фото', photo)}</span>. <Link to={{ kind: 'jobs', query: { ...query, page: 1, photo: undefined } }}>Все фото</Link></p>}
      {needs_review && <p>Только задания, где есть что подтвердить. <Link to={{ kind: 'jobs', query: { ...query, page: 1, needs_review: undefined } }}>Все задания</Link></p>}
    </div>
    <RequestBlock title={`Задания · Страница ${query.page}`} id="recognition-jobs-title" state={state} retry={request.refresh} errorAction={state.kind === 'error' && state.error.reason === 'page_out_of_range' ? <Link to={{ kind: 'jobs', query: { ...query, page: 1 } }}>На первую страницу</Link> : undefined}>
      {(data) => <>
        <p>Всего заданий: {data.count.toLocaleString('ru-RU')}. Страница {data.page} из {data.pages || 1}.</p>
        <p className="ck-rec-note">Активные задания на этой странице обновляются автоматически.</p>
        {data.results.length === 0 ? <RequestState kind="empty" message={status || photo || needs_review ? 'По выбранным фильтрам заданий нет.' : 'Фото ещё не загружались.'} action={status || photo || needs_review ? <Link to={{ kind: 'jobs', query: { page: 1 } }}>Сбросить фильтры</Link> : <Link to="/receipts/upload">Загрузить фото</Link>} />
          : <ul className="ck-rec-list">{data.results.map((job) => <li key={job.id} className={`ck-rec-card${narrow ? ' ck-rec-job-row' : ''}`}>
            {narrow ? <div className="ck-rec-job-head">
              <JobThumb photoId={job.photo_id} />
              <div className="ck-rec-job-title">
                <h3><Link to={{ kind: 'job', jobId: job.id }}>{numbered('Задание', job.id)}</Link></h3>
                <p><span className="ck-rec-pair">{numbered('Фото', job.photo_id)}</span>{job.retry_of !== null && <> · повтор <span className="ck-rec-pair">{numbered('задания', job.retry_of)}</span></>}</p>
              </div>
            </div> : <>
              <h3><Link to={{ kind: 'job', jobId: job.id }}>{numbered('Задание', job.id)}</Link></h3>
              <p><span className="ck-rec-pair">{numbered('Фото', job.photo_id)}</span>{job.retry_of !== null && <> · повтор <span className="ck-rec-pair">{numbered('задания', job.retry_of)}</span></>}</p>
            </>}
            <JobSummary job={job} announce compact={narrow} />
            <ActionButtons job={job} state={actions.state} run={actions.run} onReview={() => navigate({ kind: 'job', jobId: job.id })} />
          </li>)}</ul>}
        <Pagination page={data.page} pages={data.pages} buildPageHref={(nextPage) => ({ kind: 'jobs', query: { ...query, page: nextPage } })} label="Страницы заданий" />
      </>}
    </RequestBlock>
  </div>
}
