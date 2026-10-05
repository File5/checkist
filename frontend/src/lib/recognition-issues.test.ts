import { describe, expect, it } from 'vitest'
import { publicPointer } from '../api/recognition-schema'
import { issue, taxEvidenceMissingIssues } from '../api/recognition-test-support'
import type { RecognitionCode, RecognitionIssue } from '../api/recognition-types'
import { fieldContext, groupIssues, issueView, plural } from './recognition-issues'
import { areaLabels, issueLabels, reasonLabels } from './recognition-labels'

const legacy = (code: RecognitionCode, field: string): RecognitionIssue => ({ code, field, message: 'private server message' })
const titles = (issues: RecognitionIssue[], status: Parameters<typeof groupIssues>[1] = 'imported') => groupIssues(issues, status).map((group) => group.title)

describe('fieldContext (same parsing as the server issue_context)', () => {
  it.each([
    ['/', 'receipt', null, null],
    ['/geometry', 'geometry', null, null], ['/bbox', 'geometry', null, 'bbox'], ['/quad', 'geometry', null, 'quad'],
    ['/rotation_degrees', 'geometry', null, 'rotation_degrees'], ['/clipped', 'geometry', null, 'clipped'],
    ['/identity', 'receipt', null, 'identity'], ['/total', 'receipt', null, 'total'],
    ['/currency', 'receipt', null, 'currency'], ['/currency_code', 'receipt', null, 'currency'],
    ['/merchant/brand_name', 'receipt', null, 'merchant_brand_name'], ['/store/address_raw', 'receipt', null, 'store_address_raw'],
    ['/lines', 'line', null, null], ['/lines/0', 'line', 0, null], ['/lines/0/tax_rate', 'line', 0, 'tax_rate'],
    ['/lines/0007/amount', 'line', 7, 'amount'], ['/lines/3/raw_name', 'line', 3, 'name'], ['/lines/9999/product', 'line', 9999, 'product'],
    ['/discounts/2/amount', 'discount', 2, 'amount'], ['/taxes/1', 'tax', 1, null], ['/taxes/0/gross', 'tax', 0, 'gross'],
    // Closed paths: the public answer has field="/", but the rule must match the server.
    ['/lines/3/product_hint', 'line', 3, 'product'], ['/lines/3/product_hint/package/unit', 'line', 3, 'product'],
    ['/lines/3/tax_rate/kind', 'line', 3, 'unknown'], ['/lines/12/secret', 'line', 12, 'unknown'],
    ['/taxes/0/tax_rate/kind', 'receipt', null, 'receipt_metadata'], ['/discounts/1/secret', 'receipt', null, 'receipt_metadata'],
    ['/receipt_number', 'receipt', null, 'receipt_metadata'], ['/fiscal/signature', 'receipt', null, 'receipt_metadata'],
    ['/merchant/tax_id/value', 'receipt', null, 'receipt_metadata'], ['/lines/12345/amount', 'receipt', null, 'receipt_metadata'],
    ['lines/0', 'unknown', null, 'unknown'], ['', 'unknown', null, 'unknown'], ['/Fiscal', 'unknown', null, 'unknown'],
    ['/a/b/c/d/e', 'unknown', null, 'unknown'], ['/lines/0/a/b/c/d/e', 'unknown', null, 'unknown'], ['/total\n', 'unknown', null, 'unknown'],
  ])('%s → %s, index %s, attribute %s', (field, entity, index, attribute) => {
    expect(fieldContext(field)).toEqual({ entity, index, position: null, attribute })
  })
  it.each([null, undefined, 7, {}, ['/total']])('treats non-string %j as unknown', (field) => {
    expect(fieldContext(field)).toEqual({ entity: 'unknown', index: null, position: null, attribute: 'unknown' })
  })
  it('has a label for every attribute the public pointer can produce', () => {
    const header = ['identity', 'geometry', 'bbox', 'quad', 'rotation_degrees', 'clipped', 'merchant', 'store', 'operation', 'currency', 'currency_code',
      'purchased_on', 'local_time', 'total', 'discount_total', 'prices_include_tax', 'merchant/country_code', 'merchant/brand_name',
      'store/country_code', 'store/name', 'store/address_raw', 'store/city']
    const columns = ['position', 'kind', 'parent_position', 'raw_name', 'name', 'product', 'quantity', 'unit', 'unit_price', 'amount', 'discount_amount',
      'tax_amount', 'tax_code', 'tax_rate', 'net', 'tax', 'gross', 'line_position', 'barcode', 'store_item_code', 'is_excise', 'is_marked']
    const paths = [...header.map((name) => `/${name}`), ...['lines', 'discounts', 'taxes'].flatMap((name) => columns.map((column) => `/${name}/0/${column}`))]
    for (const path of paths) {
      expect(publicPointer.test(path), path).toBe(true)
      const { attribute } = fieldContext(path)
      if (path !== '/geometry') expect(areaLabels[attribute ?? ''], path).toBeTruthy()
    }
    expect(areaLabels.receipt_metadata).toBe('Реквизиты чека')
  })
})

