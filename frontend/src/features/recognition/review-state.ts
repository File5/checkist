import type { LineKind, ReceiptOperation, TaxKind } from '../../api/receipts-types'
import type {
  NormalizedResult, NormalizedTaxRate, RecognitionIssue, ReviewConfirmInput, ReviewDiscountInput, ReviewLineInput, ReviewTaxInput,
} from '../../api/recognition-types'
import { isISODate } from '../../api/schema'
import type { LocalApiFailure, StoreEntry, Unit } from '../../api/types'
import { issueView } from '../../lib/recognition-issues'
import { reasonLabels } from '../../lib/recognition-labels'

/** The form of one needs_review crop. It lives only in the memory of the page: there is no server draft.
 * Decimals are edited as text and never become a JS number; rows refer to each other by stable keys,
 * positions of the body are derived from the order at the moment of sending.
 */
export type ReviewStore = { id: number; label: string }
export type ReviewHeader = {
  store: ReviewStore | null; storeName: string; address: string; country: string; currency: string
  operation: ReceiptOperation | ''; purchasedOn: string; localTime: string; utcOffset: string; total: string
  pricesIncludeTax: 'yes' | 'no' | ''
}
type Rate = { taxKind: TaxKind | ''; taxRate: string }
export type ReviewLine = Rate & {
  key: number; source: number | null; kind: LineKind | ''; parent: number | null; name: string
  quantity: string; unit: Unit | ''; unitPrice: string; amount: string; taxCode: string
}
export type ReviewDiscount = { key: number; line: number | null; name: string; amount: string }
export type ReviewTax = Rate & { key: number; taxCode: string; net: string; tax: string; gross: string }
export type ReviewList = 'lines' | 'discounts' | 'taxes'
/** Keys of the rows in the order of the arrays that the server indexes its issues and `fields` by. */
export type SentKeys = Record<ReviewList, number[]>
export type ReviewState = {
  header: ReviewHeader; lines: ReviewLine[]; discounts: ReviewDiscount[]; taxes: ReviewTax[]; nextKey: number
  /** Causes shown above the form: of the recognition at first, of the last refused confirmation afterwards. */
  issues: RecognitionIssue[]
  /** Field id → texts of the client. A field loses its texts as soon as the person edits it. */
  problems: Record<string, string[]>
  /** Fields that recognition did not read; marked while they stay empty. */
  unread: string[]
  /** Announcement of the last local action; `focus` names the field that takes focus, null — the announcement itself. */
  notice: { id: number; text: string; focus: string | null }
}
export type ReviewEdit =
  | { type: 'header'; patch: Partial<ReviewHeader> }
  | { type: 'line'; key: number; patch: Partial<Omit<ReviewLine, 'key' | 'source'>> }
  | { type: 'discount'; key: number; patch: Partial<Omit<ReviewDiscount, 'key'>> }
  | { type: 'tax'; key: number; patch: Partial<Omit<ReviewTax, 'key'>> }
  | { type: 'add'; list: ReviewList }
  | { type: 'remove'; list: ReviewList; key: number }
  | { type: 'missing'; problems: Record<string, string[]> }
  | { type: 'refused'; error: LocalApiFailure; sent: SentKeys }

/** Same order as the store labels of the price history: the id first, so that equal names stay distinct. */
export function storeLabel(store: StoreEntry): string {
  return `ID ${store.id} · ${store.name || 'Не указано'} · ${store.address || 'адрес неизвестен'} · ${[store.city, store.country].filter(Boolean).join(' · ')}`
}

const fieldNames: Record<string, string> = {
  storeName: 'store_name', purchasedOn: 'purchased_on', localTime: 'local_time', utcOffset: 'utc_offset', pricesIncludeTax: 'prices_include_tax',
  unitPrice: 'unit_price', taxKind: 'tax_rate.kind', taxRate: 'tax_rate.rate', taxCode: 'tax_code', parent: 'parent_position', line: 'line_position',
}
/** Field ids repeat the paths of the contract, with a row key in place of an array index: `lines.7.unit_price`. */
export const headerField = (prop: keyof ReviewHeader) => `receipt.${fieldNames[prop] ?? prop}`
export const rowField = (list: ReviewList, key: number, prop?: string) => `${list}.${key}${prop === undefined ? '' : `.${fieldNames[prop] ?? prop}`}`

