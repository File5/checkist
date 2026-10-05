import { useCallback, useEffect, useMemo, useRef } from 'react'
import { getJob, getPhoto, getReceiptImages } from '../../api/recognition'
import type { JobDetail } from '../../api/recognition'
import { Link, navigate } from '../../navigation'
import type { JobPageProps } from '../../pages/types'
import ActionButtons from './ActionButtons'
import JobSummary from './JobSummary'
import MediaImage from './MediaImage'
import ReceiptImages from './ReceiptImages'
import RequestBlock from './RequestBlock'
import { acceptJob, executorWarning, isActive } from './labels'
import { getJobNotice, setJobNotice } from './upload-state'
import { useJobActions } from './useJobActions'
import { useRequest } from './useRequest'

function JobImages({ job }: { job: JobDetail }) {
  const photoLoad = useCallback((signal: AbortSignal) => getPhoto(job.photo_id, { signal }), [job.photo_id])
  const imagesLoad = useCallback((signal: AbortSignal) => getReceiptImages({ job: job.id, page_size: 10, ordering: 'created_at' }, { signal }), [job.id])
  const photo = useRequest(photoLoad)
  const images = useRequest(imagesLoad)
  const imageKey = `${job.version}:${job.items.map((item) => `${item.image_id}:${item.status}:${item.receipt_id}`).join(',')}`
  const lastImageKey = useRef(imageKey)
  const lastStage = useRef(job.stage)
  useEffect(() => {
    if (lastImageKey.current === imageKey) return
    lastImageKey.current = imageKey
    images.request.queueRefresh()
  }, [imageKey, images.request])
  useEffect(() => {
    if (lastStage.current === job.stage) return
    lastStage.current = job.stage
    photo.request.queueRefresh()
  }, [job.stage, photo.request])
  return <>
    <RequestBlock title="Исходное фото" id="recognition-photo-title" state={photo.state} retry={photo.request.refresh}>
      {(data) => <><MediaImage url={data.preview_url ?? data.original_url} alt={`Исходное фото №${data.id}`} /><p>{data.width} × {data.height} пикселей · {data.content_type.replace('image/', '').toUpperCase()}</p></>}
    </RequestBlock>
    <RequestBlock title={`Вырезки чеков (${job.items_count})`} id="recognition-images-title" state={images.state} retry={images.request.refresh}>
      {(data) => <ReceiptImages images={data.results} finished={!isActive(job)} />}
    </RequestBlock>
  </>
}

export default function JobPage({ jobId, returnTo }: JobPageProps) {
  const load = useCallback((signal: AbortSignal) => getJob(jobId, { signal }), [jobId])
  const { state, request } = useRequest(load, isActive, acceptJob)
  const lifecycle = useMemo(() => ({ pause: request.pause, resume: request.resume, success: (job: JobDetail, action: string) => {
    if (action === 'cancel') request.setData(job)
    else { setJobNotice(job.id, `Создано новое задание обработки.${!job.executor.available ? ` ${executorWarning}` : ''}`); navigate({ kind: 'job', jobId: job.id }) }
  } }), [request])
  const actions = useJobActions(lifecycle)
  const notice = getJobNotice(jobId)
  return <div className="ck-rec">
    <div className="ck-rec-actions"><Link className="action-link" to={returnTo ?? '/recognition/jobs'}>{returnTo?.startsWith('/receipts/') ? 'К чеку' : 'К обработке'}</Link><Link className="action-link" to="/receipts/upload">Загрузить другое фото</Link></div>
    {notice && <p role="status" className="ck-rec-warning">{notice}</p>}
    <RequestBlock title={`Задание №${jobId}`} id="recognition-job-title" state={state} retry={request.refresh}>
      {(job) => <>
        <JobSummary job={job} announce />
        {job.retry_of !== null && <p>Повтор <Link to={{ kind: 'job', jobId: job.retry_of }}>задания №{job.retry_of}</Link>.</p>}
        {!job.executor.available && job.status === 'queued' && <p className="ck-rec-warning">{executorWarning}</p>}
        {job.status === 'cancel_requested' && <p>Ждём подтверждения отмены от воркера. Уже сохранённые чеки не удаляются.</p>}
        <ActionButtons job={job} state={actions.state} run={actions.run} />
        <Link to={{ kind: 'jobs', query: { page: 1, photo: job.photo_id } }}>Все задания этого фото</Link>
      </>}
    </RequestBlock>
    {state.kind === 'ok' && <JobImages key={jobId} job={state.data} />}
  </div>
}
