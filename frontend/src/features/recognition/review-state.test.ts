import { describe, expect, it } from 'vitest'
import { readError } from '../../api/http'
import type { NormalizedLine, NormalizedResult, ReceiptImageDetail } from '../../api/recognition'
import { isReceiptImageDetail, isReviewConfirmInput } from '../../api/recognition-schema'
import { issue, publicFixture } from '../../api/recognition-test-support'
import { addField, buildInput, createReview, decimalText, fieldProblems, issueProblems, missingRequired, problemTexts, reviewReducer, storeLabel } from './review-state'
import type { ReviewEdit, ReviewState } from './review-state'

function image(): ReceiptImageDetail { const value = publicFixture('receipt-image.json'); if (!isReceiptImageDetail(value)) throw new Error('Invalid fixture'); return value }
const start = () => createReview(image().normalized_result, image().issues)
const apply = (state: ReviewState, ...edits: ReviewEdit[]) => edits.reduce(reviewReducer, state)
const line = (position: number, patch: Partial<NormalizedLine> = {}): NormalizedLine => ({
  position, parent_position: null, kind: 'product', name: `ТОВАР ${position}`, unit: 'pcs', quantity: '1.000', unit_price: '1.0000', amount: '1.00',
  discount_amount: null, tax_amount: null, store_item_code: null, barcode: null, tax_code: 'A', is_excise: null, is_marked: null, tax_rate: { kind: 'vat', rate: '7.00' }, ...patch,
})
function result(lines: NormalizedLine[], patch: Partial<NormalizedResult> = {}): NormalizedResult {
  return { ...image().normalized_result!, lines, ...patch }
}