const rowFields: Record<ReviewList, readonly string[]> = {
  lines: ['kind', 'name', 'quantity', 'unit', 'unit_price', 'amount', 'tax_rate', 'tax_rate.kind', 'tax_rate.rate', 'tax_code', 'parent_position'],
  discounts: ['name', 'amount', 'line_position'],
  taxes: ['tax_rate', 'tax_rate.kind', 'tax_rate.rate', 'tax_code', 'net', 'tax', 'gross'],
}
const headerFields: readonly string[] = ['store', 'store_name', 'address', 'country', 'currency', 'operation', 'purchased_on', 'local_time', 'utc_offset', 'total', 'prices_include_tax']
/** context.attribute of a receipt issue → field of the form. */
const receiptAttributes: Record<string, string> = {
  total: 'total', currency: 'currency', purchased_on: 'purchased_on', local_time: 'local_time', operation: 'operation',
  prices_include_tax: 'prices_include_tax', store: 'store', store_name: 'store_name', merchant: 'store_name', merchant_brand_name: 'store_name',
  store_address_raw: 'address', store_city: 'address', store_country_code: 'country', merchant_country_code: 'country',
}
/** Causes that the form cures in a field other than the one the server points at. */
const reasonFields: Record<string, string> = {
  store_ambiguous: 'store', store_conflict: 'store', merchant_conflict: 'store', country_unknown: 'country', currency_unknown: 'currency',
  timestamp_ambiguous: 'utc_offset', timestamp_conflict: 'utc_offset', time_ambiguous: 'utc_offset',
}
const entityLists: Record<string, ReviewList> = { line: 'lines', discount: 'discounts', tax: 'taxes' }
const rowNames: Record<ReviewList, string> = { lines: 'Строка', discounts: 'Скидка', taxes: 'Налоговый итог' }
const entityRows = rowNames
export const problemTexts = {
  required: 'Заполните поле.', lines: 'Добавьте хотя бы одну строку.',
  field: 'Значение не принято: проверьте формат или выбор.', row: 'Запись не принята: проверьте её поля и связи.', list: 'Список не принят: проверьте его записи.',
}

const decimalInput = (value: string | null) => value === null ? '' : value.replace('.', ',')
const blank = (text: string) => text.trim() || null
const code = (text: string) => blank(text)?.toUpperCase() ?? null
const emptyLine = (key: number): ReviewLine => ({
  key, source: null, kind: 'product', parent: null, name: '', quantity: '', unit: '', unitPrice: '', amount: '', taxKind: '', taxRate: '', taxCode: '',
})
/** A reference by a printed position is kept only when exactly one row carries that position. */
function keyByPosition(rows: { position: number | null }[], keys: number[], position: number | null): number | null {
  if (position === null) return null
  const found = rows.flatMap((row, index) => row.position === position ? [keys[index]] : [])
  return found.length === 1 ? found[0] : null
}

/** Text typed by a person → the decimal string of the contract, by string operations only.
 * Comma or point, any spaces between digits (\s also covers the no-break space of formatted numbers);
 * Anything else goes to the server as typed, so that it names the field.
 */
export function decimalText(text: string, places: number): string | null {
  const value = text.replace(/\s/g, '').replace(',', '.')
  if (value === '') return null
  const match = /^(-?\d+)(?:\.(\d*))?$/.exec(value)
  if (!match) return text.trim()
  const fraction = match[2] ?? ''
  const kept = /^0*$/.test(fraction.slice(places)) ? fraction.slice(0, places) : fraction
  return `${match[1]}.${kept.padEnd(places, '0')}`
}

