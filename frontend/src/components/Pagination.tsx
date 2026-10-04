import { Link } from '../navigation'
import type { NavigationTarget } from '../navigation'
import { paginationItems } from './pagination-items'

export interface PaginationProps {
  page: number
  pages: number
  /** Keep current filters; change only query.page. May return a route or an href. */
  buildPageHref: (page: number) => NavigationTarget
  label?: string
}

export default function Pagination({ page, pages, buildPageHref, label = 'Страницы результатов' }: PaginationProps) {
  const items = paginationItems(page, pages)
  if (items.length === 0) return null
  return (
    <nav className="pagination" aria-label={label}>
      <ul>
        {page > 1 && <li><Link to={buildPageHref(page - 1)} rel="prev">Предыдущая</Link></li>}
        {items.map((item) => (
          <li key={item}>
            {typeof item === 'number'
              ? <Link to={buildPageHref(item)} aria-label={`Страница ${item.toLocaleString('ru-RU')}`} aria-current={item === page ? 'page' : undefined}>{item.toLocaleString('ru-RU')}</Link>
              : <span aria-hidden="true">…</span>}
          </li>
        ))}
        {page < pages && <li><Link to={buildPageHref(page + 1)} rel="next">Следующая</Link></li>}
      </ul>
    </nav>
  )
}