describe('request body from the recognized projection', () => {
  it('reproduces the request fixture of the server from the crop fixture and the edits of a person', () => {
    let state = start()
    const [first] = state.lines
    state = apply(state,
      { type: 'header', patch: { operation: '', total: '2,63' } },
      { type: 'line', key: first.key, patch: { quantity: '2', amount: '2,58', taxKind: 'vat', taxCode: 'A' } },
      { type: 'line', key: first.key, patch: { taxRate: '7' } },
      { type: 'add', list: 'lines' })
    const added = state.lines[1]
    state = apply(state,
      { type: 'line', key: added.key, patch: { kind: 'deposit', name: ' PFAND ', quantity: '1', unit: 'pcs', unitPrice: '0,25', amount: '0.25', taxKind: 'vat', taxCode: 'B' } },
      { type: 'line', key: added.key, patch: { parent: first.key, taxRate: '19,00' } },
      { type: 'add', list: 'discounts' }, { type: 'add', list: 'taxes' }, { type: 'add', list: 'taxes' })
    state = apply(state,
      { type: 'discount', key: state.discounts[0].key, patch: { name: 'Rabatt МОЛОКО', amount: '0,2', line: first.key } },
      { type: 'tax', key: state.taxes[0].key, patch: { taxRate: '7.00', taxCode: 'A', net: '2,22', tax: '0,16' } },
      { type: 'tax', key: state.taxes[1].key, patch: { taxRate: '19', taxCode: 'B', net: '0,21', tax: '0,04', gross: '0,25' } })
    const { input, sent } = buildInput(state)
    expect(input).toEqual(publicFixture('review-confirm-request.json'))
    expect(isReviewConfirmInput(input)).toBe(true)
    expect(Object.hasOwn(input.receipt, 'utc_offset')).toBe(false)
    expect(sent).toEqual({ lines: [first.key, added.key], discounts: [state.discounts[0].key], taxes: state.taxes.map((tax) => tax.key) })
  })
  it('sends untouched decimals of normalized_result character for character, never through a number', () => {
    const lines = [
      line(1, { quantity: '0.500', unit: 'kg', unit_price: '2.0000', amount: '1.00' }),
      line(2, { quantity: '-1.000', unit_price: '0.2500', amount: '-0.25', kind: 'deposit_return', tax_rate: { kind: 'exempt', rate: null } }),
      line(3, { quantity: '123456789.125', unit_price: '9999999999.9999', amount: '999999999999.99', tax_rate: { kind: 'vat', rate: '19.00' } }),
    ]
    const source = result(lines, {
      proposed_receipt: { ...image().normalized_result!.proposed_receipt, total: '999999999999.99' },
      discounts: [{ position: 1, line_position: 3, name: 'Rabatt', amount: '0.20' }],
      taxes: [{ tax_rate: { kind: 'vat', rate: '19.00' }, tax_code: 'B', net: '0.21', tax: '0.04', gross: null }],
    })
    const state = createReview(source, [])
    expect(state.lines[2]).toMatchObject({ quantity: '123456789,125', unitPrice: '9999999999,9999', amount: '999999999999,99' })
    const { input } = buildInput(state)
    for (const [index, sent] of input.lines.entries()) {
      for (const key of ['quantity', 'unit_price', 'amount', 'unit', 'kind', 'name', 'tax_code', 'tax_rate'] as const) expect(sent[key]).toEqual(lines[index][key])
      expect(sent.source_position).toBe(lines[index].position)
    }
    expect(input.receipt.total).toBe('999999999999.99')
    expect(input.discounts).toEqual([{ position: 1, line_position: 3, name: 'Rabatt', amount: '0.20' }])
    expect(input.taxes).toEqual(source.taxes)
    expect(JSON.stringify(input)).not.toMatch(/"(?:quantity|unit_price|amount|total|net|tax|gross|rate)":-?\d/)
  })
  it.each([
    ['1', 2, '1.00'], ['1,5', 2, '1.50'], ['1.50', 2, '1.50'], [' 1 234,5 ', 2, '1234.50'], ['1 234,50', 2, '1234.50'], ['-0,25', 2, '-0.25'],
    ['2', 3, '2.000'], ['0,5', 3, '0.500'], ['1,29', 4, '1.2900'], ['1.2900', 4, '1.2900'], ['1,2900000', 4, '1.2900'], ['7', 2, '7.00'], ['', 2, null], ['   ', 3, null],
    // What cannot be brought to the format goes as typed: the server refuses the field by name.
    ['1,234', 2, '1.234'], ['abc', 2, 'abc'], ['1e3', 3, '1e3'], ['.5', 2, '.5'], ['1,2,3', 2, '1,2,3'], ['+1', 2, '+1'],
    // More digits than a JS number keeps exactly.
    ['90071992547409931,10', 2, '90071992547409931.10'],
  ] as const)('normalizes typed text %j to %s places as %j', (text, places, expected) => { expect(decimalText(text, places)).toBe(expected) })
  it('sends nulls for empty optional fields, codes in upper case and the chosen store', () => {
    const state = apply(start(), { type: 'header', patch: {
      store: { id: 51, label: 'ID 51 · Same Chain' }, storeName: '  ', address: '', country: 'de', currency: ' eur ', pricesIncludeTax: '', localTime: ' 14:35:20 ', utcOffset: ' +02:00 ',
    } }, { type: 'line', key: 1, patch: { unit: '', unitPrice: '', taxCode: ' ' } })
    const { input } = buildInput(state)
    expect(input.receipt).toMatchObject({ store_id: 51, store_name: null, address: null, country: 'DE', currency: 'EUR', prices_include_tax: null, local_time: '14:35:20', utc_offset: '+02:00' })
    expect(input.lines[0]).toMatchObject({ quantity: null, unit: null, unit_price: null, amount: null, tax_rate: { kind: null, rate: null }, tax_code: null })
    expect(storeLabel({ id: 51, name: 'Same Chain', city: 'Berlin', country: 'DE', address: '', timezone: 'Europe/Berlin', receipts_count: 0 })).toBe('ID 51 · Same Chain · адрес неизвестен · Berlin · DE')
  })
  it('starts an empty form when the projection is absent and names what must be filled before a request', () => {
    const state = createReview(null, [])
    expect(state.lines).toHaveLength(1); expect(state.unread).toEqual([])
    expect(Object.keys(missingRequired(state)).sort()).toEqual(['lines.1.name', 'receipt.local_time', 'receipt.purchased_on', 'receipt.total'])
    const empty = apply(state, { type: 'remove', list: 'lines', key: 1 }, { type: 'add', list: 'discounts' }, { type: 'add', list: 'taxes' })
    const missing = missingRequired(apply(empty, { type: 'tax', key: empty.taxes[0].key, patch: { taxKind: '' } }))
    expect(missing.lines).toEqual([problemTexts.lines])
    expect(Object.keys(missing)).toEqual(expect.arrayContaining([`discounts.${empty.discounts[0].key}.name`, `discounts.${empty.discounts[0].key}.amount`, `taxes.${empty.taxes[0].key}.tax_rate.kind`]))
    const reported = reviewReducer(state, { type: 'missing', problems: missingRequired(state) })
    expect(reported.problems['receipt.total']).toEqual([problemTexts.required]); expect(reported.notice.text).toContain('Запрос не отправлен')
    expect(reported.notice.focus).toBe('receipt.purchased_on')
    expect(missingRequired(start())).toEqual({})
  })
  it('keeps an unreadable printed date out of the date field and marks unread fields', () => {
    const source = result([line(1, { position: null, name: null, kind: null })], { proposed_receipt: { ...image().normalized_result!.proposed_receipt, purchased_on: '2026-02-30', total: null, prices_include_tax: null } })
    const state = createReview(source, [])
    expect(state.header).toMatchObject({ purchasedOn: '', total: '', pricesIncludeTax: '' })
    expect(state.unread).toEqual(expect.arrayContaining(['receipt.purchased_on', 'receipt.total', 'receipt.prices_include_tax', 'lines.1.name', 'lines.1.kind']))
    expect(state.lines[0]).toMatchObject({ source: null, kind: '', name: '' })
    expect(start().unread).toEqual(expect.arrayContaining(['lines.1.quantity', 'lines.1.amount', 'lines.1.tax_rate.kind', 'lines.1.tax_code']))
    expect(start().unread).not.toContain('lines.1.unit_price')
  })
})

