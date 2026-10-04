import { useEffect, useId, useRef } from 'react'
import type { Page, Product } from '../../api/types'
import Pagination from '../../components/Pagination'
import RequestState from '../../components/RequestState'
import { Link } from '../../navigation'
import type { CatalogRoute } from '../../navigation'
import type { CatalogRequestState } from './catalog-request'
import { emptyProducts, resetFilters, withPage } from './catalog-state'
import CatalogError from './CatalogError'
import ProductList from './ProductList'

type Props = { state: CatalogRequestState<Page<Product>>; route: CatalogRoute; onRetry: () => void; childrenCount?: number }

export default function ProductsSection({ state, route, onRetry, childrenCount = 0 }: Props) {
  const id = useId()
  const heading = useRef<HTMLHeadingElement>(null)
  const previous = useRef(route)
  useEffect(() => {
    const before = previous.current
    // A page link disappears during loading. Give its keyboard focus a stable home.
    // Search/filter updates keep focus in the form; pathname focus belongs to F2.
    if (before.kind === route.kind && (before.kind !== 'category' || route.kind !== 'category' || before.categoryId === route.categoryId)
      && before.query.q === route.query.q && before.query.generic === route.query.generic && before.query.page !== route.query.page) {
      heading.current?.focus()
    }
    previous.current = route
  }, [route])

  return <section className="ck-catalog-results" aria-labelledby={id} aria-busy={state.kind === 'loading'}>
    <h2 id={id} ref={heading} tabIndex={-1}>{route.kind === 'category' ? 'Товары всей ветви' : route.query.q ? 'Результаты поиска' : 'Все товары'}</h2>
    <p className="ck-catalog-note ck-catalog-observation-note">Цены из чеков — последние покупки по стране и валюте. Это наблюдения, а не текущие цены магазина.</p>
    {state.kind === 'loading' && <RequestState kind="loading" message="Загружаем товары…" />}
    {state.kind === 'error' && <CatalogError error={state} route={route} onRetry={() => { heading.current?.focus(); onRetry() }} />}
    {state.kind === 'ok' && (state.data.results.length === 0
      ? <RequestState kind="empty" message={emptyProducts(route.query, route.kind === 'category', childrenCount)}
        action={route.query.q || route.query.generic !== undefined
          ? <Link className="action-link" to={resetFilters(route)}>Сбросить фильтры</Link> : undefined} />
      : <>
        <p className="ck-catalog-result-count" role="status">Найдено товаров: {state.data.count.toLocaleString('ru-RU')} · Страница {state.data.page.toLocaleString('ru-RU')} из {state.data.pages.toLocaleString('ru-RU')}</p>
        <ProductList products={state.data.results} />
        <Pagination page={state.data.page} pages={state.data.pages} buildPageHref={(page) => withPage(route, page)} label="Страницы товаров" />
      </>)}
  </section>
}
