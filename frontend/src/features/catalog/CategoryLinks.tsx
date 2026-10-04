import type { Category, NamedObject } from '../../api/types'
import { Link } from '../../navigation'
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
