import { Link } from '../../navigation'
import { categoryText, named } from './labels'
import type { ClassificationMark } from './marks'
import './Classification.css'

const records = (mark: ClassificationMark) => ({ kind: 'classification' as const, query: { product: mark.productId, page: 1 } })

/** Catalog list: the product was put into a suggested generic product and waits for a decision. */
export function ClassificationBadge({ mark }: { mark: ClassificationMark }) {
  return <p className="ck-class-badge"><Link to={records(mark)}>Категория: требует подтверждения</Link></p>
}

/** Product card of a product with a pending suggestion. */
export function ProductClassificationNotice({ mark }: { mark: ClassificationMark }) {
  return <div className="ck-class-warning ck-class-notice">
    <p>Категория предложена автоматически: „{named(mark.generic)}“ ({categoryText(mark.category)}) — требует подтверждения. Товар уже участвует в сравнении цен по этому обобщённому продукту.</p>
    <Link className="action-link" to={records(mark)}>Открыть в списке категорий</Link>
  </div>
}
