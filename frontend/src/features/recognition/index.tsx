import RequestState from '../../components/RequestState'
import { Link } from '../../navigation'
import type { JobPageProps, JobsPageProps } from '../../pages/types'

// I2 replaces this directory. Stable exports/props (from pages/types):
// UploadPage() (no props), JobsPage({query}: JobsPageProps),
// JobPage({jobId, returnTo?}: JobPageProps). App owns the single h1.
export function UploadPage() {
  return <RequestState kind="empty" message="Страница загрузки фото готовится. Загрузка через интерфейс пока недоступна." action={<Link to="/receipts">К чекам</Link>} />
}
export function JobsPage({ query }: JobsPageProps) {
  return <RequestState kind="empty" message={`Список обработки готовится. Страница ${query.page}.`} action={<Link to="/receipts/upload">Загрузка фото</Link>} />
}
export function JobPage({ jobId, returnTo }: JobPageProps) {
  return <RequestState kind="empty" message={`Страница задания №${jobId} готовится. Статус ещё не запрашивается.`} action={<Link to={returnTo ?? '/recognition/jobs'}>К обработке</Link>} />
}