export function createReview(result: NormalizedResult | null, issues: RecognitionIssue[]): ReviewState {
  const base = { issues, problems: {}, notice: { id: 0, text: '', focus: null } }
  const header: ReviewHeader = {
    store: null, storeName: '', address: '', country: '', currency: '', operation: '', purchasedOn: '', localTime: '', utcOffset: '', total: '', pricesIncludeTax: '',
  }
  if (!result) return { header, lines: [emptyLine(1)], discounts: [], taxes: [], nextKey: 2, unread: [], ...base }
  const receipt = result.proposed_receipt
  let nextKey = 1
  const keys = (rows: unknown[]) => rows.map(() => nextKey++)
  const sent: SentKeys = { lines: keys(result.lines), discounts: keys(result.discounts), taxes: keys(result.taxes) }
  const unread: string[] = []
  const read = <T>(id: string, value: T | null): T | null => { if (value === null) unread.push(id); return value }
  const rate = (id: string, value: NormalizedTaxRate): Rate => ({
    taxKind: read(`${id}.tax_rate.kind`, value.kind) ?? '', taxRate: value.kind === 'vat' ? decimalInput(read(`${id}.tax_rate.rate`, value.rate)) : '',
  })
  const positions = result.lines.map((line) => line.position)
  const state: ReviewState = {
    ...base, unread, nextKey,
    header: {
      ...header, storeName: read('receipt.store_name', receipt.store_display_name) ?? '', address: read('receipt.address', receipt.address_display) ?? '',
      country: read('receipt.country', receipt.country) ?? '', currency: read('receipt.currency', receipt.currency) ?? '',
      operation: read('receipt.operation', receipt.operation) ?? '',
      // A printed date that is not a calendar date cannot prefill the field: the person reads it from the image.
      purchasedOn: read('receipt.purchased_on', isISODate(receipt.purchased_on) ? receipt.purchased_on : null) ?? '',
      localTime: read('receipt.local_time', receipt.local_time) ?? '', total: decimalInput(read('receipt.total', receipt.total)),
      pricesIncludeTax: read('receipt.prices_include_tax', receipt.prices_include_tax === null ? null : receipt.prices_include_tax ? 'yes' as const : 'no' as const) ?? '',
    },
    lines: result.lines.map((line, index) => {
      const key = sent.lines[index], id = rowField('lines', key)
      const source = line.position !== null && line.position >= 1 && positions.filter((position) => position === line.position).length === 1 ? line.position : null
      return {
        key, source, kind: read(`${id}.kind`, line.kind) ?? '', parent: keyByPosition(result.lines, sent.lines, line.parent_position),
        name: read(`${id}.name`, line.name) ?? '', quantity: decimalInput(read(`${id}.quantity`, line.quantity)), unit: read(`${id}.unit`, line.unit) ?? '',
        unitPrice: decimalInput(read(`${id}.unit_price`, line.unit_price)), amount: decimalInput(read(`${id}.amount`, line.amount)),
        ...rate(id, line.tax_rate), taxCode: read(`${id}.tax_code`, line.tax_code) ?? '',
      }
    }),
    discounts: result.discounts.map((discount, index) => {
      const key = sent.discounts[index], id = rowField('discounts', key)
      return {
        key, line: keyByPosition(result.lines, sent.lines, discount.line_position),
        name: read(`${id}.name`, discount.name) ?? '', amount: decimalInput(read(`${id}.amount`, discount.amount)),
      }
    }),
    taxes: result.taxes.map((tax, index) => {
      const key = sent.taxes[index], id = rowField('taxes', key)
      return {
        key, ...rate(id, tax.tax_rate), taxCode: read(`${id}.tax_code`, tax.tax_code) ?? '',
        net: decimalInput(read(`${id}.net`, tax.net)), tax: decimalInput(read(`${id}.tax`, tax.tax)), gross: decimalInput(read(`${id}.gross`, tax.gross)),
      }
    }),
  }
  // Issues of the recognition are indexed by the arrays of normalized_result, which the rows repeat one to one.
  return { ...state, problems: issueProblems(issues, sent) }
}

function taxRate(row: Rate): NormalizedTaxRate {
  return row.taxKind === 'vat' ? { kind: 'vat', rate: decimalText(row.taxRate, 2) } : { kind: row.taxKind || null, rate: null }
}

