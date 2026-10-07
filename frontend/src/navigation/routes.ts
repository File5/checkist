import { jobStatuses } from '../api/recognition-types'
import type { JobStatus } from '../api/recognition-types'
import type { ReceiptOperation } from '../api/receipts-types'
import { mergeStatuses } from '../api/product-merges-types'
import type { MergeStatus } from '../api/product-merges-types'
import { classificationStatuses } from '../api/product-classifications-types'
import type { ClassificationStatus } from '../api/product-classifications-types'

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

export interface ReceiptsQuery extends HistoryQuery {
  product?: number
  q?: string
  operation?: ReceiptOperation
  page_size?: number
  ordering?: 'purchased_at' | '-purchased_at'
}

export interface JobsQuery {
  photo?: number
  status?: JobStatus
  page: number
  page_size?: number
  ordering?: 'created_at' | '-created_at'
}

/** No status means the default list: groups waiting for confirmation. */
export interface MergesQuery {
  status?: Exclude<MergeStatus, 'pending'> | 'all'
  page: number
}

/** No status means the default list: records waiting for confirmation. `product` narrows the screen to one product. */
export interface ClassificationQuery {
  status?: Exclude<ClassificationStatus, 'pending'> | 'all'
  product?: number
  page: number
}

export const priceModes = ['paid', 'normalized'] as const
export type PriceMode = typeof priceModes[number]
export const priceIntervals = ['month', 'day', 'week'] as const
export type PriceInterval = typeof priceIntervals[number]

/** Product card: history filters plus the price chart. A parsed query never holds the defaults `paid` and `month`. */
export interface ProductQuery extends HistoryQuery {
  price?: PriceMode
  interval?: PriceInterval
}

export const spendingGroupings = ['category', 'generic', 'product', 'store'] as const
export type SpendingGroupBy = typeof spendingGroupings[number]
export const receiptsStatsIntervals = ['month', 'week', 'quarter', 'year'] as const
export type ReceiptsStatsInterval = typeof receiptsStatsIntervals[number]
/** The API accepts no more than this many stores in one `store` list. */
export const maxStatsStores = 20

/** Filters shared by both statistics screens. A parsed `store` is ascending, without repeats and never empty. */
export interface StatsScopeQuery {
  country?: string
  currency?: string
  store?: number[]
}

/** `/stats`. A parsed query never holds the default `group_by=category`. */
export interface SpendingQuery extends StatsScopeQuery {
  date_from?: string
  date_to?: string
  group_by?: SpendingGroupBy
  category?: number
  generic?: number
}

/** `/stats/receipts`. All four dates are optional here; a parsed query never holds the default `interval=month`. */
export interface ReceiptsStatsQuery extends StatsScopeQuery {
  base_from?: string
  base_to?: string
  current_from?: string
  current_to?: string
  interval?: ReceiptsStatsInterval
}

export type CatalogRoute =
  | { kind: 'catalog'; query: CatalogQuery }
  | { kind: 'category'; categoryId: number; query: CatalogQuery }

export type NavigableRoute = CatalogRoute
  | { kind: 'product'; productId: number; query: ProductQuery }
  | { kind: 'spending'; query: SpendingQuery }
  | { kind: 'receipts-stats'; query: ReceiptsStatsQuery }
  | { kind: 'health' }
  | { kind: 'receipts'; query: ReceiptsQuery }
  | { kind: 'upload' }
  | { kind: 'receipt'; receiptId: number }
  | { kind: 'jobs'; query: JobsQuery }
  | { kind: 'job'; jobId: number }
  | { kind: 'merges'; query: MergesQuery }
  | { kind: 'merge'; groupId: number }
  | { kind: 'classification'; query: ClassificationQuery }
  | { kind: 'login' }

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
  const choice = <T extends string>(name: string, values: readonly T[]): T | undefined => {
    const value = read(name)
    if (value === undefined) return undefined
    if (!values.includes(value as T)) { invalid(name); return undefined }
    return value as T
  }
  const pageSize = () => {
    const size = integer('page_size')
    if (size !== undefined && size > 200) invalid('page_size')
    return size
  }
  return { read, integer, choice, pageSize, invalid, invalidFields }
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