describe('plural forms', () => {
  it.each([[1, 'one'], [2, 'few'], [3, 'few'], [4, 'few'], [5, 'many'], [10, 'many'], [11, 'many'], [12, 'many'], [14, 'many'],
    [20, 'many'], [21, 'one'], [22, 'few'], [25, 'many'], [100, 'many'], [101, 'one'], [111, 'many'], [112, 'many'], [1000, 'many'],
  ])('%i → %s', (count, form) => expect(plural(count, 'one', 'few', 'many')).toBe(form))
  const omitted = (count: number, context: Parameters<typeof issue>[2]) => Array.from({ length: count }, (_, index) =>
    issue('optional_omitted', 'warning', { ...context, ...(context?.entity ? { index } : {}) }))
  it.each([
    [1, 'НДС не использован в 1 строке'], [2, 'НДС не использован в 2 строках'], [5, 'НДС не использован в 5 строках'],
    [11, 'НДС не использован в 11 строках'], [21, 'НДС не использован в 21 строке'], [25, 'НДС не использован в 25 строках'],
  ])('line tax rate %i → %s', (count, title) => expect(titles(omitted(count, { entity: 'line', attribute: 'tax_rate' }))).toEqual([title]))
  it.each([
    [1, 'Пропущен 1 налоговый итог'], [2, 'Пропущены 2 налоговых итога'], [5, 'Пропущено 5 налоговых итогов'],
    [11, 'Пропущено 11 налоговых итогов'], [21, 'Пропущен 21 налоговый итог'], [25, 'Пропущено 25 налоговых итогов'],
  ])('tax totals %i → %s', (count, title) => expect(titles(omitted(count, { entity: 'tax' }))).toEqual([title]))
  it.each([
    [1, 'Не прочитан 1 реквизит'], [2, 'Не прочитаны 2 реквизита'], [5, 'Не прочитано 5 реквизитов'],
    [11, 'Не прочитано 11 реквизитов'], [21, 'Не прочитан 21 реквизит'], [25, 'Не прочитано 25 реквизитов'],
  ])('requisites %i → %s', (count, title) => expect(titles(omitted(count, { attribute: 'receipt_metadata' }))).toEqual([title]))
})