/** The whole form as one request body. Rows are numbered by their order; references follow the rows. */
export function buildInput(state: ReviewState): { input: ReviewConfirmInput; sent: SentKeys } {
  const { header } = state
  const position = (key: number | null) => { const index = state.lines.findIndex((line) => line.key === key); return index < 0 ? null : index + 1 }
  const offset = blank(header.utcOffset)
  const lines = state.lines.map((line, index): ReviewLineInput => ({
    position: index + 1, source_position: line.source, kind: line.kind as LineKind,
    parent_position: line.kind === 'deposit' ? position(line.parent) : null, name: line.name.trim(),
    quantity: decimalText(line.quantity, 3), unit: line.unit || null, unit_price: decimalText(line.unitPrice, 4), amount: decimalText(line.amount, 2),
    tax_rate: taxRate(line), tax_code: blank(line.taxCode),
  }))
  const discounts = state.discounts.map((discount, index): ReviewDiscountInput => ({
    position: index + 1, line_position: position(discount.line), name: discount.name.trim(), amount: decimalText(discount.amount, 2) ?? '',
  }))
  const taxes = state.taxes.map((tax): ReviewTaxInput => ({
    tax_rate: taxRate(tax), tax_code: blank(tax.taxCode), net: decimalText(tax.net, 2), tax: decimalText(tax.tax, 2), gross: decimalText(tax.gross, 2),
  }))
  return {
    input: {
      receipt: {
        store_id: header.store?.id ?? null, store_name: blank(header.storeName), address: blank(header.address), country: code(header.country),
        currency: code(header.currency), operation: header.operation || null, purchased_on: header.purchasedOn.trim(), local_time: header.localTime.trim(),
        // An empty field omits the key: the server then keeps the recognized offset.
        ...(offset !== null && { utc_offset: offset }), total: decimalText(header.total, 2) ?? '',
        prices_include_tax: header.pricesIncludeTax === '' ? null : header.pricesIncludeTax === 'yes',
      },
      lines, discounts, taxes,
    },
    sent: { lines: state.lines.map((line) => line.key), discounts: state.discounts.map((discount) => discount.key), taxes: state.taxes.map((tax) => tax.key) },
  }
}

/** Empty obligatory fields are reported before a request: the server would refuse the same fields. */
export function missingRequired(state: ReviewState): Record<string, string[]> {
  const problems: Record<string, string[]> = {}
  const need = (id: string, value: string) => { if (!value.trim()) problems[id] = [problemTexts.required] }
  need('receipt.purchased_on', state.header.purchasedOn); need('receipt.local_time', state.header.localTime); need('receipt.total', state.header.total)
  if (state.lines.length === 0) problems.lines = [problemTexts.lines]
  for (const line of state.lines) { need(rowField('lines', line.key, 'kind'), line.kind); need(rowField('lines', line.key, 'name'), line.name) }
  for (const discount of state.discounts) { need(rowField('discounts', discount.key, 'name'), discount.name); need(rowField('discounts', discount.key, 'amount'), discount.amount) }
  for (const tax of state.taxes) need(rowField('taxes', tax.key, 'taxKind'), tax.taxKind)
  return problems
}

function push(problems: Record<string, string[]>, id: string, text: string) {
  if (!problems[id]?.includes(text)) problems[id] = [...(problems[id] ?? []), text]
}

/** Blocking causes (severity error) at the fields they concern. The text is the client's label of the cause. */
export function issueProblems(issues: RecognitionIssue[], sent: SentKeys): Record<string, string[]> {
  const problems: Record<string, string[]> = {}
  for (const issue of issues) {
    const view = issueView(issue, 'needs_review')
    if (view.severity !== 'error') continue
    const text = reasonLabels[view.legacy && view.reason === 'invalid_value' ? 'unknown' : view.reason]
    const list = entityLists[view.entity]
    if (list) {
      const key = view.index === null ? undefined : sent[list][view.index]
      const attribute = view.attribute !== null && rowFields[list].includes(view.attribute) ? `.${view.attribute}` : ''
      push(problems, key === undefined ? list : `${list}.${key}${attribute}`, text)
    } else if (view.entity === 'receipt') {
      const fields = new Set([view.attribute === null ? undefined : receiptAttributes[view.attribute], reasonFields[view.reason]])
      for (const field of fields) if (field) push(problems, `receipt.${field}`, text)
    }
  }
  return problems
}