export function parseProductQuery(search: string | URLSearchParams): ParsedQuery<ProductQuery> {
  const history = parseHistoryQuery(search)
  const reader = queryReader(search)
  const price = reader.choice('price', priceModes)
  const interval = reader.choice('interval', priceIntervals)
  // The explicit defaults are the same card: keep one canonical address for it.
  return { query: { ...history.query, ...(price && price !== 'paid' && { price }), ...(interval && interval !== 'month' && { interval }) },
    invalidFields: [...history.invalidFields, ...reader.invalidFields] }
}

type QueryReader = ReturnType<typeof queryReader>

// The statistics screens drop a wrong value instead of refusing the whole address:
// these readers return only values that are safe to send to the API.
function readCode(reader: QueryReader, name: string, pattern: RegExp): string | undefined {
  const value = reader.read(name)?.toUpperCase()
  if (value === undefined || pattern.test(value)) return value
  reader.invalid(name)
  return undefined
}

function readDate(reader: QueryReader, name: string): string | undefined {
  const value = reader.read(name)
  if (value === undefined || isCalendarDate(value)) return value
  reader.invalid(name)
  return undefined
}

/** A reversed period is dropped as a whole: neither bound can be trusted alone. */
function readPeriod(reader: QueryReader, from: string, to: string): [string | undefined, string | undefined] {
  const start = readDate(reader, from)
  const end = readDate(reader, to)
  if (start && end && start > end) { reader.invalid(from); return [undefined, undefined] }
  return [start, end]
}

function readStatsScope(reader: QueryReader): StatsScopeQuery {
  const country = readCode(reader, 'country', /^[A-Z]{2}$/)
  const currency = readCode(reader, 'currency', /^[A-Z]{3}$/)
  let store: number[] | undefined
  const list = reader.read('store')
  if (list !== undefined) {
    const ids = list.split(',').map((part) => positiveInteger(part.trim()))
    const unique = [...new Set(ids)]
    if (unique.includes(undefined) || unique.length > maxStatsStores) reader.invalid('store')
    else store = (unique as number[]).sort((a, b) => a - b)
  }
  return { ...(country && { country }), ...(currency && { currency }), ...(store && { store }) }
}

export function parseSpendingQuery(search: string | URLSearchParams): ParsedQuery<SpendingQuery> {
  const reader = queryReader(search)
  const [date_from, date_to] = readPeriod(reader, 'date_from', 'date_to')
  const scope = readStatsScope(reader)
  const group_by = reader.choice('group_by', spendingGroupings)
  const category = reader.integer('category')
  const generic = reader.integer('generic')
  return {
    query: {
      ...(date_from && { date_from }), ...(date_to && { date_to }), ...scope,
      ...(group_by && group_by !== 'category' && { group_by }), ...(category && { category }), ...(generic && { generic }),
    },
    invalidFields: reader.invalidFields,
  }
}

/** Only each period's own bounds are checked here; whether the periods overlap is the screen's message to show. */
export function parseReceiptsStatsQuery(search: string | URLSearchParams): ParsedQuery<ReceiptsStatsQuery> {
  const reader = queryReader(search)
  const [base_from, base_to] = readPeriod(reader, 'base_from', 'base_to')
  const [current_from, current_to] = readPeriod(reader, 'current_from', 'current_to')
  const scope = readStatsScope(reader)
  const interval = reader.choice('interval', receiptsStatsIntervals)
  return {
    query: {
      ...(base_from && { base_from }), ...(base_to && { base_to }), ...(current_from && { current_from }), ...(current_to && { current_to }),
      ...scope, ...(interval && interval !== 'month' && { interval }),
    },
    invalidFields: reader.invalidFields,
  }
}