describe('rows and their references', () => {
  const source = () => result([line(1), line(2, { kind: 'deposit', parent_position: 1, name: 'PFAND' }), line(3), line(4, { kind: 'deposit', parent_position: 3 })], {
    discounts: [{ position: 1, line_position: 3, name: 'Rabatt C', amount: '0.10' }, { position: 2, line_position: 1, name: 'Rabatt A', amount: '0.20' }, { position: 3, line_position: null, name: 'Karte', amount: '0.30' }],
  })
  it('renumbers positions after a removal and never leaves a reference to a missing line', () => {
    const before = createReview(source(), [])
    expect(buildInput(before).input.lines.map((item) => [item.position, item.source_position, item.parent_position])).toEqual([[1, 1, null], [2, 2, 1], [3, 3, null], [4, 4, 3]])
    const state = reviewReducer(before, { type: 'remove', list: 'lines', key: before.lines[0].key })
    const { input } = buildInput(state)
    expect(input.lines.map((item) => [item.position, item.source_position, item.parent_position, item.name])).toEqual([[1, 2, null, 'PFAND'], [2, 3, null, 'ТОВАР 3'], [3, 4, 2, 'ТОВАР 4']])
    expect(input.discounts.map((item) => [item.position, item.line_position])).toEqual([[1, 2], [2, null], [3, null]])
    expect(state.notice).toMatchObject({ focus: `lines.${before.lines[1].key}.name`, text: 'Строка 1 удалена. Следующие строки перенумерованы. Снята связь залога: строки 1. Скидки 2 теперь относятся ко всему чеку.' })
    expect(isReviewConfirmInput(input)).toBe(true)
  })
  it('gives a new line the next position, no source and focus, and renumbers discounts and taxes', () => {
    const before = createReview(source(), [])
    const state = apply(before, { type: 'add', list: 'lines' }, { type: 'remove', list: 'discounts', key: before.discounts[0].key }, { type: 'add', list: 'discounts' })
    const added = state.lines.at(-1)!
    expect(new Set([...state.lines, ...state.discounts].map((row) => row.key)).size).toBe(state.lines.length + state.discounts.length)
    expect(added).toMatchObject({ source: null, kind: 'product', parent: null })
    const { input } = buildInput(apply(state, { type: 'line', key: added.key, patch: { name: 'NEU', amount: '1' } },
      { type: 'discount', key: state.discounts.at(-1)!.key, patch: { name: 'Neu', amount: '1', line: added.key } }))
    expect(input.lines.at(-1)).toMatchObject({ position: 5, source_position: null, name: 'NEU', amount: '1.00' })
    expect(input.discounts.map((item) => [item.position, item.line_position, item.name])).toEqual([[1, 1, 'Rabatt A'], [2, null, 'Karte'], [3, 5, 'Neu']])
    expect(apply(before, { type: 'add', list: 'lines' }).notice).toMatchObject({ text: 'Добавлена строка 5.', focus: `lines.${added.key}.name` })
    expect(apply(before, { type: 'add', list: 'taxes' }).notice.text).toBe('Добавлен налоговый итог 1.')
    expect(apply(before, { type: 'remove', list: 'discounts', key: before.discounts[1].key }).notice).toMatchObject({ text: 'Скидка 2 удалена.', focus: `discounts.${before.discounts[2].key}.name` })
  })
  describe('focus after a removal stays at the place of the edit, never on the announcement at the end of the form', () => {
    const three = () => {
      const state = apply(createReview(result([line(1), line(2), line(3)], { discounts: [1, 2, 3].map((position) => ({ position, line_position: null, name: `Rabatt ${position}`, amount: '0.10' })) }), []),
        { type: 'add', list: 'taxes' }, { type: 'add', list: 'taxes' }, { type: 'add', list: 'taxes' })
      expect([state.lines.length, state.discounts.length, state.taxes.length]).toEqual([3, 3, 3])
      return state
    }
    const first = { lines: 'name', discounts: 'name', taxes: 'tax_rate.kind' } as const
    const texts = { lines: 'Строка', discounts: 'Скидка', taxes: 'Налоговый итог' } as const
    const gone = { lines: 'удалена.', discounts: 'удалена.', taxes: 'удалён.' } as const
    it.each(['lines', 'discounts', 'taxes'] as const)('%s: removed from the middle → the first field of the row that took its place', (list) => {
      const before = three()
      const state = reviewReducer(before, { type: 'remove', list, key: before[list][1].key })
      expect(state[list].map((row) => row.key)).toEqual([before[list][0].key, before[list][2].key])
      expect(state.notice.focus).toBe(`${list}.${before[list][2].key}.${first[list]}`)
      expect(state.notice.text).toContain(`${texts[list]} 2 ${gone[list]}`); expect(state.notice.id).toBe(before.notice.id + 1)
    })
    it.each(['lines', 'discounts', 'taxes'] as const)('%s: removed the last → the first field of the previous row', (list) => {
      const before = three()
      const state = reviewReducer(before, { type: 'remove', list, key: before[list][2].key })
      expect(state.notice.focus).toBe(`${list}.${before[list][1].key}.${first[list]}`)
      expect(state.notice.text).toContain(`${texts[list]} 3 ${gone[list]}`); expect(state.notice.text).not.toContain('перенумерованы')
    })
    it.each(['lines', 'discounts', 'taxes'] as const)('%s: the list became empty → its «Добавить …» button', (list) => {
      const before = three()
      const state = apply(before, ...before[list].map((row): ReviewEdit => ({ type: 'remove', list, key: row.key })))
      expect(state[list]).toEqual([]); expect(state.notice.focus).toBe(addField(list))
      expect(state.notice.text).toContain(`${texts[list]} 1 ${gone[list]}`)
    })
    it('keeps announcing what the removal changed while focus goes to the next row', () => {
      const before = createReview(source(), [])
      const state = reviewReducer(before, { type: 'remove', list: 'lines', key: before.lines[2].key })
      expect(state.notice).toEqual({ id: 1, focus: `lines.${before.lines[3].key}.name`, text: 'Строка 3 удалена. Следующие строки перенумерованы. Снята связь залога: строки 3. Скидки 1 теперь относятся ко всему чеку.' })
    })
    it('does nothing for a row that is already gone', () => {
      const before = three()
      expect(reviewReducer(before, { type: 'remove', list: 'taxes', key: 999 })).toBe(before)
    })
  })
  it('drops the deposit link when either side stops fitting it', () => {
    const before = createReview(source(), [])
    const [product, deposit] = before.lines
    const service = reviewReducer(before, { type: 'line', key: product.key, patch: { kind: 'service' } })
    expect(service.lines[1].parent).toBeNull(); expect(service.notice.text).toContain('снята связь залога (строки 2)')
    expect(buildInput(service).input.lines[1].parent_position).toBeNull()
    const noDeposit = reviewReducer(before, { type: 'line', key: deposit.key, patch: { kind: 'product' } })
    expect(noDeposit.lines[1].parent).toBeNull()
    expect(reviewReducer(before, { type: 'line', key: deposit.key, patch: { name: 'PFAND 2' } }).lines[1].parent).toBe(product.key)
  })
  it('keeps a reference only to a uniquely printed position and clears the rate with its kind', () => {
    const state = createReview(result([line(1), line(1), line(3, { kind: 'deposit', parent_position: 1 })], { discounts: [{ position: 1, line_position: 1, name: 'R', amount: '0.10' }] }), [])
    expect(state.lines.map((item) => item.source)).toEqual([null, null, 3])
    expect(state.lines[2].parent).toBeNull(); expect(state.discounts[0].line).toBeNull()
    const exempt = reviewReducer(state, { type: 'line', key: 1, patch: { taxKind: 'exempt' } })
    expect(exempt.lines[0]).toMatchObject({ taxKind: 'exempt', taxRate: '' })
    expect(buildInput(exempt).input.lines[0].tax_rate).toEqual({ kind: 'exempt', rate: null })
  })
})

