import { useCallback } from 'react'
import { getCategory, getProducts } from '../../api/catalog'
import RequestState from '../../components/RequestState'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
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
  const categoryBlock = useLocalRequestFocus(category.state)
  const node = category.state.kind === 'ok' ? category.state.data : undefined
  return <div className="ck-catalog">
    {node && <CategoryBreadcrumbs path={node.path} />}
    <section ref={categoryBlock} className="ck-catalog-category" aria-labelledby="ck-catalog-category-heading" aria-busy={category.state.kind === 'loading'}>
      <h2 id="ck-catalog-category-heading" data-request-focus-target tabIndex={-1}>{node?.name ?? 'Категория'}</h2>
      {category.state.kind === 'loading' && <RequestState kind="loading" message="Загружаем категорию…" />}
      {category.state.kind === 'error' && <CatalogError error={category.state} route={route} onRetry={category.retry} />}
      {node && <p className="ck-catalog-note">Товаров в этой ветви: {node.products_total.toLocaleString('ru-RU')}</p>}
    </section>
    {node && <>
      {node.children.length > 0 && <section aria-labelledby="ck-catalog-subcategories-heading">
        <h2 id="ck-catalog-subcategories-heading">Подкатегории</h2>
        <div className="ck-catalog-panel"><CategoryLinks categories={node.children} /></div>
      </section>}
      <CatalogSearch route={route} generics={node.generic_products} error={products.state.kind === 'error' ? products.state : undefined} />
      <ProductsSection state={products.state} route={route} onRetry={products.retry} childrenCount={node.children.length} />
    </>}
  </div>
}

export default CategoryPage