export function parseReceiptsQuery(search: string | URLSearchParams): ParsedQuery<ReceiptsQuery> {
  const history = parseHistoryQuery(search)
  const reader = queryReader(search)
  const product = reader.integer('product')
  const q = reader.read('q')
  if (q !== undefined && ([...q].length < 2 || [...q].length > 100)) reader.invalid('q')
  const operation = reader.choice('operation', ['sale', 'refund'] as const)
  const page_size = reader.pageSize()
  const ordering = reader.choice('ordering', ['purchased_at', '-purchased_at'] as const)
  return { query: { ...history.query, ...(product && { product }), ...(q && { q }), ...(operation && { operation }),
    ...(page_size && { page_size }), ...(ordering && { ordering }) }, invalidFields: [...history.invalidFields, ...reader.invalidFields] }
}

export function parseJobsQuery(search: string | URLSearchParams): ParsedQuery<JobsQuery> {
  const reader = queryReader(search)
  const photo = reader.integer('photo')
  const status = reader.choice('status', jobStatuses)
  const page = reader.integer('page') ?? 1
  const page_size = reader.pageSize()
  const ordering = reader.choice('ordering', ['created_at', '-created_at'] as const)
  return { query: { ...(photo && { photo }), ...(status && { status }), page, ...(page_size && { page_size }),
    ...(ordering && { ordering }) }, invalidFields: reader.invalidFields }
}

export function parseMergesQuery(search: string | URLSearchParams): ParsedQuery<MergesQuery> {
  const reader = queryReader(search)
  const status = reader.choice('status', [...mergeStatuses, 'all'] as const)
  const page = reader.integer('page') ?? 1
  // The explicit default is the same list: keep one canonical address for it.
  return { query: { ...(status && status !== 'pending' && { status }), page }, invalidFields: reader.invalidFields }
}

export function parseClassificationQuery(search: string | URLSearchParams): ParsedQuery<ClassificationQuery> {
  const reader = queryReader(search)
  const status = reader.choice('status', [...classificationStatuses, 'all'] as const)
  const product = reader.integer('product')
  const page = reader.integer('page') ?? 1
  // The explicit default is the same list: keep one canonical address for it.
  return { query: { ...(status && status !== 'pending' && { status }), ...(product && { product }), page }, invalidFields: reader.invalidFields }
}

