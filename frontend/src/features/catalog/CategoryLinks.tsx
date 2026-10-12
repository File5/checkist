import type { Category, NamedObject } from '../../api/types'
import { Link } from '../../navigation'
import { ChipScroller } from '../recognition/_tmp-foundation'
import { categoryTree } from './catalog-state'
import type { CategoryBranch } from './catalog-state'

function Branches({ branches }: { branches: CategoryBranch[] }) {
  return <ul className="ck-catalog-category-list">
    {branches.map(({ category, children }) => (
      <li key={category.id} data-compact={category.depth >= 3 ? 'true' : undefined}>
        <Link className="ck-catalog-category-link" to={{ kind: 'category', categoryId: category.id, query: { page: 1 } }}>
          <span>{category.name}</span>
          <span className="ck-catalog-count">Товаров в ветви: {category.products_total.toLocaleString('ru-RU')}</span>
        </Link>
        {children.length > 0 && <Branches branches={children} />}
      </li>
    ))}
  </ul>
}

export function CategoryLinks({ categories }: { categories: Category[] }) {
  return <Branches branches={categoryTree(categories)} />
}

/** A phone: the categories of the first level of the given list as one row of chips; deeper levels are reached
 * through the category page, where the subcategories are chips again. */
export function CategoryChips({ categories, label }: { categories: Category[]; label: string }) {
  return <ChipScroller label={label}>
    {categoryTree(categories).map(({ category }) => <li key={category.id}>
      <Link className="ck-chip" to={{ kind: 'category', categoryId: category.id, query: { page: 1 } }}>
        {category.name}<span className="ck-catalog-chip-count ck-figures">{category.products_total.toLocaleString('ru-RU')}</span>
      </Link>
    </li>)}
  </ChipScroller>
}

export function CategoryBreadcrumbs({ path }: { path: NamedObject[] }) {
  return <nav className="ck-catalog-breadcrumbs" aria-label="Хлебные крошки">
    <ol>
      <li><Link to="/catalog">Каталог</Link></li>
      {path.map((category, index) => <li key={category.id}>
        <span aria-hidden="true"> / </span>
        {index === path.length - 1
          ? <span aria-current="page">{category.name}</span>
          : <Link to={{ kind: 'category', categoryId: category.id, query: { page: 1 } }}>{category.name}</Link>}
      </li>)}
    </ol>
  </nav>
}
