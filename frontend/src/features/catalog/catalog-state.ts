import type { ApiFailure, Category, ProductParams } from '../../api/types'
import { parseCatalogQuery } from '../../navigation'
import type { CatalogQuery, CatalogRoute } from '../../navigation'

export type CategoryBranch = { category: Category; children: CategoryBranch[] }

/** The server repairs cycles in path/depth; parent_id can still contain a cycle. */
export function categoryTree(categories: Category[]): CategoryBranch[] {
  const roots: CategoryBranch[] = []
  const nodes = new Map(categories.map((category) => [category.id, { category, children: [] } as CategoryBranch]))
  for (const category of categories) {
    const node = nodes.get(category.id)!
    const parentId = category.depth > 0 ? category.path[category.depth - 1]?.id : undefined
    const parent = parentId === undefined ? undefined : nodes.get(parentId)
    if (parent && parent.category.depth < category.depth) parent.children.push(node)
    else roots.push(node)
  }
  return roots
}

export function searchError(value: string): string | undefined {
  const length = [...value.trim()].length
  if (length === 1) return 'Введите не менее 2 символов для поиска.'
  if (length > 100) return 'Введите не более 100 символов для поиска.'
  // URLSearchParams replaces lone surrogates. Validate the original input first.
  if (/[\ud800-\udfff]/u.test(value) || parseCatalogQuery(new URLSearchParams({ q: value })).invalidFields.includes('q')) {
    return 'Удалите недопустимые символы из запроса.'
  }
}

export function withSearch(query: CatalogQuery, value: string): CatalogQuery {
  if (searchError(value)) throw new RangeError('Invalid search')
  const q = value.trim()
  return { ...(query.generic !== undefined ? { generic: query.generic } : {}), ...(q ? { q } : {}), page: 1 }
}

export function withGeneric(query: CatalogQuery, generic?: number): CatalogQuery {
  if (generic !== undefined && (!Number.isSafeInteger(generic) || generic < 1)) throw new RangeError('Invalid generic')
  return { ...(query.q ? { q: query.q } : {}), ...(generic !== undefined ? { generic } : {}), page: 1 }
}

export function productsParams(query: CatalogQuery, categoryId?: number): ProductParams {
  return { ...(categoryId !== undefined ? { category: categoryId } : {}),
    ...(query.q ? { q: query.q } : {}), ...(query.generic !== undefined ? { generic: query.generic } : {}), page: query.page }
}

export function withPage(route: CatalogRoute, page: number): CatalogRoute {
  return { ...route, query: { ...route.query, page } }
}

export function resetFilters(route: CatalogRoute): CatalogRoute {
  return { ...route, query: { page: 1 } }
}

export function emptyProducts(query: CatalogQuery, inCategory: boolean, childrenCount = 0): string {
  if (query.q || query.generic !== undefined) return 'Ничего не найдено по выбранным фильтрам.'
  if (inCategory && childrenCount > 0) return 'Выберите подкатегорию.'
  return inCategory ? 'В этой категории пока нет товаров.' : 'Каталог пока пуст.'
}

export type CatalogFailureView =
  | { kind: 'page'; message: string }
  | { kind: 'missing'; message: string }
  | { kind: 'fields'; message: string; fields: string[] }
  | { kind: 'retry'; message: string }

/** Translate codes locally. Never render server messages or exception text. */
export function failureView(error: ApiFailure): CatalogFailureView {
  if (error.reason === 'page_out_of_range') return { kind: 'page', message: 'Этой страницы результатов уже нет. Откройте первую страницу.' }
  if (error.reason === 'not_found') return { kind: 'missing', message: 'Не найдено. Вернитесь в каталог продуктов.' }
  if (error.status === 400 || ['invalid_parameter', 'invalid_request', 'range_too_large'].includes(error.reason)) {
    return { kind: 'fields', message: 'Проверьте параметры поиска и фильтра. Исправьте поле или сбросьте фильтры.', fields: error.fields ?? [] }
  }
  const messages = {
    network: 'Не удалось связаться с сервером. Проверьте соединение и повторите попытку.',
    timeout: 'Сервер не ответил за 15 секунд. Попробуйте ещё раз.',
    server: 'Не удалось загрузить данные с сервера. Попробуйте ещё раз.',
    invalid_response: 'Сервер вернул некорректный ответ. Попробуйте ещё раз.',
  }
  return { kind: 'retry', message: messages[error.reason as keyof typeof messages] ?? messages.server }
}

export function fieldError(error: ApiFailure | undefined, field: 'q' | 'generic'): string | undefined {
  if (!error) return
  const view = failureView(error)
  if (view.kind !== 'fields' || !view.fields.includes(field)) return
  return field === 'q' ? 'Исправьте запрос: от 2 до 100 символов без управляющих символов.'
    : 'Выберите обобщённый продукт из списка или сбросьте фильтр.'
}
