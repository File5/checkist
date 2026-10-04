import type { ApiFailure } from '../../api/types'
import RequestState from '../../components/RequestState'
import { Link } from '../../navigation'
import type { CatalogRoute } from '../../navigation'
import { failureView, resetFilters, withPage } from './catalog-state'

export default function CatalogError({ error, route, onRetry }: { error: ApiFailure; route: CatalogRoute; onRetry: () => void }) {
  const view = failureView(error)
  if (view.kind === 'retry') return <RequestState kind="error" message={view.message} onRetry={onRetry} />
  const action = view.kind === 'missing' ? <Link className="action-link" to="/catalog">В каталог</Link>
    : view.kind === 'page' ? <Link className="action-link" to={withPage(route, 1)} replace>На первую страницу</Link>
      : <Link className="action-link" to={resetFilters(route)}>Сбросить фильтры</Link>
  return <RequestState kind="empty" message={view.message} action={action} />
}
