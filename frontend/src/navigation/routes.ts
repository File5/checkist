export interface CatalogQuery {
  q?: string
  generic?: number
  page: number
}

export interface HistoryQuery {
  store?: number
  country?: string
  currency?: string
  date_from?: string
  date_to?: string
  page: number
}

export type CatalogRoute =
  | { kind: 'catalog'; query: CatalogQuery }
  | { kind: 'category'; categoryId: number; query: CatalogQuery }

export type NavigableRoute = CatalogRoute
  | { kind: 'product'; productId: number; query: HistoryQuery }
  | { kind: 'health' }

export type Route = NavigableRoute
  | { kind: 'not-found'; path: string }
  | { kind: 'invalid-query'; path: string; fields: string[]; resetTo: string }

export interface ParsedQuery<T> {
  query: T
  invalidFields: string[]
}

const invalidUnicode = /[\ud800-\udfff]/u

function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!
    return code <= 31 || (code >= 127 && code <= 159)
  })
}

function positiveInteger(value: string): number | undefined {
  if (!/^[0-9]{1,19}$/.test(value)) return undefined
  const number = Number(value)
  return Number.isSafeInteger(number) && number > 0 ? number : undefined
}

function queryReader(search: string | URLSearchParams) {
  const params = new URLSearchParams(search)
  const invalidFields: string[] = []
  const invalid = (name: string) => {
    if (!invalidFields.includes(name)) invalidFields.push(name)
  }
  const read = (name: string) => {
    // Match the API's last-value rule for repeated parameters.
    const value = params.getAll(name).at(-1)
    if (value === undefined) return undefined
    if (hasControlCharacters(value) || invalidUnicode.test(value)) {
      invalid(name)
      return undefined
    }
    return value.trim() || undefined
  }
  const integer = (name: string) => {
    const value = read(name)
    if (value === undefined) return undefined
    const result = positiveInteger(value)
    if (result === undefined) invalid(name)
    return result
  }
  return { read, integer, invalid, invalidFields }
}

export function parseCatalogQuery(search: string | URLSearchParams): ParsedQuery<CatalogQuery> {
  const reader = queryReader(search)
  const q = reader.read('q')
  if (q !== undefined && ([...q].length < 2 || [...q].length > 100)) reader.invalid('q')
  const generic = reader.integer('generic')
  const page = reader.integer('page') ?? 1
  return { query: { ...(q && { q }), ...(generic && { generic }), page }, invalidFields: reader.invalidFields }
}

function isCalendarDate(value: string): boolean {
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value)) return false
  const [year, month, day] = value.split('-').map(Number)
  if (year < 1 || month < 1 || month > 12) return false
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0)
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]
  return day >= 1 && day <= days[month - 1]
}

export function parseHistoryQuery(search: string | URLSearchParams): ParsedQuery<HistoryQuery> {
  const reader = queryReader(search)
  const store = reader.integer('store')
  const country = reader.read('country')?.toUpperCase()
  const currency = reader.read('currency')?.toUpperCase()
  const date_from = reader.read('date_from')
  const date_to = reader.read('date_to')
  if (country && !/^[A-Z]{2}$/.test(country)) reader.invalid('country')
  if (currency && !/^[A-Z]{3}$/.test(currency)) reader.invalid('currency')
  if (date_from && !isCalendarDate(date_from)) reader.invalid('date_from')
  if (date_to && !isCalendarDate(date_to)) reader.invalid('date_to')
  if (date_from && date_to && date_from > date_to) reader.invalid('date_from')
  const page = reader.integer('page') ?? 1
  return {
    query: {
      ...(store && { store }), ...(country && { country }), ...(currency && { currency }),
      ...(date_from && { date_from }), ...(date_to && { date_to }), page,
    },
    invalidFields: reader.invalidFields,
  }
}

function buildQuery<T>(query: T, keys: (keyof T)[], parse: (search: URLSearchParams) => ParsedQuery<T>): string {
  const params = new URLSearchParams()
  for (const key of keys) {
    const value = query[key]
    if (value !== undefined) params.set(String(key), String(value))
  }
  const { query: normalized, invalidFields } = parse(params)
  if (invalidFields.length) throw new RangeError('Invalid route query')
  const result = new URLSearchParams()
  for (const key of keys) {
    const value = normalized[key]
    if (value !== undefined && !(key === 'page' && value === 1)) result.set(String(key), String(value))
  }
  const search = result.toString()
  return search ? `?${search}` : ''
}

/** Returns a leading '?' or an empty string. Only the route's own filters survive. */
export function buildCatalogQuery(query: CatalogQuery): string {
  return buildQuery(query, ['q', 'generic', 'page'], parseCatalogQuery)
}

export function buildHistoryQuery(query: HistoryQuery): string {
  return buildQuery(query, ['store', 'country', 'currency', 'date_from', 'date_to', 'page'], parseHistoryQuery)
}

function buildId(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError('Invalid route ID')
  return String(id)
}

export function buildRoute(route: NavigableRoute): string {
  switch (route.kind) {
    case 'catalog': return `/catalog${buildCatalogQuery(route.query)}`
    case 'category': return `/catalog/categories/${buildId(route.categoryId)}${buildCatalogQuery(route.query)}`
    case 'product': return `/catalog/products/${buildId(route.productId)}${buildHistoryQuery(route.query)}`
    case 'health': return '/health'
  }
}

export function parseRoute(input: string | URL): Route {
  let url: URL
  try {
    url = new URL(input, 'http://checkist.local')
  } catch {
    return { kind: 'not-found', path: '/' }
  }
  const path = url.pathname
  const normalizedPath = path === '/' ? path : path.replace(/\/$/, '')
  if (normalizedPath === '/health') return { kind: 'health' }

  let route: NavigableRoute
  let invalidFields: string[]
  if (normalizedPath === '/' || normalizedPath === '/catalog') {
    const parsed = parseCatalogQuery(url.searchParams)
    invalidFields = parsed.invalidFields
    route = { kind: 'catalog', query: parsed.query }
  } else {
    const match = /^\/catalog\/(categories|products)\/([^/]+)$/.exec(normalizedPath)
    if (!match) return { kind: 'not-found', path }
    let id: number | undefined
    try { id = positiveInteger(decodeURIComponent(match[2])) } catch { /* Invalid path encoding. */ }
    if (id === undefined) return { kind: 'not-found', path }
    if (match[1] === 'categories') {
      const parsed = parseCatalogQuery(url.searchParams)
      invalidFields = parsed.invalidFields
      route = { kind: 'category', categoryId: id, query: parsed.query }
    } else {
      const parsed = parseHistoryQuery(url.searchParams)
      invalidFields = parsed.invalidFields
      route = { kind: 'product', productId: id, query: parsed.query }
    }
  }
  if (invalidFields.length) {
    const resetRoute = { ...route, query: { page: 1 } }
    return { kind: 'invalid-query', path, fields: invalidFields, resetTo: buildRoute(resetRoute) }
  }
  return route
}
