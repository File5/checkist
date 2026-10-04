import type { CatalogQuery, HistoryQuery } from '../navigation'

/** The shell owns the page's single h1. Feature screens render below it. */
export interface CatalogPageProps {
  query: CatalogQuery
}

export interface CategoryPageProps {
  categoryId: number
  query: CatalogQuery
}

export interface ProductPageProps {
  productId: number
  query: HistoryQuery
  /** Known list URL. For direct entry use the product's category after loading it. */
  returnTo?: string
}
