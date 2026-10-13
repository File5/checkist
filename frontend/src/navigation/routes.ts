import { jobStatuses } from '../api/recognition-types'
import type { JobStatus } from '../api/recognition-types'
import type { ReceiptOperation } from '../api/receipts-types'
import { mergeStatuses } from '../api/product-merges-types'
import type { MergeStatus } from '../api/product-merges-types'
import { classificationStatuses } from '../api/product-classifications-types'
import type { ClassificationStatus } from '../api/product-classifications-types'
import { exportHref, parseExportQuery } from '../features/export/export-query'
import type { ExportQuery } from '../features/export/export-query'

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
  /** «Траты»: who added the receipt — a username of the family (`/api/me/` household members). */
  owner?: string
  /** «Показать скрытые» of the family head: `1` also lists hidden payments. */
  hidden?: 1
  operation?: ReceiptOperation
  page_size?: number
  ordering?: 'purchased_at' | '-purchased_at'
}

export interface JobsQuery {
  photo?: number
  status?: JobStatus
  /** Only jobs with a crop waiting for a person (and not retried). */
  needs_review?: 1
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
const spendingOtherStates = ['open'] as const
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
  /** The composition of «Прочее» is shown. State of the screen only: never sent to the API. */
  other?: 'open'
}

/** `/stats/receipts`. All four dates are optional here; a parsed query never holds the default `interval=month`. */
export interface ReceiptsStatsQuery extends StatsScopeQuery {
  base_from?: string
  base_to?: string
  current_from?: string
  current_to?: string
  interval?: ReceiptsStatsInterval
}

/** Window lengths of the older «Динамика» addresses (`months`), in months; 12 is the default and never stands in a parsed query. */
export const trendsMonthChoices = [6, 12, 24] as const
export type TrendsMonths = typeof trendsMonthChoices[number]
/** The widest period of «Динамика», as on the server (`MAX_MONTHS`). */
export const maxTrendsPeriodMonths = 60

/**
 * `/stats/trends`. `from` … `to` — the period, both inclusive (`ГГГГ-ММ`, at most 60 months; they come and go together and
 * replace `months`); `months` — the window of older links, ending at the server's current month; `month` — the column
 * opened in «Траты по месяцам»; `category` — the category of «Категория во времени».
 */
export interface TrendsQuery {
  from?: string
  to?: string
  months?: Exclude<TrendsMonths, 12>
  category?: number
  month?: string
}

/** Months from `from` to `to` inclusive (`ГГГГ-ММ`); zero or less when `to` is earlier. */
export function trendsSpan(from: string, to: string): number {
  const index = (month: string) => Number(month.slice(0, 4)) * 12 + Number(month.slice(5, 7))
  return index(to) - index(from) + 1
}
/** A month the server accepts in a period: `ГГГГ-ММ` from 1901. */
const periodMonth = (value: string | undefined) => {
  const month = parseMonthParam(value)
  return month && month >= '1901-01' ? month : undefined
}

export type CatalogRoute =
  | { kind: 'catalog'; query: CatalogQuery }
  | { kind: 'category'; categoryId: number; query: CatalogQuery }