describe('«Запрос не отправлен…» leaves as soon as it stops being true, without moving focus', () => {
  const stopped = () => {
    const state = apply(start(), { type: 'add', list: 'discounts' }, { type: 'add', list: 'taxes' }, { type: 'header', patch: { total: '' } })
    const reported = reviewReducer(state, { type: 'missing', problems: missingRequired(state) })
    expect(reported.notice).toEqual({ id: state.notice.id + 1, text: 'Запрос не отправлен: заполните обязательные поля (3).', focus: 'receipt.total' })
    expect(reported.unsent).toBe(true)
    return reported
  }
  const erased = (before: ReviewState, after: ReviewState) => {
    expect(after.notice).toEqual({ id: before.notice.id, text: '', focus: before.notice.focus }); expect(after.unsent).toBe(false)
  }
  it.each([
    ['the header', (state: ReviewState): ReviewEdit => ({ type: 'header', patch: { total: state.header.total + '9' } })],
    ['another field of the header', (): ReviewEdit => ({ type: 'header', patch: { address: 'Teststrasse 13' } })],
    ['a line', (state: ReviewState): ReviewEdit => ({ type: 'line', key: state.lines[0].key, patch: { quantity: '2' } })],
    ['a discount', (state: ReviewState): ReviewEdit => ({ type: 'discount', key: state.discounts[0].key, patch: { name: 'Rabatt' } })],
    ['a tax total', (state: ReviewState): ReviewEdit => ({ type: 'tax', key: state.taxes[0].key, patch: { net: '1' } })],
  ])('at the first edit of %s', (_name, edit) => {
    const reported = stopped()
    erased(reported, reviewReducer(reported, edit(reported)))
  })
  it('at the real request, also when nothing was edited in between, and stays away after its refusal', () => {
    const reported = stopped()
    const filled = apply(reported, { type: 'header', patch: { total: '9,99' } }, { type: 'discount', key: reported.discounts[0].key, patch: { name: 'Rabatt', amount: '0,10' } })
    expect(missingRequired(filled)).toEqual({})
    const sent = reviewReducer(filled, { type: 'sent' })
    erased(reported, sent); expect(sent).toBe(filled)
    erased(reported, reviewReducer(reported, { type: 'sent' }))
    const error = readError(409, publicFixture('review-invalid.json'), true)
    const refused = reviewReducer(sent, { type: 'refused', error, sent: buildInput(sent).sent })
    erased(reported, refused)
    // missing → edit → request → refusal → edit of the marked field → request: nothing brings the text back.
    erased(reported, apply(refused, { type: 'header', patch: { total: '2,63' } }, { type: 'sent' }))
  })
  it('gives its place to the announcement of an added or removed row and is announced again by the next stopped press', () => {
    const reported = stopped()
    const added = reviewReducer(reported, { type: 'add', list: 'lines' })
    expect(added.notice).toEqual({ id: reported.notice.id + 1, text: 'Добавлена строка 2.', focus: `lines.${added.lines[1].key}.name` }); expect(added.unsent).toBe(false)
    const removed = reviewReducer(reported, { type: 'remove', list: 'taxes', key: reported.taxes[0].key })
    expect(removed.notice).toEqual({ id: reported.notice.id + 1, text: 'Налоговый итог 1 удалён.', focus: addField('taxes') }); expect(removed.unsent).toBe(false)
    // The announcement of a row action is a fact that stays true: an edit and a request leave it alone.
    expect(apply(removed, { type: 'header', patch: { total: '1' } }, { type: 'sent' }).notice).toBe(removed.notice)
    const edited = reviewReducer(reported, { type: 'header', patch: { address: 'x' } })
    const again = reviewReducer(edited, { type: 'missing', problems: missingRequired(edited) })
    expect(again.notice).toEqual({ id: reported.notice.id + 1, text: reported.notice.text, focus: 'receipt.total' }); expect(again.unsent).toBe(true)
  })
  it('does not touch a form without that text', () => {
    const state = start()
    expect(reviewReducer(state, { type: 'sent' })).toBe(state)
    expect(reviewReducer(state, { type: 'header', patch: { total: '1' } }).notice).toBe(state.notice)
  })
  it('names «Добавить строку» as the place of focus when the header is filled and the list of lines is empty', () => {
    const empty = reviewReducer(start(), { type: 'remove', list: 'lines', key: 1 })
    expect(missingRequired(empty)).toEqual({ lines: [problemTexts.lines] })
    const reported = reviewReducer(empty, { type: 'missing', problems: missingRequired(empty) })
    expect(reported.notice).toEqual({ id: empty.notice.id + 1, text: 'Запрос не отправлен: заполните обязательные поля (1).', focus: addField('lines') })
    expect(reported.problems.lines).toEqual([problemTexts.lines])
    // The button cures it: the text about the empty list and the announcement leave with the added line.
    const added = reviewReducer(reported, { type: 'add', list: 'lines' })
    expect(added.problems.lines).toBeUndefined(); expect(added.notice.text).toBe('Добавлена строка 1.')
    // An empty header field comes first: it is a field of the document and takes focus itself.
    const headless = reviewReducer(empty, { type: 'header', patch: { total: '' } })
    expect(reviewReducer(headless, { type: 'missing', problems: missingRequired(headless) }).notice.focus).toBe('receipt.total')
  })
})

