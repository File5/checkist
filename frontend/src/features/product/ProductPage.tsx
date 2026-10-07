import { useCallback, useRef, useState } from 'react'
import { getProduct } from '../../api/catalog'
import { getProductPrices, getProductPriceSummary } from '../../api/prices'
import type { ApiFailure, ApiResult, PriceSummary as SummaryData, ProductDetail, Store, StoreBrief } from '../../api/types'
import type { ProductPageProps } from '../../pages/types'
import { buildHistoryQuery, Link, navigate } from '../../navigation'
import type { HistoryQuery } from '../../navigation'
import RequestState from '../../components/RequestState'
import { useLocalRequestFocus } from '../../components/useLocalRequestFocus'
import { formatQuantity } from '../../lib/format'
import PriceHistory from './PriceHistory'
import PriceSummary from './PriceSummary'
import StoreFilter from './StoreFilter'
import ProductRequestState from './ProductRequestState'
import { filterDraft, filterOptions, historyParams, mergeStores, serverFieldErrors, summaryParams, validateFilters } from './state'
import type { FieldErrors, FilterField } from './state'
import { useProductRequest } from './useProductRequest'
import { MergedProductHint, ProductMergeNotice } from '../merges/MergeMarks'
import { useProductMergeLookup } from '../merges/marks'
import { ProductClassificationNotice } from '../classification/ClassificationMarks'
import { markFor, useProductClassificationMarks } from '../classification/marks'
import './Product.css'

function FilterForm({ query, product, stores, selectedStore, failures, apply, reset, onStores }: {
  query: HistoryQuery; product?: ProductDetail; stores: Store[]; selectedStore?: StoreBrief; failures: ApiFailure[]
  apply: (query: HistoryQuery) => void; reset: () => void; onStores: (stores: Store[]) => void
}) {
  const source = buildHistoryQuery({ ...query, page: 1 })
  const [form, setForm] = useState({ source, draft: filterDraft(query), errors: {} as FieldErrors })
  // Reconcile Back/Forward and external URL changes without remounting focused form controls.
  if (form.source !== source) setForm({ source, draft: filterDraft(query), errors: {} })
  const formRef = useRef<HTMLFormElement>(null)
  const update = (field: FilterField, value: string) => setForm((previous) => ({ ...previous,
    draft: { ...previous.draft, [field]: value }, errors: {} }))
  const errors = { ...serverFieldErrors(failures, form.draft, filterDraft(query)), ...form.errors }
  const options = product ? filterOptions(product) : { countries: [], currencies: [] }
  const description = (field: FilterField) => errors[field] ? `product-${field}-error` : undefined
  const select = (field: 'country' | 'currency', label: string, values: string[]) => (
    <div className="product-field">
      <label htmlFor={`product-${field}`}>{label}</label>
      <select id={`product-${field}`} value={form.draft[field]} onChange={(event) => update(field, event.target.value)}
        aria-invalid={Boolean(errors[field])} aria-describedby={description(field)}>
        <option value="">{field === 'country' ? 'Все страны' : 'Все валюты'}</option>
        {form.draft[field] && !values.includes(form.draft[field]) && <option value={form.draft[field]}>{form.draft[field]}</option>}
        {values.map((value) => <option key={value} value={value}>{value}</option>)}
      </select>
      {errors[field] && <p className="product-field-error" id={`product-${field}-error`}>{errors[field]}</p>}
    </div>
  )
  const date = (field: 'date_from' | 'date_to', label: string) => (
    <div className="product-field">
      <label htmlFor={`product-${field}`}>{label}</label>
      <input id={`product-${field}`} type="date" value={form.draft[field]} onChange={(event) => update(field, event.target.value)}
        aria-invalid={Boolean(errors[field])} aria-describedby={`product-period-note${errors[field] ? ` product-${field}-error` : ''}`} />
      {errors[field] && <p className="product-field-error" id={`product-${field}-error`}>{errors[field]}</p>}
    </div>
  )
  return (
    <section className="product-panel" aria-labelledby="product-filters-heading">
      <h2 id="product-filters-heading">Фильтры истории и сводки</h2>
      {!product && <p className="product-note">Страны и валюты появятся после загрузки карточки товара. Выбранные в ссылке значения сохранены.</p>}
      <form ref={formRef} noValidate onSubmit={(event) => {
        event.preventDefault()
        const result = validateFilters(form.draft)
        if (Object.keys(result.errors).length) {
          setForm({ ...form, errors: result.errors })
          const field = Object.keys(result.errors)[0]
          formRef.current?.querySelector<HTMLElement>(`#product-${field}`)?.focus()
        } else apply(result.query)
      }}>
        <div className="product-filter-grid">{select('country', 'Страна', options.countries)}{select('currency', 'Валюта', options.currencies)}</div>
        <StoreFilter country={form.draft.country} value={form.draft.store} initial={product?.stores ?? []}
          known={stores} selected={selectedStore}
          error={errors.store} onChange={(value) => update('store', value)} onStores={onStores} />
        <div className="product-filter-grid">{date('date_from', 'Период с')}{date('date_to', 'Период по')}</div>
        <p className="product-note" id="product-period-note">ГГГГ-ММ-ДД. Обе границы включительно, по локальной дате покупки в чеке.</p>
        {Object.keys(errors).length > 0 && <p className="product-field-error" role="status">Исправьте поля фильтров и примените их снова.</p>}
        <div className="product-actions">
          <button type="submit">Применить фильтры</button>
          <button type="button" className="product-secondary" onClick={() => { setForm({ source: '', draft: filterDraft({ page: 1 }), errors: {} }); reset() }}>Сбросить фильтры</button>
        </div>
      </form>
    </section>
  )
}