/** Paths of a 400 invalid_parameter (`lines.0.quantity`) at the fields. Server phrases are never shown. */
export function fieldProblems(fields: string[], sent: SentKeys): Record<string, string[]> {
  const problems: Record<string, string[]> = {}
  for (const path of fields) {
    const [head, second, ...rest] = path.split('.')
    if (head === 'receipt') {
      const field = second === 'store_id' ? 'store' : second
      if (headerFields.includes(field)) push(problems, `receipt.${field}`, problemTexts.field)
    } else if (head === 'lines' || head === 'discounts' || head === 'taxes') {
      const key = second !== undefined && /^\d+$/.test(second) ? sent[head][Number(second)] : undefined
      const field = rest.join('.')
      if (key === undefined) push(problems, head, problemTexts.list)
      else if (rowFields[head].includes(field)) push(problems, `${head}.${key}.${field}`, problemTexts.field)
      else push(problems, `${head}.${key}`, problemTexts.row)
    }
  }
  return problems
}

/** Texts of a field; `tax_rate` of a row is shown at its kind. */
export function problemsAt(state: ReviewState, ...ids: string[]): string[] {
  return ids.flatMap((id) => state.problems[id] ?? [])
}

function cleared(problems: Record<string, string[]>, base: string, props: string[], row: boolean): Record<string, string[]> {
  const ids = new Set(props.flatMap((prop) => {
    const id = `${base}.${fieldNames[prop] ?? prop}`
    return prop === 'taxKind' || prop === 'taxRate' ? [id, `${base}.tax_rate`, `${base}.tax_rate.rate`] : [id]
  }))
  if (row) ids.add(base)
  return Object.fromEntries(Object.entries(problems).filter(([id]) => !ids.has(id)))
}
const without = (problems: Record<string, string[]>, prefix: string) => Object.fromEntries(
  Object.entries(problems).filter(([id]) => id !== prefix && !id.startsWith(`${prefix}.`)))
const numbers = (values: number[]) => values.join(', ')

