import type { Product } from '../../api/types'
import { useNarrow } from '../../lib/cards'
import { formatPrice, formatPurchasedOn, formatQuantity } from '../../lib/format'
import { Link } from '../../navigation'
import { ClassificationBadge } from '../classification/ClassificationMarks'
import { markFor } from '../classification/marks'
import type { ClassificationMark } from '../classification/marks'
import { MergeBadge } from '../merges/MergeMarks'
import type { PendingMark } from '../merges/state'
import { MANUAL_MARK, NO_PLACE } from '../product/state'

type Marks = { merges?: ReadonlyMap<number, PendingMark>; classifications?: ReadonlyMap<number, ClassificationMark> }

/** A phone: one row per product — the name is the link of the whole row, brand and package under it, the last price at
 * the right in the figures font. Marks stay links of their own above the row link. */
export function ProductRows({ products, merges, classifications }: { products: Product[] } & Marks) {
  return <ul className="ck-catalog-rows">
    {products.map((product) => {
      const classification = markFor(classifications, product)
      const meta = [product.brand?.name, product.package ? formatQuantity(product.package.quantity, product.package.unit) : undefined, product.generic.name].filter(Boolean)
      return <li className="ck-catalog-row" key={product.id}>
        <div className="ck-catalog-row-main">
          <h3><Link className="ck-catalog-row-link" to={{ kind: 'product', productId: product.id, query: { page: 1 } }}>{product.name}</Link></h3>
          {meta.length > 0 && <p className="ck-catalog-note">{meta.join(' · ')}</p>}
          {merges?.has(product.id) && <MergeBadge mark={merges.get(product.id)!} />}
          {classification && <ClassificationBadge mark={classification} />}
        </div>
        <div className="ck-catalog-row-prices">
          {product.prices.length === 0 ? <p className="ck-catalog-note">Покупок нет</p>
            : product.prices.map(({ country, currency, last }) => <p key={`${country}/${currency}`}>
              <span className="ck-catalog-price">{formatPrice(last.paid_unit_price, currency)}</span>
              <span className="ck-catalog-note">{country ?? NO_PLACE} · <time dateTime={last.purchased_on}>{formatPurchasedOn(last.purchased_on)}</time>{last.manual && ` · ${MANUAL_MARK}`}</span>
            </p>)}
        </div>
      </li>
    })}
  </ul>
}

/**
 * `merges`: kept products of pending duplicate groups; `classifications`: products with a pending category suggestion.
 * Absent or empty — the list has no marks of that kind.
 */
export default function ProductList({ products, merges, classifications }: {
  products: Product[]; merges?: ReadonlyMap<number, PendingMark>; classifications?: ReadonlyMap<number, ClassificationMark>
}) {
  const narrow = useNarrow()
  if (narrow) return <ProductRows products={products} merges={merges} classifications={classifications} />
  return <ul className="ck-catalog-products">
    {products.map((product) => {
      const classification = markFor(classifications, product)
      return <li className="ck-catalog-product" key={product.id}>
      <div className="ck-catalog-product-description">
        <h3><Link to={{ kind: 'product', productId: product.id, query: { page: 1 } }}>{product.name}</Link></h3>
        {merges?.has(product.id) && <MergeBadge mark={merges.get(product.id)!} />}
        {classification && <ClassificationBadge mark={classification} />}
        <dl className="ck-catalog-metadata">
          <div><dt>Бренд</dt><dd>{product.brand?.name || 'Не указано'}</dd></div>
          <div><dt>Фасовка</dt><dd>{product.package ? <span className="ck-catalog-value">{formatQuantity(product.package.quantity, product.package.unit)}</span> : 'Не указано'}</dd></div>
          <div><dt>Обобщённый продукт</dt><dd>{product.generic.name}</dd></div>
        </dl>
      </div>
      <div className="ck-catalog-product-prices">
        <p className="ck-catalog-price-label">Последняя покупка</p>
        {product.prices.length === 0 ? <p className="ck-catalog-note">Покупок пока нет</p>
          : <ul>
            {product.prices.map(({ country, currency, last }) => <li key={`${country}/${currency}`}>
              <span className="ck-catalog-price">{formatPrice(last.paid_unit_price, currency)}</span>
              <span className="ck-catalog-note">{country ? `Страна: ${country}` : NO_PLACE} · <time dateTime={last.purchased_on}>{formatPurchasedOn(last.purchased_on)}</time>{last.manual && ` · ${MANUAL_MARK}`}</span>
            </li>)}
          </ul>}
      </div>
    </li>
    })}
  </ul>
}