function ProductScreen({ productId, query, returnTo }: ProductPageProps) {
  const { store, country, currency, date_from, date_to, page } = query
  const loadProduct = useCallback((signal: AbortSignal) => getProduct(productId, { signal }), [productId])
  const loadHistory = useCallback((signal: AbortSignal) => getProductPrices(productId,
    historyParams({ store, country, currency, date_from, date_to, page }), { signal }),
  [productId, store, country, currency, date_from, date_to, page])
  const loadSummary = useCallback(async (signal: AbortSignal): Promise<ApiResult<SummaryData>> => {
    const result = await getProductPriceSummary(productId, summaryParams({ store, country, currency, date_from, date_to, page: 1 }), { signal })
    return result.kind === 'ok' && (result.data.group_by !== 'store' || result.data.price !== 'paid' || result.data.interval !== 'none')
      ? { kind: 'error', reason: 'invalid_response' } : result
  }, [productId, store, country, currency, date_from, date_to])
  const productRequest = useProductRequest(loadProduct)
  const productBlock = useLocalRequestFocus(productRequest.state)
  const historyRequest = useProductRequest(loadHistory)
  const summaryRequest = useProductRequest(loadSummary)
  const [directoryStores, setDirectoryStores] = useState<Store[]>([])
  const onStores = useCallback((stores: Store[]) => setDirectoryStores((previous) => mergeStores(previous, stores)), [])
  const apply = (next: HistoryQuery) => navigate({ kind: 'product', productId, query: { ...next, page: 1 } })
  const reset = () => apply({ page: 1 })
  const buildPageHref = (nextPage: number) => ({ kind: 'product' as const, productId, query: { ...query, page: nextPage } })
  const product = productRequest.state.kind === 'ok' ? productRequest.state.data : undefined
  const failures = [historyRequest.state, summaryRequest.state].filter((state): state is ApiFailure => state.kind === 'error')
  // Store-grouped summary already includes full stores beyond the card's 50-item limit.
  const summaryStores = summaryRequest.state.kind === 'ok' && summaryRequest.state.data.group_by === 'store'
    ? summaryRequest.state.data.groups.map((group) => group.store) : []
  const stores = mergeStores(mergeStores(directoryStores, product?.stores ?? []), summaryStores)
  const selectedStore = historyRequest.state.kind === 'ok'
    ? historyRequest.state.data.results.find((point) => point.store.id === query.store)?.store : undefined
  const missing = productRequest.state.kind === 'error' && productRequest.state.reason === 'not_found'
  // Independent of the card: a refusal of the local API leaves the card and «не найден» as they were.
  const merges = useProductMergeLookup(productId)
  const merged = missing ? merges.hint : undefined
  // Independent as well: loading and any refusal mean a card without the category notice.
  const classifications = useProductClassificationMarks(productId)
  const classification = product && markFor(classifications, product)
  return (
    <div className="product-page">
      <section ref={productBlock} className="product-panel" aria-labelledby="product-heading" aria-busy={productRequest.state.kind === 'loading'}>
        <h2 id="product-heading" data-request-focus-target tabIndex={-1}>{merged ? 'Товар объединён' : missing ? 'Товар не найден' : product?.name.trim() || (product ? 'Не указано' : 'Карточка товара')}</h2>
        {productRequest.state.kind === 'loading' && <RequestState kind="loading" message="Загружаем карточку товара…" />}
        {productRequest.state.kind === 'error' && (merged ? <MergedProductHint hint={merged} />
          : <ProductRequestState failure={productRequest.state} retry={productRequest.retry} />)}
        {product && <>
          <nav aria-label="Путь категории товара" className="product-breadcrumbs"><ol>
            <li><Link to="/catalog">Каталог</Link></li>
            {product.category.path.map((category) => <li key={category.id}><Link to={{ kind: 'category', categoryId: category.id, query: { page: 1 } }}>{category.name.trim() || 'Не указано'}</Link></li>)}
          </ol></nav>
          <dl className="product-facts">
            <div><dt>Бренд</dt><dd>{product.brand?.name.trim() || 'Не указано'}</dd></div>
            <div><dt>Модель</dt><dd>{product.model.trim() || 'Не указано'}</dd></div>
            <div><dt>GTIN</dt><dd>{product.gtin.trim() || 'Не указано'}</dd></div>
            <div><dt>Фасовка</dt><dd>{product.package ? formatQuantity(product.package.quantity, product.package.unit) : 'Не указано'}</dd></div>
            <div><dt>Обобщённый продукт</dt><dd>{product.generic.name.trim() || 'Не указано'}</dd></div>
          </dl>
          {merges.mark && <ProductMergeNotice mark={merges.mark} />}
          {classification && <ProductClassificationNotice mark={classification} />}
          <div className="product-actions">
            {returnTo && <Link className="action-link" to={returnTo}>{returnTo.startsWith('/receipts/') ? 'К чеку' : 'Назад к списку'}</Link>}
            <Link className="action-link" to={{ kind: 'category', categoryId: product.category.id, query: { page: 1 } }}>Назад в категорию</Link>
          </div>
        </>}
        {!product && (returnTo || !missing) && <Link className="action-link" to={returnTo ?? '/catalog'}>{returnTo?.startsWith('/receipts/') ? 'К чеку' : 'Назад в каталог'}</Link>}
      </section>
      {!missing && <>
        <aside className="product-limitations" aria-label="Ограничения данных о ценах">
          <p>Это наблюдения покупок из чеков, а не текущие цены магазинов. Скидка всего чека не распределена по товарам. Налоговая база цен не указана.</p>
          <p>Сопоставимость обозначает совместимость единиц; она не подтверждает одинаковую налоговую базу. Валюты и единицы не объединяются.</p>
        </aside>
        <FilterForm query={query} product={product} stores={stores} selectedStore={selectedStore}
          failures={failures} apply={apply} reset={reset} onStores={onStores} />
        <PriceHistory state={historyRequest.state} query={query} stores={stores} retry={historyRequest.retry} reset={reset} buildPageHref={buildPageHref} />
        <PriceSummary state={summaryRequest.state} retry={summaryRequest.retry} reset={reset} />
      </>}
    </div>
  )
}

/** F5: default export, uses ProductPageProps from pages/types; the shell owns h1. */
export default function ProductPage(props: ProductPageProps) {
  return <ProductScreen key={props.productId} {...props} />
}