describe('groupIssues', () => {
  it('turns 29 omissions into three groups 25 + 2 + 2 with exact texts', () => {
    expect(groupIssues(taxEvidenceMissingIssues(), 'imported').map(({ key, ...group }) => { void key; return group })).toEqual([
      { severity: 'warning', reason: 'optional_omitted', entity: 'line', attribute: 'tax_rate', count: 25, title: 'НДС не использован в 25 строках',
        explanation: 'Распознавание не подтвердило чтение ставки, поэтому ставка не сохранена. Остальные данные строк сохранены.',
        locations: [`Строки: ${Array.from({ length: 25 }, (_, index) => index + 1).join(', ')}`] },
      { severity: 'warning', reason: 'optional_omitted', entity: 'tax', attribute: null, count: 2, title: 'Пропущены 2 налоговых итога',
        explanation: 'Налоговый итог не сохранён: ставка не подтверждена или суммы не сходятся.', locations: ['Налоговые итоги №: 1, 2'] },
      { severity: 'warning', reason: 'optional_omitted', entity: 'receipt', attribute: 'receipt_metadata', count: 2, title: 'Не прочитаны 2 реквизита',
        explanation: 'Необязательные реквизиты чека не прочитаны уверенно и не сохранены. Значения не показываются.', locations: [] },
    ])
  })
  it('reads the fixture in the order of the real server: 2 requisites, 25 line rates, 2 tax totals', () => {
    expect(taxEvidenceMissingIssues().map((item) => item.field)).toEqual([
      '/', '/', ...Array.from({ length: 25 }, (_, index) => `/lines/${index}/tax_rate`), '/taxes/0', '/taxes/1'])
  })
  it('puts line rates, tax totals and requisites in this order for any order of the answer', () => {
    const issues = taxEvidenceMissingIssues()
    const [requisites, lines, taxes] = [issues.slice(0, 2), issues.slice(2, 27), issues.slice(27)]
    const mixed = [lines[24], taxes[1], requisites[0], ...lines.slice(0, 24).reverse(), requisites[1], taxes[0]]
    for (const order of [issues, [...issues].reverse(), [...taxes, ...requisites, ...lines], [...lines, ...taxes, ...requisites], mixed]) {
      const groups = groupIssues(order, 'imported')
      expect(groups.map((group) => group.title)).toEqual(['НДС не использован в 25 строках', 'Пропущены 2 налоговых итога', 'Не прочитаны 2 реквизита'])
      expect(groups.map((group) => group.locations)).toEqual([
        [`Строки: ${Array.from({ length: 25 }, (_, index) => index + 1).join(', ')}`], ['Налоговые итоги №: 1, 2'], []])
    }
  })
  it('keeps other groups after the three known ones by first occurrence, inside each severity block', () => {
    const clipped = issue('clipped', 'warning', { entity: 'geometry', attribute: 'clipped' }, { code: 'clipped', field: '/clipped' })
    const barcode = issue('optional_omitted', 'warning', { entity: 'line', index: 0, position: 1, attribute: 'barcode' }, { field: '/lines/0/barcode' })
    const groups = groupIssues([
      issue('operation_defaulted', 'info', { attribute: 'operation' }),
      issue('optional_omitted', 'info', { attribute: 'receipt_metadata' }),
      issue('optional_omitted', 'warning', { attribute: 'receipt_metadata' }),
      clipped,
      issue('optional_omitted', 'warning', { entity: 'tax', index: 0 }, { field: '/taxes/0' }),
      barcode,
      issue('optional_omitted', 'warning', { entity: 'line', index: 0, position: 1, attribute: 'tax_rate' }, { field: '/lines/0/tax_rate' }),
      issue('total_mismatch', 'error', { attribute: 'total' }, { code: 'total_mismatch', field: '/total' }),
      issue('optional_omitted', 'info', { entity: 'line', index: 1, position: 2, attribute: 'tax_rate' }, { field: '/lines/1/tax_rate' }),
    ], 'needs_review')
    expect(groups.map((group) => [group.severity, group.title])).toEqual([
      ['error', 'Сумма строк не совпадает с итогом · Итого'],
      ['warning', 'НДС не использован в 1 строке'], ['warning', 'Пропущен 1 налоговый итог'], ['warning', 'Не прочитан 1 реквизит'],
      ['warning', 'Часть чека обрезана · Обрезанный чек'], ['warning', 'Необязательное поле не использовано · Штрихкод'],
      ['info', 'НДС не использован в 1 строке'], ['info', 'Не прочитан 1 реквизит'], ['info', 'Тип операции определён автоматически · Операция'],
    ])
    expect(titles([barcode, clipped])).toEqual(['Необязательное поле не использовано · Штрихкод', 'Часть чека обрезана · Обрезанный чек'])
  })
  it('orders error, warning, info and keeps the first occurrence inside a block', () => {
    const groups = groupIssues([
      issue('currency_inferred', 'info', { attribute: 'currency' }),
      issue('optional_omitted', 'warning', { attribute: 'receipt_metadata' }),
      issue('total_mismatch', 'error', { attribute: 'total' }, { code: 'total_mismatch', field: '/total' }),
      issue('clipped', 'warning', { entity: 'geometry', attribute: 'clipped' }, { code: 'clipped', field: '/clipped' }),
      issue('missing_required', 'error', { entity: 'line', index: 0, position: 1, attribute: 'quantity' }, { code: 'missing_required', field: '/lines/0/quantity' }),
      issue('optional_omitted', 'warning', { attribute: 'receipt_metadata' }),
      issue('total_mismatch', 'error', { attribute: 'total' }, { code: 'total_mismatch', field: '/total' }),
    ], 'needs_review')
    expect(groups.map((group) => [group.severity, group.title])).toEqual([
      ['error', 'Сумма строк не совпадает с итогом · Итого (2)'], ['error', 'Не удалось прочитать обязательное поле · Количество'],
      ['warning', 'Не прочитаны 2 реквизита'], ['warning', 'Часть чека обрезана · Обрезанный чек'],
      ['info', 'Валюта определена по стране магазина · Валюта'],
    ])
    expect(groups[1].locations).toEqual(['Строки: 1'])
  })
  it('separates groups by each part of the key', () => {
    expect(titles([
      issue('optional_omitted', 'warning', { entity: 'line', index: 0, position: 1, attribute: 'tax_rate' }),
      issue('optional_omitted', 'warning', { entity: 'line', index: 0, position: 1, attribute: 'barcode' }),
      issue('tax_rate_unconfirmed', 'warning', { entity: 'line', index: 0, position: 1, attribute: 'tax_rate' }),
      issue('optional_omitted', 'warning', { entity: 'discount', index: 0, position: 1, attribute: 'tax_rate' }),
      issue('tax_rate_unconfirmed', 'error', { entity: 'line', index: 1, position: 2, attribute: 'tax_rate' }),
    ])).toEqual([
      'Ставка налога не подтверждена · Ставка налога', 'НДС не использован в 1 строке', 'Необязательное поле не использовано · Штрихкод',
      'Ставка налога не подтверждена · Ставка налога', 'Необязательное поле не использовано · Ставка налога',
    ])
  })
  it('lists printed positions instead of index + 1 and falls back to recognition numbers', () => {
    const line = (index: number, position: number | null) => issue('optional_omitted', 'warning', { entity: 'line', index, position, attribute: 'tax_rate' })
    expect(groupIssues([line(0, 10), line(1, 12), line(2, 3)], 'imported')[0].locations).toEqual(['Строки: 3, 10, 12'])
    expect(groupIssues([line(3, null), line(6, null)], 'imported')[0].locations).toEqual(['Строки распознавания №: 4, 7'])
    expect(groupIssues([line(0, 5), line(3, null), line(0, 5)], 'imported')[0]).toMatchObject({ count: 3, locations: ['Строки: 5', 'Строки распознавания №: 4'] })
    const discount = (index: number, position: number | null) => issue('ambiguous_value', 'warning', { entity: 'discount', index, position, attribute: 'amount' })
    expect(groupIssues([discount(0, 2), discount(4, null)], 'imported')[0]).toMatchObject({
      title: 'Значение читается неоднозначно · Сумма (2)', explanation: null, locations: ['Скидки: 2', 'Скидки распознавания №: 5'] })
  })
  it('uses the generic title when a special group has no index and names whole entities', () => {
    expect(titles([issue('optional_omitted', 'warning', { entity: 'line', attribute: 'tax_rate' })])).toEqual(['Необязательное поле не использовано · Ставка налога'])
    expect(titles([issue('optional_omitted', 'warning', { entity: 'tax' })])).toEqual(['Необязательное поле не использовано · Налоги'])
    expect(titles([issue('receipt_line_conflict', 'warning', { entity: 'line', index: 2, position: 3 })])).toEqual(['Строка отличается от сохранённой · Строки'])
    expect(titles([issue('optional_omitted', 'warning', { entity: 'discount', index: 0, position: 1 })])).toEqual(['Необязательное поле не использовано · Скидки'])
    expect(titles([issue('geometry_requires_review', 'warning', { entity: 'geometry' })])).toEqual(['Границы чека требуют проверки · Границы чека'])
    expect(titles([issue('operation_defaulted', 'info', { attribute: 'operation' }), issue('import_failed', 'warning')])).toEqual([
      'Не удалось сохранить чек', 'Тип операции определён автоматически · Операция'])
  })
  it('shows unlisted reason, entity and attribute as unknown without their names', () => {
    const groups = groupIssues([
      issue('future_reason', 'warning', { entity: 'payment', index: 2, attribute: 'loyalty_card' }),
      issue('unknown', 'error', { entity: 'unknown', attribute: 'unknown' }),
      issue('future_reason', 'warning', { entity: 'line', index: 4, attribute: 'loyalty_card' }),
    ], 'needs_review')
    expect(groups.map((group) => [group.reason, group.entity, group.attribute, group.title, group.locations])).toEqual([
      ['unknown', 'unknown', 'unknown', 'Замечание распознавания', []],
      ['unknown', 'unknown', 'unknown', 'Замечание распознавания', []],
      ['unknown', 'line', 'unknown', 'Замечание распознавания · Строки', ['Строки распознавания №: 5']],
    ])
    expect(JSON.stringify(groups)).not.toMatch(/future_reason|payment|loyalty_card/)
  })
  it('has all 50 server reasons with the labels of the contract', () => {
    expect(Object.keys(reasonLabels)).toHaveLength(50)
    expect(Object.keys(issueLabels)).toHaveLength(28)
    expect(reasonLabels).toMatchObject({
      optional_omitted: 'Необязательное поле не использовано', operation_defaulted: 'Тип операции определён автоматически',
      currency_inferred: 'Валюта определена по стране магазина', ambiguous_value: 'Значение читается неоднозначно',
      country_unknown: 'Страна магазина не определена', currency_unknown: 'Валюта не определена',
      import_busy: 'Сохранение было занято другой обработкой', import_failed: 'Не удалось сохранить чек',
      merchant_conflict: 'Данные продавца противоречат известным', merchant_tax_id_invalid: 'Налоговый номер продавца не прошёл проверку',
      product_package_invalid: 'Данные упаковки товара не использованы', receipt_conflict: 'Данные противоречат сохранённому чеку',
      receipt_invalid: 'Сохранённый чек не прошёл дополнительную проверку', receipt_line_conflict: 'Строка отличается от сохранённой',
      receipt_structure_conflict: 'Состав чека отличается от сохранённого', store_ambiguous: 'Найдено несколько подходящих магазинов',
      store_conflict: 'Данные магазина противоречат известным', tax_rate_invalid: 'Ставка налога некорректна',
      tax_rate_unconfirmed: 'Ставка налога не подтверждена', timestamp_ambiguous: 'Местное время покупки неоднозначно',
      timestamp_conflict: 'Дата и смещение времени противоречат друг другу', unknown: 'Замечание распознавания',
    })
    expect(areaLabels.receipt_metadata).toBe('Реквизиты чека')
  })
})

