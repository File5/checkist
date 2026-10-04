import { useCallback, useRef } from 'react'
import { getCategory, getProducts } from '../../api/catalog'
import RequestState from '../../components/RequestState'
import type { CategoryPageProps } from '../../pages/types'
import type { CatalogRoute } from '../../navigation'
import { productsParams } from './catalog-state'
import { useCatalogRequest } from './use-catalog-request'
import CatalogError from './CatalogError'
import CatalogSearch from './CatalogSearch'
import { CategoryBreadcrumbs, CategoryLinks } from './CategoryLinks'
import ProductsSection from './ProductsSection'
import './Catalog.css'

export function CategoryPage({ categoryId, query }: CategoryPageProps) {
  const { q, generic, page } = query
  const route: CatalogRoute = { kind: 'category', categoryId, query }
  const loadCategory = useCallback((signal: AbortSignal) => getCategory(categoryId, { signal }), [categoryId])
  const loadProducts = useCallback((signal: AbortSignal) => getProducts(productsParams({ q, generic, page }, categoryId), { signal }), [categoryId, q, generic, page])
  const category = useCatalogRequest(loadCategory)
  const products = useCatalogRequest(loadProducts)
  const container = useRef<HTMLDivElement>(null)
  if (category.state.kind === 'loading') return <div className="ck-catalog" ref={container} tabIndex={-1} role="group" aria-label="Категория"><RequestState kind="loading" message="Загружаем категорию…" /></div>
  if (category.state.kind === 'error') return <div className="ck-catalog" ref={container} tabIndex={-1} role="group" aria-label="Категория"><CatalogError error={category.state} route={route} onRetry={() => { container.current?.focus(); category.retry() }} /></div>
  const node = category.state.data
  return <div className="ck-catalog" ref={container} tabIndex={-1} role="group" aria-label="Категория">
    <CategoryBreadcrumbs path={node.path} />
    <section className="ck-catalog-category" aria-labelledby="ck-catalog-category-heading">
      <h2 id="ck-catalog-category-heading">{node.name}</h2>
      <p className="ck-catalog-note">Товаров в этой ветви: {node.products_total.toLocaleString('ru-RU')}</p>
    </section>
    {node.children.length > 0 && <section aria-labelledby="ck-catalog-subcategories-heading">
      <h2 id="ck-catalog-subcategories-heading">Подкатегории</h2>
      <div className="ck-catalog-panel"><CategoryLinks categories={node.children} /></div>
    </section>}
    <CatalogSearch route={route} generics={node.generic_products} error={products.state.kind === 'error' ? products.state : undefined} />
    <ProductsSection state={products.state} route={route} onRetry={products.retry} childrenCount={node.children.length} />
  </div>
}

export default CategoryPage