describe('causes and refused paths at the fields', () => {
  it('ties the recognition issue to its field and releases it when the person edits that field', () => {
    const state = start()
    expect(state.problems).toEqual({ 'lines.1.quantity': ['Не удалось прочитать обязательное поле'] })
    expect(reviewReducer(state, { type: 'line', key: 1, patch: { name: 'МОЛОКО 1 Л' } }).problems).toEqual(state.problems)
    expect(reviewReducer(state, { type: 'line', key: 1, patch: { quantity: '2' } }).problems).toEqual({})
    expect(state.issues).toEqual(image().issues)
  })
  it('replaces the causes after review_invalid and marks only blocking ones, without the server message', () => {
    const body = publicFixture('review-invalid.json')
    const error = readError(409, body, true)
    const sent = buildInput(start()).sent
    const state = reviewReducer(start(), { type: 'refused', error, sent })
    expect(state.issues).toEqual((body as { issues: unknown[] }).issues)
    expect(state.problems).toEqual({ 'receipt.total': ['Сумма строк не совпадает с итогом'] })
    expect(JSON.stringify(state.problems)).not.toContain('Сумма чека не совпадает')
    expect(reviewReducer(state, { type: 'header', patch: { total: '2,63' } }).problems).toEqual({})
    expect(state.header).toEqual(start().header); expect(state.lines).toEqual(start().lines)
  })
  it('maps indexes of the sent arrays to rows even when rows were removed or added afterwards', () => {
    const source = result([line(1), line(2), line(3)], { taxes: [{ tax_rate: { kind: 'vat', rate: '7.00' }, tax_code: 'A', net: '1.00', tax: '0.07', gross: '1.07' }] })
    const before = createReview(source, [])
    const { sent } = buildInput(before)
    const edited = apply(before, { type: 'remove', list: 'lines', key: before.lines[0].key }, { type: 'add', list: 'lines' })
    const issues = [
      issue('total_mismatch', 'error', { entity: 'line', index: 2, position: 3, attribute: 'amount' }, { code: 'total_mismatch', field: '/lines/2/amount' }),
      issue('missing_required', 'error', { entity: 'line', index: 1, position: 2, attribute: null }, { code: 'missing_required', field: '/lines/1' }),
      issue('invalid_value', 'error', { entity: 'tax', index: 0, attribute: 'tax_rate' }, { field: '/taxes/0/tax_rate' }),
      issue('missing_required', 'error', { entity: 'line', index: null, attribute: null }, { code: 'missing_required', field: '/lines' }),
      issue('optional_omitted', 'warning', { entity: 'line', index: 0, position: 1, attribute: 'tax_rate' }, { field: '/lines/0/tax_rate' }),
      issue('missing_required', 'error', { entity: 'line', index: 0, position: 1, attribute: 'name' }, { code: 'missing_required', field: '/lines/0/raw_name' }),
    ]
    const state = reviewReducer(edited, { type: 'refused', error: { kind: 'error', reason: 'review_invalid', status: 409, issues }, sent })
    expect(state.problems).toEqual({
      [`lines.${before.lines[2].key}.amount`]: ['Сумма строк не совпадает с итогом'], [`lines.${before.lines[1].key}`]: ['Не удалось прочитать обязательное поле'],
      // The row removed while waiting has no field left: its cause stays only in the list above the form.
      [`taxes.${before.taxes[0].key}.tax_rate`]: ['Некорректное значение'], lines: ['Не удалось прочитать обязательное поле'],
    })
    expect(state.issues).toHaveLength(6)
    expect(reviewReducer(state, { type: 'line', key: before.lines[1].key, patch: { name: 'x' } }).problems[`lines.${before.lines[1].key}`]).toBeUndefined()
    expect(reviewReducer(state, { type: 'tax', key: before.taxes[0].key, patch: { taxRate: '19' } }).problems[`taxes.${before.taxes[0].key}.tax_rate`]).toBeUndefined()
    expect(reviewReducer(state, { type: 'add', list: 'lines' }).problems.lines).toBeUndefined()
    // A new row cures only the text about the list: the marks of the other rows are still true.
    expect(reviewReducer(state, { type: 'add', list: 'lines' }).problems).toEqual(Object.fromEntries(Object.entries(state.problems).filter(([id]) => id !== 'lines')))
    expect(reviewReducer(state, { type: 'add', list: 'discounts' }).problems).toEqual(state.problems)
  })
  it('points store, country, currency and time causes at the field that cures them', () => {
    const sent = { lines: [], discounts: [], taxes: [] }
    const problems = issueProblems([
      issue('store_ambiguous', 'error', { attribute: 'store' }), issue('country_unknown', 'error', { attribute: 'store_country_code' }),
      issue('currency_unknown', 'error', { attribute: 'currency' }, { field: '/currency_code' }),
      issue('timestamp_ambiguous', 'error', { attribute: 'local_time' }, { field: '/local_time' }),
      issue('identity_conflict', 'error', { attribute: 'receipt_metadata' }, { code: 'identity_conflict' }),
      issue('future_reason', 'error', { entity: 'payment', attribute: 'loyalty_card' }), issue('operation_defaulted', 'info', { attribute: 'operation' }),
    ], sent)
    expect(problems).toEqual({
      'receipt.store': ['Найдено несколько подходящих магазинов'], 'receipt.country': ['Страна магазина не определена'], 'receipt.currency': ['Валюта не определена'],
      'receipt.local_time': ['Местное время покупки неоднозначно'], 'receipt.utc_offset': ['Местное время покупки неоднозначно'],
    })
    // An old server sends no reason and context: the field is found from its pointer.
    expect(issueProblems([{ code: 'missing_required', field: '/lines/0/quantity', message: 'x' }, { code: 'invalid_value', field: '/total', message: 'x' }], { ...sent, lines: [9] }))
      .toEqual({ 'lines.9.quantity': ['Не удалось прочитать обязательное поле'], 'receipt.total': ['Замечание распознавания'] })
  })
  it('marks the paths of invalid_parameter with a client text and keeps the causes', () => {
    const error = readError(400, publicFixture('review-invalid-parameter.json'), true)
    let state = apply(start(), { type: 'add', list: 'lines' }, { type: 'add', list: 'discounts' }, { type: 'add', list: 'taxes' }, { type: 'add', list: 'taxes' })
    const { sent } = buildInput(state)
    state = reviewReducer(state, { type: 'refused', error, sent })
    expect(state.problems).toEqual({
      'receipt.total': [problemTexts.field], [`lines.${sent.lines[0]}.quantity`]: [problemTexts.field], [`lines.${sent.lines[1]}`]: [problemTexts.row],
      [`discounts.${sent.discounts[0]}.line_position`]: [problemTexts.field], [`taxes.${sent.taxes[1]}.tax_rate.rate`]: [problemTexts.field],
    })
    expect(state.issues).toEqual(image().issues)
    expect(JSON.stringify(state.problems)).not.toMatch(/Неверный|обязательно|отсутствующую/)
    expect(fieldProblems(['receipt.store_id', 'lines', 'lines.7.name', 'taxes.0.tax_rate', 'receipt.unknown', 'draft'], { lines: [4], discounts: [], taxes: [6] }))
      .toEqual({ 'receipt.store': [problemTexts.field], lines: [problemTexts.list], 'taxes.6.tax_rate': [problemTexts.field] })
  })
  it.each(['review_busy', 'review_resolved', 'review_unavailable', 'job_active', 'network', 'timeout', 'csrf_failed', 'server'] as const)('leaves typed values and marks untouched after %s', (reason) => {
    const typed = apply(start(), { type: 'header', patch: { total: '2,63' } })
    expect(reviewReducer(typed, { type: 'refused', error: { kind: 'error', reason }, sent: buildInput(typed).sent })).toBe(typed)
  })
})