export function reviewReducer(state: ReviewState, edit: ReviewEdit): ReviewState {
  const notice = (text: string, focus: string | null) => ({ id: state.notice.id + 1, text, focus })
  switch (edit.type) {
    case 'header': return { ...state, header: { ...state.header, ...edit.patch }, problems: cleared(state.problems, 'receipt', Object.keys(edit.patch), false) }
    case 'line': {
      const patch = { ...edit.patch }
      const current = state.lines.find((line) => line.key === edit.key)
      if (!current) return state
      const kind = patch.kind ?? current.kind
      if (kind !== 'deposit') patch.parent = null
      if (patch.taxKind !== undefined && patch.taxKind !== 'vat') patch.taxRate = ''
      // Only a product line can carry a deposit: its deposits lose the link together with its kind.
      const orphans = kind === 'product' ? [] : state.lines.filter((line) => line.parent === edit.key)
      const lines = state.lines.map((line) => line.key === edit.key ? { ...line, ...patch } : line.parent === edit.key && orphans.length ? { ...line, parent: null } : line)
      return {
        ...state, lines, problems: cleared(state.problems, rowField('lines', edit.key), Object.keys(patch), true),
        ...(orphans.length > 0 && { notice: notice(`Строка больше не товар: снята связь залога (строки ${numbers(orphans.map((line) => state.lines.indexOf(line) + 1))}).`, rowField('lines', edit.key, 'kind')) }),
      }
    }
    case 'discount': return {
      ...state, discounts: state.discounts.map((discount) => discount.key === edit.key ? { ...discount, ...edit.patch } : discount),
      problems: cleared(state.problems, rowField('discounts', edit.key), Object.keys(edit.patch), true),
    }
    case 'tax': {
      const patch = { ...edit.patch }
      if (patch.taxKind !== undefined && patch.taxKind !== 'vat') patch.taxRate = ''
      return {
        ...state, taxes: state.taxes.map((tax) => tax.key === edit.key ? { ...tax, ...patch } : tax),
        problems: cleared(state.problems, rowField('taxes', edit.key), Object.keys(patch), true),
      }
    }
    case 'add': {
      const key = state.nextKey
      const added = { ...state, nextKey: key + 1, problems: without(state.problems, edit.list) }
      if (edit.list === 'lines') return { ...added, lines: [...state.lines, emptyLine(key)], notice: notice(`Добавлена строка ${state.lines.length + 1}.`, rowField('lines', key, 'name')) }
      if (edit.list === 'discounts') return {
        ...added, discounts: [...state.discounts, { key, line: null, name: '', amount: '' }],
        notice: notice(`Добавлена скидка ${state.discounts.length + 1}.`, rowField('discounts', key, 'name')),
      }
      return {
        ...added, taxes: [...state.taxes, { key, taxKind: 'vat', taxRate: '', taxCode: '', net: '', tax: '', gross: '' }],
        notice: notice(`Добавлен налоговый итог ${state.taxes.length + 1}.`, rowField('taxes', key, 'taxKind')),
      }
    }
    case 'remove': {
      const index = state[edit.list].findIndex((row) => row.key === edit.key)
      if (index < 0) return state
      const problems = without(state.problems, rowField(edit.list, edit.key))
      const removed = `${rowNames[edit.list]} ${index + 1} удален${edit.list === 'taxes' ? '' : 'а'}.`
      if (edit.list === 'discounts') return { ...state, discounts: state.discounts.filter((row) => row.key !== edit.key), problems, notice: notice(removed, null) }
      if (edit.list === 'taxes') return { ...state, taxes: state.taxes.filter((row) => row.key !== edit.key), problems, notice: notice(removed, null) }
      // References never point at a missing row: a deposit loses its link, a line discount becomes a receipt discount.
      const lines = state.lines.filter((line) => line.key !== edit.key).map((line) => line.parent === edit.key ? { ...line, parent: null } : line)
      const deposits = lines.flatMap((line, at) => state.lines.find((old) => old.key === line.key)?.parent === edit.key ? [at + 1] : [])
      const loose = state.discounts.flatMap((discount, at) => discount.line === edit.key ? [at + 1] : [])
      return {
        ...state, lines, discounts: state.discounts.map((discount) => discount.line === edit.key ? { ...discount, line: null } : discount), problems,
        notice: notice([removed, lines.length > index ? 'Следующие строки перенумерованы.' : '',
          deposits.length ? `Снята связь залога: строки ${numbers(deposits)}.` : '',
          loose.length ? `Скидки ${numbers(loose)} теперь относятся ко всему чеку.` : ''].filter(Boolean).join(' '), null),
      }
    }
    case 'missing': {
      const count = Object.keys(edit.problems).length
      return { ...state, problems: { ...state.problems, ...edit.problems }, notice: notice(`Запрос не отправлен: заполните обязательные поля (${count}).`, Object.keys(edit.problems)[0]) }
    }
    case 'refused': {
      // The answer describes the rows as they were sent; a row removed while waiting has no field to mark any more.
      const present = (problems: Record<string, string[]>) => Object.fromEntries(Object.entries(problems).filter(([id]) => {
        const [list, key] = id.split('.')
        return list === 'receipt' || key === undefined || (list in entityRows && state[list as ReviewList].some((row) => String(row.key) === key))
      }))
      if (edit.error.reason === 'review_invalid') return { ...state, issues: edit.error.issues ?? [], problems: present(issueProblems(edit.error.issues ?? [], edit.sent)) }
      if (edit.error.reason === 'invalid_parameter') return { ...state, problems: present(fieldProblems(edit.error.fields ?? [], edit.sent)) }
      return state
    }
  }
}
