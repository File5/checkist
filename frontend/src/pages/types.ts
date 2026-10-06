import type { CatalogQuery, ClassificationQuery, HistoryQuery, JobsQuery, MergesQuery, ReceiptsQuery } from '../navigation'

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

/** Product merge screens of the catalog section; `returnTo` is the group list with its filter. */
export interface MergesPageProps { query: MergesQuery }
export interface MergePageProps { groupId: number; returnTo?: string }

/** Category suggestions of the catalog section: the filter, one product and the page live in the URL. */
export interface ClassificationPageProps { query: ClassificationQuery }
