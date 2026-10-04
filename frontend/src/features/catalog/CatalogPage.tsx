import { useCallback, useRef } from 'react'
import { getCategories, getProducts } from '../../api/catalog'
import RequestState from '../../components/RequestState'
import type { CatalogPageProps } from '../../pages/types'
import type { CatalogRoute } from '../../navigation'
import { productsParams } from './catalog-state'
import { useCatalogRequest } from './use-catalog-request'
import CatalogError from './CatalogError'
import CatalogSearch from './CatalogSearch'
import { CategoryLinks } from './CategoryLinks'
import ProductsSection from './ProductsSection'
import './Catalog.css'

export function CatalogPage({ query }: CatalogPageProps) {
  const { q, generic, page } = query
  const route: CatalogRoute = { kind: 'catalog', query }
  const loadCategories = useCallback((signal: AbortSignal) => getCategories({}, { signal }), [])
  const loadProducts = useCallback((signal: AbortSignal) => getProducts(productsParams({ q, generic, page }), { signal }), [q, generic, page])
  const categories = useCatalogRequest(loadCategories)
  const products = useCatalogRequest(loadProducts)
  const categoriesHeading = useRef<HTMLHeadingElement>(null)
  return <div className="ck-catalog">
    <CatalogSearch route={route} error={products.state.kind === 'error' ? products.state : undefined} />
    <section aria-labelledby="ck-catalog-categories-heading">
      <h2 id="ck-catalog-categories-heading" ref={categoriesHeading} tabIndex={-1}>Категории</h2>
      {categories.state.kind === 'loading' && <RequestState kind="loading" message="Загружаем категории…" />}
      {categories.state.kind === 'error' && <CatalogError error={categories.state} route={route} onRetry={() => { categoriesHeading.current?.focus(); categories.retry() }} />}
      {categories.state.kind === 'ok' && (categories.state.data.results.length === 0
        ? <RequestState kind="empty" message="Категорий пока нет." />
        : <div className="ck-catalog-panel"><CategoryLinks categories={categories.state.data.results} /></div>)}
    </section>
    <ProductsSection state={products.state} route={route} onRetry={products.retry} />
  </div>
}

export default CatalogPage
