import { Link } from '../../navigation'
import { canModerate, useSession } from '../../session'
import { categoryText, named } from './labels'
import type { ClassificationMark } from './marks'
import './Classification.css'

const records = (mark: ClassificationMark) => ({ kind: 'classification' as const, query: { product: mark.productId, page: 1 } })
/** The list of categories belongs to the moderator of the catalog: everyone else reads the mark as plain text. */
const useModerator = () => canModerate(useSession())

/** Catalog list: the product was put into a suggested generic product and waits for a decision. */
export function ClassificationBadge({ mark }: { mark: ClassificationMark }) {
  const moderator = useModerator()
  return <p className="ck-class-badge">{moderator
    ? <Link to={records(mark)}>Категория: требует подтверждения</Link> : <span>Категория: требует подтверждения</span>}</p>
}

/** Product card of a product with a pending suggestion. */
export function ProductClassificationNotice({ mark }: { mark: ClassificationMark }) {
  const moderator = useModerator()
  return <div className="ck-class-warning ck-class-notice">
    <p>Категория предложена автоматически: „{named(mark.generic)}“ ({categoryText(mark.category)}) — требует подтверждения. Товар уже участвует в сравнении цен по этому обобщённому продукту.</p>
    {moderator && <Link className="action-link" to={records(mark)}>Открыть в списке категорий</Link>}
  </div>
}
