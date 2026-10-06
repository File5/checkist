import type { CatalogQuery, JobsQuery, MergesQuery, ProductQuery, ReceiptsQuery, ReceiptsStatsQuery, SpendingQuery } from '../navigation'

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
  /** History filters plus `price`/`interval` of the price chart (absent means `paid`/`month`). */
  query: ProductQuery
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

/**
 * Statistics screens. The query is already normalized: wrong values are dropped, defaults are absent
 * (`group_by` — `category`, `interval` — `month`). Change filters with `spendingHref`/`receiptsStatsHref`.
 */
export interface SpendingPageProps { query: SpendingQuery }
export interface ReceiptsStatsPageProps { query: ReceiptsStatsQuery }
