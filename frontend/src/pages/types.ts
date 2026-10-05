import type { CatalogQuery, HistoryQuery, JobsQuery, ReceiptsQuery } from '../navigation'

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

/** Shell provides h1 and pathname focus; feature pages own local requests/focus. */
export interface JobsPageProps { query: JobsQuery }
export interface JobPageProps { jobId: number; returnTo?: string }
export interface ReceiptsPageProps { query: ReceiptsQuery }
export interface ReceiptPageProps { receiptId: number; returnTo?: string }
