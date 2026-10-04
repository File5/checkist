import RequestState from '../../components/RequestState'
import { Link } from '../../navigation'
import type { NavigationTarget } from '../../navigation'
import type { ApiFailure } from '../../api/types'
import { errorMessage } from './state'

export default function ProductRequestState({ failure, retry, firstPage, reset }: {
  failure: ApiFailure; retry: () => void; firstPage?: NavigationTarget; reset?: () => void
}) {
  if (failure.reason === 'page_out_of_range' && firstPage) {
    return <RequestState kind="empty" message={errorMessage(failure)} action={<Link className="action-link" to={firstPage}>На первую страницу</Link>} />
  }
  if (failure.reason === 'not_found') {
    return <RequestState kind="empty" message={errorMessage(failure)} action={<Link className="action-link" to="/catalog">В каталог</Link>} />
  }
  if (failure.status === 400) {
    return <RequestState kind="empty" message={errorMessage(failure)} action={reset && <button type="button" onClick={reset}>Сбросить фильтры</button>} />
  }
  return <RequestState kind="error" message={errorMessage(failure)} onRetry={retry} />
}