function buildQuery<T>(query: T, keys: (keyof T)[], parse: (search: URLSearchParams) => ParsedQuery<T>, strict = true): string {
  const params = new URLSearchParams()
  for (const key of keys) {
    const value = query[key]
    if (value !== undefined) params.set(String(key), String(value))
  }
  const { query: normalized, invalidFields } = parse(params)
  if (strict && invalidFields.length) throw new RangeError('Invalid route query')
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

export function buildProductQuery(query: ProductQuery): string {
  return buildQuery(query, ['store', 'country', 'currency', 'date_from', 'date_to', 'price', 'interval', 'page'], parseProductQuery)
}

/** Like the address itself, drops wrong values instead of throwing; a store list stays readable: `store=3,5`. */
export function buildSpendingQuery(query: SpendingQuery): string {
  return buildQuery(query, ['date_from', 'date_to', 'country', 'currency', 'store', 'group_by', 'category', 'generic'], parseSpendingQuery, false)
    .replaceAll('%2C', ',')
}

export function buildReceiptsStatsQuery(query: ReceiptsStatsQuery): string {
  return buildQuery(query, ['base_from', 'base_to', 'current_from', 'current_to', 'country', 'currency', 'store', 'interval'], parseReceiptsStatsQuery, false)
    .replaceAll('%2C', ',')
}

/** Links for the statistics screens: the canonical address of a set of filters. */
export function spendingHref(query: SpendingQuery = {}): string {
  return `/stats${buildSpendingQuery(query)}`
}

export function receiptsStatsHref(query: ReceiptsStatsQuery = {}): string {
  return `/stats/receipts${buildReceiptsStatsQuery(query)}`
}

export function buildReceiptsQuery(query: ReceiptsQuery): string {
  return buildQuery(query, ['store', 'product', 'country', 'currency', 'operation', 'date_from', 'date_to', 'q', 'page', 'page_size', 'ordering'], parseReceiptsQuery)
}

export function buildJobsQuery(query: JobsQuery): string {
  return buildQuery(query, ['photo', 'status', 'page', 'page_size', 'ordering'], parseJobsQuery)
}

export function buildMergesQuery(query: MergesQuery): string {
  return buildQuery(query, ['status', 'page'], parseMergesQuery)
}

export function buildClassificationQuery(query: ClassificationQuery): string {
  return buildQuery(query, ['status', 'product', 'page'], parseClassificationQuery)
}

function buildId(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError('Invalid route ID')
  return String(id)
}

export function buildRoute(route: NavigableRoute): string {
  switch (route.kind) {
    case 'catalog': return `/catalog${buildCatalogQuery(route.query)}`
    case 'category': return `/catalog/categories/${buildId(route.categoryId)}${buildCatalogQuery(route.query)}`
    case 'product': return `/catalog/products/${buildId(route.productId)}${buildProductQuery(route.query)}`
    case 'spending': return spendingHref(route.query)
    case 'receipts-stats': return receiptsStatsHref(route.query)
    case 'health': return '/health'
    case 'receipts': return `/receipts${buildReceiptsQuery(route.query)}`
    case 'upload': return '/receipts/upload'
    case 'receipt': return `/receipts/${buildId(route.receiptId)}`
    case 'jobs': return `/recognition/jobs${buildJobsQuery(route.query)}`
    case 'job': return `/recognition/jobs/${buildId(route.jobId)}`
    case 'merges': return `/catalog/merges${buildMergesQuery(route.query)}`
    case 'merge': return `/catalog/merges/${buildId(route.groupId)}`
    case 'classification': return `/catalog/classification${buildClassificationQuery(route.query)}`
    case 'login': return '/login'
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
  if (normalizedPath === '/login') return { kind: 'login' }
  if (normalizedPath === '/receipts/upload') return { kind: 'upload' }
  // Statistics never answer with invalid-query: a wrong value is dropped and the screen opens without it.
  if (normalizedPath === '/stats') return { kind: 'spending', query: parseSpendingQuery(url.searchParams).query }
  if (normalizedPath === '/stats/receipts') return { kind: 'receipts-stats', query: parseReceiptsStatsQuery(url.searchParams).query }
  if (normalizedPath === '/receipts' || normalizedPath === '/recognition/jobs') {
    const receipts = normalizedPath === '/receipts'
    const parsed = receipts ? parseReceiptsQuery(url.searchParams) : parseJobsQuery(url.searchParams)
    if (parsed.invalidFields.length) return { kind: 'invalid-query', path, fields: parsed.invalidFields, resetTo: normalizedPath }
    return receipts ? { kind: 'receipts', query: parsed.query as ReceiptsQuery } : { kind: 'jobs', query: parsed.query as JobsQuery }
  }
  if (normalizedPath === '/catalog/merges') {
    const parsed = parseMergesQuery(url.searchParams)
    if (parsed.invalidFields.length) return { kind: 'invalid-query', path, fields: parsed.invalidFields, resetTo: normalizedPath }
    return { kind: 'merges', query: parsed.query }
  }
  if (normalizedPath === '/catalog/classification') {
    const parsed = parseClassificationQuery(url.searchParams)
    if (parsed.invalidFields.length) return { kind: 'invalid-query', path, fields: parsed.invalidFields, resetTo: normalizedPath }
    return { kind: 'classification', query: parsed.query }
  }
  const detail = /^\/(receipts|recognition\/jobs|catalog\/merges)\/([^/]+)$/.exec(normalizedPath)
  if (detail) {
    let id: number | undefined
    try { id = positiveInteger(decodeURIComponent(detail[2])) } catch { /* Invalid path encoding. */ }
    if (id === undefined) return { kind: 'not-found', path }
    return detail[1] === 'receipts' ? { kind: 'receipt', receiptId: id }
      : detail[1] === 'catalog/merges' ? { kind: 'merge', groupId: id } : { kind: 'job', jobId: id }
  }

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
      const parsed = parseProductQuery(url.searchParams)
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