describe('fallback for an answer of an old server', () => {
  it.each([['needs_review', 'error'], ['failed', 'error'], ['imported', 'warning'], ['reused', 'warning'], ['updated', 'warning'],
    ['pending', 'warning'], ['running', 'warning'], ['cancelled', 'warning'],
  ] as const)('status %s → severity %s', (status, severity) => {
    expect(issueView(legacy('missing_required', '/lines/2/quantity'), status)).toEqual({
      severity, reason: 'missing_required', entity: 'line', index: 2, position: null, attribute: 'quantity', legacy: true })
  })
  it('takes reason from code and labels invalid_value as a recognition note', () => {
    const issues = [...Array.from({ length: 25 }, (_, index) => legacy('invalid_value', `/lines/${index}/tax_rate`)),
      legacy('invalid_value', '/taxes/0'), legacy('invalid_value', '/taxes/1'), legacy('invalid_value', '/'), legacy('invalid_value', '/'),
      legacy('product_unmatched', '/lines/3/product')]
    const groups = groupIssues(issues, 'imported')
    expect(groups.map((group) => [group.severity, group.reason, group.title, group.locations])).toEqual([
      ['warning', 'invalid_value', 'Замечание распознавания · Ставка налога (25)', [`Строки распознавания №: ${Array.from({ length: 25 }, (_, index) => index + 1).join(', ')}`]],
      ['warning', 'invalid_value', 'Замечание распознавания · Налоги (2)', ['Налоговые итоги №: 1, 2']],
      ['warning', 'invalid_value', 'Замечание распознавания (2)', []],
      ['warning', 'product_unmatched', 'Товар не сопоставлен · Товар', ['Строки распознавания №: 4']],
    ])
    expect(groups.every((group) => group.explanation === null)).toBe(true)
    expect(JSON.stringify(groups)).not.toContain('private server message')
  })
  it('keeps the own label of invalid_value in the new answer and does not mix it with the old one', () => {
    const full = issue('invalid_value', 'error', { attribute: 'total' }, { field: '/total' })
    expect(titles([full, legacy('invalid_value', '/total')], 'needs_review')).toEqual(['Некорректное значение · Итого', 'Замечание распознавания · Итого'])
  })
  it('treats a partial set of keys, which the guard rejects, as the old answer', () => {
    const partial = { ...legacy('clipped', '/clipped'), reason: 'optional_omitted' }
    expect(issueView(partial, 'imported')).toMatchObject({ reason: 'clipped', severity: 'warning', entity: 'geometry', attribute: 'clipped', legacy: true })
  })
})