export type NavigableRoute = CatalogRoute
  /** «Главная»: the month of the family budget; no `month` — the server's current month. */
  | { kind: 'dashboard'; month?: string }
  /** Monthly limits of top-level categories. */
  | { kind: 'limits' }
  /** What the money of a category went on in a month (from a row of «Главная»); no `month` — the server's current one. */
  | { kind: 'category-spends'; categoryId: number; month?: string }
  | { kind: 'product'; productId: number; query: ProductQuery }
  | { kind: 'spending'; query: SpendingQuery }
  | { kind: 'receipts-stats'; query: ReceiptsStatsQuery }
  /** «Динамика»: spending by month, one category over time, the family price index. */
  | { kind: 'trends'; query: TrendsQuery }
  | { kind: 'health' }
  | { kind: 'receipts'; query: ReceiptsQuery }
  | { kind: 'upload' }
  /** «Добавить трату» — a spend without a receipt; `repeat` — a manual spend whose copy with today's date starts the form
   * («Повторить»). `expense-edit` changes a manual spend with the same form. `income` — the same form on «Доход». */
  | { kind: 'expense-new'; repeat?: number; income?: boolean }
  | { kind: 'expense-edit'; receiptId: number }
  /** «Доходы» of a month (no `month` — the current one) and the form of one income. */
  | { kind: 'incomes'; month?: string }
  | { kind: 'income-edit'; incomeId: number }
  | { kind: 'receipt'; receiptId: number }
  | { kind: 'jobs'; query: JobsQuery }
  | { kind: 'job'; jobId: number }
  | { kind: 'merges'; query: MergesQuery }
  | { kind: 'merge'; groupId: number }
  | { kind: 'classification'; query: ClassificationQuery }
  | { kind: 'login' }
  /** «Аккаунт»: password change and sign-out. The shell answers «not found» for it in local_single. */
  | { kind: 'account' }
  /** «Выгрузка»: the family's data as one JSON document; the filters live in the address. */
  | { kind: 'export'; query: ExportQuery }
  /** «Семья» (only with accounts): members, invites, the head role; `token` — an invite opened from its link. */
  | { kind: 'family'; token?: string }
  /** «Регулярные платежи»: rent, utilities, subscriptions of this month, suggestions from history, the form. */
  | { kind: 'recurring' }
  /** «Магазины»: places of the family, the ones that look like one payee, the merge. */
  | { kind: 'stores' }
  /** The invite of a new family (`/family/new?token=…`): a guest creates an account and a family; no `token` — a broken link. */
  | { kind: 'family-new'; token?: string }
  /** Импорт выписок: загрузка PDF, черновик одной выписки и правила получателей. */
  | { kind: 'statement-new' }
  | { kind: 'statement'; statementId: number }
  | { kind: 'statement-rules' }

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
  const other = reader.choice('other', spendingOtherStates)
  return {
    query: {
      ...(date_from && { date_from }), ...(date_to && { date_to }), ...scope,
      ...(group_by && group_by !== 'category' && { group_by }), ...(category && { category }), ...(generic && { generic }),
      ...(other && { other }),
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

/** Like the other statistics screens, a wrong value is dropped instead of refusing the address. */
export function parseTrendsQuery(search: string | URLSearchParams): ParsedQuery<TrendsQuery> {
  const reader = queryReader(search)
  const rawFrom = reader.read('from')
  const rawTo = reader.read('to')
  const months = reader.choice('months', trendsMonthChoices.map(String))
  const category = reader.integer('category')
  const raw = reader.read('month')
  const month = parseMonthParam(raw)
  if (raw !== undefined && month === undefined) reader.invalid('month')
  // A period is the pair, in order and not longer than the server allows; it wins over the older `months`.
  let period: { from: string; to: string } | undefined
  if (rawFrom !== undefined || rawTo !== undefined) {
    const from = periodMonth(rawFrom)
    const to = periodMonth(rawTo)
    if (from === undefined) reader.invalid('from')
    if (to === undefined) reader.invalid('to')
    if (from !== undefined && to !== undefined) {
      const span = trendsSpan(from, to)
      if (span >= 1 && span <= maxTrendsPeriodMonths) period = { from, to }
      else reader.invalid(span < 1 ? 'to' : 'from')
    }
  }
  return {
    query: {
      ...period,
      ...(!period && months && months !== '12' && { months: Number(months) as Exclude<TrendsMonths, 12> }), ...(category && { category }),
      ...(month && { month }),
    },
    invalidFields: reader.invalidFields,
  }
}

/** A Django username: letters, digits and @.+-_, at most 150 characters. A wrong one is refused like any wrong filter. */
const ownerPattern = /^[\p{L}\p{N}_@.+-]{1,150}$/u

export function parseReceiptsQuery(search: string | URLSearchParams): ParsedQuery<ReceiptsQuery> {
  const history = parseHistoryQuery(search)
  const reader = queryReader(search)
  const product = reader.integer('product')
  const q = reader.read('q')
  if (q !== undefined && ([...q].length < 2 || [...q].length > 100)) reader.invalid('q')
  const operation = reader.choice('operation', ['sale', 'refund'] as const)
  const page_size = reader.pageSize()
  const ordering = reader.choice('ordering', ['purchased_at', '-purchased_at'] as const)
  const owner = reader.read('owner')
  if (owner !== undefined && !ownerPattern.test(owner)) reader.invalid('owner')
  const hidden = reader.read('hidden')
  if (hidden !== undefined && hidden !== '1') reader.invalid('hidden')
  return { query: { ...history.query, ...(product && { product }), ...(q && { q }), ...(operation && { operation }),
    ...(owner && ownerPattern.test(owner) && { owner }), ...(hidden === '1' && { hidden: 1 as const }), ...(page_size && { page_size }), ...(ordering && { ordering }) },
    invalidFields: [...history.invalidFields, ...reader.invalidFields] }
}

export function parseJobsQuery(search: string | URLSearchParams): ParsedQuery<JobsQuery> {
  const reader = queryReader(search)
  const photo = reader.integer('photo')
  const status = reader.choice('status', jobStatuses)
  const needsReview = reader.choice('needs_review', ['1', '0'] as const)
  const page = reader.integer('page') ?? 1
  const page_size = reader.pageSize()
  const ordering = reader.choice('ordering', ['created_at', '-created_at'] as const)
  return { query: { ...(photo && { photo }), ...(status && { status }), ...(needsReview === '1' && { needs_review: 1 as const }), page, ...(page_size && { page_size }),
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
  return buildQuery(query, ['date_from', 'date_to', 'country', 'currency', 'store', 'group_by', 'category', 'generic', 'other'], parseSpendingQuery, false)
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

export function buildTrendsQuery(query: TrendsQuery): string {
  return buildQuery(query, ['from', 'to', 'months', 'category', 'month'], parseTrendsQuery, false)
}

export function trendsHref(query: TrendsQuery = {}): string {
  return `/stats/trends${buildTrendsQuery(query)}`
}

export function buildReceiptsQuery(query: ReceiptsQuery): string {
  return buildQuery(query, ['store', 'product', 'country', 'currency', 'operation', 'date_from', 'date_to', 'q', 'owner', 'hidden', 'page', 'page_size', 'ordering'], parseReceiptsQuery)
}

export function buildJobsQuery(query: JobsQuery): string {
  return buildQuery(query, ['photo', 'status', 'needs_review', 'page', 'page_size', 'ordering'], parseJobsQuery)
}

export function buildMergesQuery(query: MergesQuery): string {
  return buildQuery(query, ['status', 'page'], parseMergesQuery)
}

export function buildClassificationQuery(query: ClassificationQuery): string {
  return buildQuery(query, ['status', 'product', 'page'], parseClassificationQuery)
}

/** `YYYY-MM` of a real month; anything else is dropped like a wrong statistics filter. */
export function parseMonthParam(value: string | null | undefined): string | undefined {
  const month = value?.trim()
  return month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month) && !month.startsWith('0000') ? month : undefined
}

function buildId(id: number): string {
  if (!Number.isSafeInteger(id) || id <= 0) throw new RangeError('Invalid route ID')
  return String(id)
}

export function buildRoute(route: NavigableRoute): string {
  switch (route.kind) {
    case 'dashboard': {
      const month = parseMonthParam(route.month)
      return month ? `/?month=${month}` : '/'
    }
    case 'limits': return '/budget/limits'
    case 'category-spends': {
      const month = parseMonthParam(route.month)
      return `/spends/category/${buildId(route.categoryId)}${month ? `?month=${month}` : ''}`
    }
    case 'catalog': return `/catalog${buildCatalogQuery(route.query)}`
    case 'category': return `/catalog/categories/${buildId(route.categoryId)}${buildCatalogQuery(route.query)}`
    case 'product': return `/catalog/products/${buildId(route.productId)}${buildProductQuery(route.query)}`
    case 'spending': return spendingHref(route.query)
    case 'receipts-stats': return receiptsStatsHref(route.query)
    case 'trends': return trendsHref(route.query)
    case 'health': return '/health'
    case 'receipts': return `/receipts${buildReceiptsQuery(route.query)}`
    case 'upload': return '/receipts/upload'
    case 'expense-new': return route.income ? '/receipts/new?kind=income'
      : route.repeat === undefined ? '/receipts/new' : `/receipts/new?repeat=${buildId(route.repeat)}`
    case 'expense-edit': return `/receipts/${buildId(route.receiptId)}/edit`
    case 'incomes': return parseMonthParam(route.month) ? `/incomes?month=${route.month}` : '/incomes'
    case 'income-edit': return `/incomes/${buildId(route.incomeId)}/edit`
    case 'receipt': return `/receipts/${buildId(route.receiptId)}`
    case 'jobs': return `/recognition/jobs${buildJobsQuery(route.query)}`
    case 'job': return `/recognition/jobs/${buildId(route.jobId)}`
    case 'merges': return `/catalog/merges${buildMergesQuery(route.query)}`
    case 'merge': return `/catalog/merges/${buildId(route.groupId)}`
    case 'classification': return `/catalog/classification${buildClassificationQuery(route.query)}`
    case 'login': return '/login'
    case 'account': return '/account'
    case 'export': return exportHref(route.query)
    case 'family': return route.token ? `/family/join?${new URLSearchParams({ token: route.token })}` : '/family'
    case 'recurring': return '/recurring'
    case 'stores': return '/stores'
    case 'family-new': return route.token ? `/family/new?${new URLSearchParams({ token: route.token })}` : '/family/new'
    case 'statement-new': return '/statements/new'
    case 'statement': return `/statements/${buildId(route.statementId)}`
    case 'statement-rules': return '/statements/rules'
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
  // The dashboard never answers with invalid-query: a wrong month is dropped and the current one opens.
  if (normalizedPath === '/') {
    const month = parseMonthParam(url.searchParams.getAll('month').at(-1))
    return month ? { kind: 'dashboard', month } : { kind: 'dashboard' }
  }
  if (normalizedPath === '/budget/limits') return { kind: 'limits' }
  const spends = /^\/spends\/category\/([^/]+)$/.exec(normalizedPath)
  if (spends) {
    let id: number | undefined
    try { id = positiveInteger(decodeURIComponent(spends[1])) } catch { /* Invalid path encoding. */ }
    if (id === undefined) return { kind: 'not-found', path }
    // Like the dashboard: a wrong month is dropped and the current one opens.
    const month = parseMonthParam(url.searchParams.getAll('month').at(-1))
    return month ? { kind: 'category-spends', categoryId: id, month } : { kind: 'category-spends', categoryId: id }
  }
  if (normalizedPath === '/login') return { kind: 'login' }
  if (normalizedPath === '/receipts/upload') return { kind: 'upload' }
  if (normalizedPath === '/receipts/new') {
    if (url.searchParams.get('kind') === 'income') return { kind: 'expense-new', income: true }
    // A wrong `repeat` is dropped: the form opens empty.
    const repeat = positiveInteger(url.searchParams.get('repeat') ?? '')
    return repeat === undefined ? { kind: 'expense-new' } : { kind: 'expense-new', repeat }
  }
  const edit = /^\/receipts\/([^/]+)\/edit$/.exec(normalizedPath)
  if (edit) {
    let id: number | undefined
    try { id = positiveInteger(decodeURIComponent(edit[1])) } catch { /* Invalid path encoding. */ }
    return id === undefined ? { kind: 'not-found', path } : { kind: 'expense-edit', receiptId: id }
  }
  if (normalizedPath === '/account') return { kind: 'account' }
  if (normalizedPath === '/incomes') {
    // Like the dashboard: a wrong month is dropped and the current one opens.
    const month = parseMonthParam(url.searchParams.getAll('month').at(-1))
    return month ? { kind: 'incomes', month } : { kind: 'incomes' }
  }
  const incomeEdit = /^\/incomes\/([^/]+)\/edit$/.exec(normalizedPath)
  if (incomeEdit) {
    let id: number | undefined
    try { id = positiveInteger(decodeURIComponent(incomeEdit[1])) } catch { /* Invalid path encoding. */ }
    return id === undefined ? { kind: 'not-found', path } : { kind: 'income-edit', incomeId: id }
  }
  if (normalizedPath === '/stores') return { kind: 'stores' }
  if (normalizedPath === '/family') return { kind: 'family' }
  if (normalizedPath === '/recurring') return { kind: 'recurring' }
  if (normalizedPath === '/statements/new') return { kind: 'statement-new' }
  if (normalizedPath === '/statements/rules') return { kind: 'statement-rules' }
  const statement = /^\/statements\/([^/]+)$/.exec(normalizedPath)
  if (statement) {
    let id: number | undefined
    try { id = positiveInteger(decodeURIComponent(statement[1])) } catch { /* Invalid path encoding. */ }
    return id === undefined ? { kind: 'not-found', path } : { kind: 'statement', statementId: id }
  }
  if (normalizedPath === '/family/join') {
    const token = url.searchParams.get('token') ?? ''
    return /^[A-Za-z0-9_-]{8,200}$/.test(token) ? { kind: 'family', token } : { kind: 'family' }
  }
  if (normalizedPath === '/family/new') {
    const token = url.searchParams.get('token') ?? ''
    return /^[A-Za-z0-9_-]{8,200}$/.test(token) ? { kind: 'family-new', token } : { kind: 'family-new' }
  }
  // Like statistics, the export never answers with invalid-query: a wrong value is dropped.
  if (normalizedPath === '/export') return { kind: 'export', query: parseExportQuery(url.searchParams) }
  // Statistics never answer with invalid-query: a wrong value is dropped and the screen opens without it.
  if (normalizedPath === '/stats') return { kind: 'spending', query: parseSpendingQuery(url.searchParams).query }
  if (normalizedPath === '/stats/receipts') return { kind: 'receipts-stats', query: parseReceiptsStatsQuery(url.searchParams).query }
  if (normalizedPath === '/stats/trends') return { kind: 'trends', query: parseTrendsQuery(url.searchParams).query }
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
  if (normalizedPath === '/catalog') {
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
