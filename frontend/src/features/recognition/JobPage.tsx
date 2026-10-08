import { useCallback, useEffect, useMemo, useRef } from 'react'
import { getJob, getPhoto, getReceiptImages } from '../../api/recognition'
import type { JobDetail, ReviewConfirmResult } from '../../api/recognition'
import type { LocalApiFailure } from '../../api/types'
import { glue, numbered } from '../../lib/text'
import { Link, navigate } from '../../navigation'
import type { JobPageProps } from '../../pages/types'
import ActionButtons from './ActionButtons'
import JobSummary from './JobSummary'
import MediaImage from './MediaImage'
import ReceiptImages from './ReceiptImages'
import RequestBlock from './RequestBlock'
import { acceptJob, isActive, jobExecutorNote } from './labels'
import { getJobNotice, retryNotice, setJobNotice } from './upload-state'
import { useJobActions } from './useJobActions'
import { useReviewActions } from './useReviewActions'
import type { ReviewControl } from './useReviewActions'
import { useRequest } from './useRequest'

/** Reads of the crop list that a confirmation pauses and restarts. */
type ImagesControl = { pause: () => void; resume: (immediate?: boolean) => void; confirmed: (job: JobDetail) => void }
const imageKeyOf = (job: JobDetail) => `${job.version}:${job.items.map((item) => `${item.image_id}:${item.status}:${item.receipt_id}`).join(',')}`

function JobImages({ job, busy, review, register }: { job: JobDetail; busy: boolean; review: ReviewControl; register: (control: ImagesControl | null) => void }) {
  const photoLoad = useCallback((signal: AbortSignal) => getPhoto(job.photo_id, { signal }), [job.photo_id])
  const imagesLoad = useCallback((signal: AbortSignal) => getReceiptImages({ job: job.id, page_size: 10, ordering: 'created_at' }, { signal }), [job.id])
  const photo = useRequest(photoLoad)
  const images = useRequest(imagesLoad)
  const imageKey = imageKeyOf(job)
  const lastImageKey = useRef(imageKey)
  const lastStage = useRef(job.stage)
  useEffect(() => {
    if (lastImageKey.current === imageKey) return
    lastImageKey.current = imageKey
    images.request.queueRefresh()
  }, [imageKey, images.request])
  useEffect(() => {
    register({
      pause: images.request.pause, resume: images.request.resume,
      // The answer already carries the new job: one read of the crops, not a second one for the changed key.
      confirmed: (next) => { lastImageKey.current = imageKeyOf(next); images.request.resume(true) },
    })
    return () => register(null)
  }, [register, images.request])
  useEffect(() => {
    if (lastStage.current === job.stage) return
    lastStage.current = job.stage
    photo.request.queueRefresh()
  }, [job.stage, photo.request])
  return <>
    <RequestBlock title="Исходное фото" id="recognition-photo-title" state={photo.state} retry={photo.request.refresh}>
      {(data) => <><MediaImage url={data.preview_url ?? data.original_url} alt={`Исходное фото №${data.id}`} /><p><span className="ck-rec-pair">{glue(data.width, '×', data.height, 'пикселей')}</span> · {data.content_type.replace('image/', '').toUpperCase()}</p></>}
    </RequestBlock>
    <RequestBlock title={`Вырезки чеков (${job.items_count})`} id="recognition-images-title" state={images.state} retry={images.request.refresh}>
      {(data) => <ReceiptImages images={data.results} finished={!isActive(job)} busy={busy} review={review} />}
    </RequestBlock>
  </>
}

export default function JobPage({ jobId, returnTo }: JobPageProps) {
  const load = useCallback((signal: AbortSignal) => getJob(jobId, { signal }), [jobId])
  const { state, request } = useRequest(load, isActive, acceptJob)
  const lifecycle = useMemo(() => ({ pause: request.pause, resume: request.resume, success: (job: JobDetail, action: string) => {
    if (action === 'cancel') request.setData(job)
    else { setJobNotice(job.id, retryNotice); navigate({ kind: 'job', jobId: job.id }) }
  } }), [request])
  const actions = useJobActions(lifecycle)
  const imagesControl = useRef<ImagesControl | null>(null)
  const registerImages = useCallback((control: ImagesControl | null) => { imagesControl.current = control }, [])
  // A confirmation pauses both reads; its answer replaces the job, a refusal that may hide a saved receipt reads both again.
  // After any other refusal resume(false) still makes a read that the pause cancelled: the list read of an earlier success.
  const reviewLifecycle = useMemo(() => ({
    pause: () => { request.pause(); imagesControl.current?.pause() },
    success: (result: ReviewConfirmResult) => { request.setData(result.job); request.resume(false); imagesControl.current?.confirmed(result.job) },
    failure: (_error: LocalApiFailure, reread: boolean) => { request.resume(reread); imagesControl.current?.resume(reread) },
  }), [request])
  const review = useReviewActions(reviewLifecycle)
  const notice = getJobNotice(jobId)
  return <div className="ck-rec">
    <div className="ck-rec-actions"><Link className="action-link" to={returnTo ?? '/recognition/jobs'}>{returnTo?.startsWith('/receipts/') ? 'К чеку' : 'К обработке'}</Link><Link className="action-link" to="/receipts/upload">Загрузить другое фото</Link></div>
    {notice && <p role="status" className="ck-rec-warning">{notice}</p>}
    <RequestBlock title={<span className="ck-rec-pair">Задание №{jobId}</span>} id="recognition-job-title" state={state} retry={request.refresh}>
      {(job) => { const executorNote = state.kind === 'ok' && !state.refreshError ? jobExecutorNote(job) : undefined; return <>
        <JobSummary job={job} announce />
        {job.retry_of !== null && <p>Повтор <Link to={{ kind: 'job', jobId: job.retry_of }} className="ck-rec-pair">{numbered('задания', job.retry_of)}</Link>.</p>}
        {executorNote && <p className={executorNote.warning ? 'ck-rec-warning' : undefined}>{executorNote.text}</p>}
        {job.status === 'cancel_requested' && <p>Ждём подтверждения отмены от воркера. Уже сохранённые чеки не удаляются.</p>}
        <ActionButtons job={job} state={actions.state} run={actions.run} busy={review.state.kind === 'pending'} />
        <Link to={{ kind: 'jobs', query: { page: 1, photo: job.photo_id } }}>Все задания этого фото</Link>
      </> }}
    </RequestBlock>
    {state.kind === 'ok' && <JobImages key={jobId} job={state.data} busy={actions.state.kind === 'pending'} review={review} register={registerImages} />}
  </div>
}
