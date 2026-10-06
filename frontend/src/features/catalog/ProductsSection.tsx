import { useId } from 'react'
import type { Page, Product } from '../../api/types'
import Pagination from '../../components/Pagination'
import RequestState from '../../components/RequestState'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import { Link } from '../../navigation'
import type { CatalogRoute } from '../../navigation'
import type { CatalogRequestState } from './catalog-request'
import { emptyProducts, resetFilters, withPage } from './catalog-state'
import CatalogError from './CatalogError'
import ProductList from './ProductList'
import { usePendingMergeMarks } from '../merges/marks'

type Props = { state: CatalogRequestState<Page<Product>>; route: CatalogRoute; onRetry: () => void; childrenCount?: number }

export default function ProductsSection({ state, route, onRetry, childrenCount = 0 }: Props) {
  const id = useId()
  const block = useLocalRequestFocus(state)
  // An independent request: its refusal leaves the list as it is, only without marks.
  const merges = usePendingMergeMarks()

  return <section ref={block} className="ck-catalog-results" aria-labelledby={id} aria-busy={state.kind === 'loading'}>
    <h2 id={id} data-request-focus-target tabIndex={-1}>{route.kind === 'category' ? 'Товары всей ветви' : route.query.q ? 'Результаты поиска' : 'Все товары'}</h2>
    <p className="ck-catalog-note ck-catalog-observation-note">Цены из чеков — последние покупки по стране и валюте. Это наблюдения, а не текущие цены магазина.</p>
    {state.kind === 'loading' && <RequestState kind="loading" message="Загружаем товары…" />}
    {state.kind === 'error' && <CatalogError error={state} route={route} onRetry={onRetry} />}
    {state.kind === 'ok' && (state.data.results.length === 0
      ? <RequestState kind="empty" message={emptyProducts(route.query, route.kind === 'category', childrenCount)}
        action={route.query.q || route.query.generic !== undefined
          ? <Link className="action-link" to={resetFilters(route)}>Сбросить фильтры</Link> : undefined} />
      : <>
        <p className="ck-catalog-result-count" role="status">Найдено товаров: {state.data.count.toLocaleString('ru-RU')} · Страница {state.data.page.toLocaleString('ru-RU')} из {state.data.pages.toLocaleString('ru-RU')}</p>
        <ProductList products={state.data.results} merges={merges} />
        <Pagination page={state.data.page} pages={state.data.pages} buildPageHref={(page) => withPage(route, page)} label="Страницы товаров" />
      </>)}
  </section>
}
