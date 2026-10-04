import RequestState from '../components/RequestState'
import { Link } from '../navigation'
import type { CatalogPageProps, CategoryPageProps, ProductPageProps } from './types'

export function CatalogPlaceholder({ query }: CatalogPageProps) {
  return <RequestState kind="empty" message={`Просмотр каталога будет подключён на следующем этапе.${query.q ? ' Параметры поиска сохранены в адресе.' : ''}`} />
}

export function CategoryPlaceholder({ categoryId }: CategoryPageProps) {
  return <RequestState kind="empty" message={`Просмотр категории № ${categoryId.toLocaleString('ru-RU')} будет подключён на следующем этапе.`} action={<Link className="action-link" to="/catalog">В каталог</Link>} />
}

export function ProductPlaceholder({ productId, returnTo }: ProductPageProps) {
  return <RequestState kind="empty" message={`Карточка товара № ${productId.toLocaleString('ru-RU')} и история цен будут подключены на следующем этапе.`} action={<Link className="action-link" to={returnTo ?? '/catalog'}>{returnTo ? 'Вернуться к списку' : 'В каталог'}</Link>} />
}
