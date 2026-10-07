import { describe, expect, it } from 'vitest'
import { statsErrorFixtures, statsFixture } from '../../api/stats-test-support'
import type { Spending } from '../../api/stats'
import { parseSpendingQuery } from '../../navigation/routes'
import type { SpendingQuery } from '../../navigation/routes'
import { applyMe } from '../../session'
import { resetSession } from '../../session/store'
import {
  activePreset, applyFilters, breadcrumbs, failureView, filterDraft, filterMessages, formReducer, groupingHref, hasFilters,
  hasScopeFilters, initForm, itemHref, localToday, needsAddressReset, periodText, presetHref, presetPeriod, resetFiltersHref, resetHref,
  sameDraft, serverFieldErrors, shownResult, spendingParams, upHref,
} from './spending-state'
import type { FilterDraft, SpendingFailure } from './spending-state'

const draft = (patch: Partial<FilterDraft> = {}): FilterDraft => ({ date_from: '', date_to: '', country: '', currency: '', store: [], ...patch })
const category = statsFixture('spending-category.json') as Spending
const drilldown = statsFixture('spending-category-drilldown.json') as Spending

describe('period presets', () => {
  it.each([
    ['this-month', '2026-10-07', { date_from: '2026-10-01', date_to: '2026-10-31' }],
    ['last-month', '2026-10-07', { date_from: '2026-09-01', date_to: '2026-09-30' }],
    ['last-month', '2026-01-15', { date_from: '2025-12-01', date_to: '2025-12-31' }],
    ['last-month', '2024-03-31', { date_from: '2024-02-01', date_to: '2024-02-29' }],
    ['last-month', '2100-03-01', { date_from: '2100-02-01', date_to: '2100-02-28' }],
    ['this-year', '2026-10-07', { date_from: '2026-01-01', date_to: '2026-12-31' }],
    ['last-year', '2026-10-07', { date_from: '2025-01-01', date_to: '2025-12-31' }],
    ['all', '2026-10-07', {}],
  ] as const)('%s on %s', (preset, today, period) => {
    expect(presetPeriod(preset, today)).toEqual(period)
  })
  it('takes the calendar date of the browser, not a UTC one', () => {
    expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })
  it('recognises the preset of an address and nothing for another period', () => {
    expect(activePreset({}, '2026-10-07')).toBe('all')
    expect(activePreset({ date_from: '2026-01-01', date_to: '2026-12-31' }, '2026-10-07')).toBe('this-year')
    expect(activePreset({ date_from: '2026-01-01', date_to: '2026-06-30' }, '2026-10-07')).toBeUndefined()
    expect(activePreset({ date_from: '2026-01-01' }, '2026-10-07')).toBeUndefined()
  })
  it('changes only the period: filters and the drill-down stay in the link', () => {
    const query: SpendingQuery = { date_from: '2020-01-01', country: 'DE', store: [3, 5], group_by: 'generic', category: 2 }
    expect(presetHref(query, 'last-year', '2026-10-07')).toBe('/stats?date_from=2025-01-01&date_to=2025-12-31&country=DE&store=3,5&group_by=generic&category=2')
    expect(presetHref(query, 'all', '2026-10-07')).toBe('/stats?country=DE&store=3,5&group_by=generic&category=2')
  })
})

describe('filter form', () => {
  it('turns a draft into the address through the route parser and keeps the drill-down', () => {
    const result = applyFilters({ group_by: 'product', category: 2, generic: 7, currency: 'KZT' },
      draft({ date_from: '2026-01-01', date_to: '2026-06-30', country: 'de', currency: 'EUR', store: [5, 3] }))
    expect(result.errors).toEqual({})
    expect(result.query).toEqual({ date_from: '2026-01-01', date_to: '2026-06-30', country: 'DE', currency: 'EUR', store: [3, 5], group_by: 'product', category: 2, generic: 7 })
    expect(applyFilters({ date_from: '2026-01-01', store: [1] }, draft())).toEqual({ query: {}, errors: {} })
  })
  it('marks both bounds of a reversed period and wrong codes without building a request', () => {
    expect(applyFilters({}, draft({ date_from: '2026-07-01', date_to: '2026-06-30' })).errors)
      .toEqual({ date_from: filterMessages.date_from, date_to: filterMessages.date_to })
    expect(applyFilters({}, draft({ date_to: '2026-02-30', country: 'DEU', currency: 'E1' })).errors)
      .toEqual({ date_to: filterMessages.date_to, country: filterMessages.country, currency: filterMessages.currency })
    expect(applyFilters({}, draft({ store: Array.from({ length: 21 }, (_, index) => index + 1) })).errors).toEqual({ store: filterMessages.store })
  })
  it('reads a draft back from the address', () => {
    const query = parseSpendingQuery('date_from=2026-01-01&country=de&store=5,3,5&group_by=store').query
    expect(filterDraft(query)).toEqual(draft({ date_from: '2026-01-01', country: 'DE', store: [3, 5] }))
    expect(sameDraft(filterDraft(query), draft({ date_from: '2026-01-01', country: 'DE', store: [3, 5] }))).toBe(true)
    expect(sameDraft(filterDraft(query), draft({ date_from: '2026-01-01', country: 'DE', store: [3] }))).toBe(false)
  })

  const start = initForm({ country: 'DE', store: [3] })
  it('edits the draft and forgets the error of the edited field', () => {
    const invalid = formReducer(start, { type: 'invalid', errors: { date_from: 'a', date_to: 'b', country: 'c', store: 'd' } })
    const edited = formReducer(invalid, { type: 'set', field: 'date_to', value: '2026-06-30' })
    expect(edited.draft.date_to).toBe('2026-06-30')
    expect(edited.errors).toEqual({ country: 'c', store: 'd' })
    expect(formReducer(invalid, { type: 'set', field: 'country', value: '' }).errors).toEqual({ date_from: 'a', date_to: 'b', store: 'd' })
    expect(formReducer(invalid, { type: 'toggle-store', id: 9 }).errors).toEqual({ date_from: 'a', date_to: 'b', country: 'c' })
    expect(start.draft).toEqual(draft({ country: 'DE', store: [3] }))
  })
  it('toggles stores in ascending order and stops at the limit of the API', () => {
    const added = formReducer(formReducer(start, { type: 'toggle-store', id: 9 }), { type: 'toggle-store', id: 1 })
    expect(added.draft.store).toEqual([1, 3, 9])
    expect(formReducer(added, { type: 'toggle-store', id: 3 }).draft.store).toEqual([1, 9])
    expect(formReducer(added, { type: 'clear-stores' }).draft.store).toEqual([])
    let full = initForm({})
    for (let id = 1; id <= 25; id++) full = formReducer(full, { type: 'toggle-store', id })
    expect(full.draft.store).toHaveLength(20)
    expect(full.draft.store.at(-1)).toBe(20)
    // A selected store can still be removed at the limit.
    expect(formReducer(full, { type: 'toggle-store', id: 20 }).draft.store).toHaveLength(19)
  })
  it('keeps unsaved edits on a re-render and replaces them when the address changes', () => {
    const edited = formReducer(start, { type: 'set', field: 'currency', value: 'EUR' })
    expect(formReducer(edited, { type: 'sync', query: { store: [3], country: 'DE' } })).toBe(edited)
    const moved = formReducer(formReducer(edited, { type: 'invalid', errors: { country: 'c' } }), { type: 'sync', query: { country: 'KZ' } })
    expect(moved).toEqual({ source: '?country=KZ', draft: draft({ country: 'KZ' }), errors: {} })
    expect(formReducer(edited, { type: 'reset' }).draft).toEqual(draft())
  })
  it('shows a server refusal on the applied value only until the person edits that field', () => {
    const failure: SpendingFailure = { kind: 'error', reason: 'invalid_parameter', status: 400, fields: statsErrorFixtures['error-invalid-parameter.json'].fields }
    const applied = draft({ country: 'ZZ', store: [404] })
    expect(serverFieldErrors(failure, applied, applied)).toEqual({
      date_from: filterMessages.date_from, country: filterMessages.country, currency: filterMessages.currency, store: filterMessages.store,
    })
    expect(serverFieldErrors(failure, { ...applied, country: 'DE', store: [] }, applied))
      .toEqual({ date_from: filterMessages.date_from, currency: filterMessages.currency })
    expect(serverFieldErrors({ kind: 'error', reason: 'network' }, applied, applied)).toEqual({})
    expect(serverFieldErrors(undefined, applied, applied)).toEqual({})
  })
  it('offers an address reset when the refusal is not about a form field', () => {
    expect(needsAddressReset({ kind: 'error', reason: 'invalid_parameter', fields: ['store'] })).toBe(false)
    expect(needsAddressReset({ kind: 'error', reason: 'invalid_parameter', fields: ['store', 'category'] })).toBe(true)
    expect(needsAddressReset({ kind: 'error', reason: 'invalid_parameter' })).toBe(true)
    expect(needsAddressReset({ kind: 'error', reason: 'permission_denied' })).toBe(false)
  })
  it('tells filters from the drill-down when resetting', () => {
    const query: SpendingQuery = { date_from: '2026-01-01', group_by: 'product', category: 2, generic: 7 }
    expect(hasScopeFilters({ group_by: 'store', category: 2 })).toBe(false)
    expect(hasFilters({ group_by: 'store' })).toBe(false)
    expect(hasFilters({ category: 2 })).toBe(true)
    expect(hasScopeFilters({ store: [1] })).toBe(true)
    expect(resetFiltersHref(query)).toBe('/stats?group_by=product&category=2&generic=7')
    expect(resetHref(query)).toBe('/stats?group_by=product')
    expect(resetHref({ category: 2 })).toBe('/stats')
    expect(spendingParams(query)).toEqual(query)
  })
})

describe('breakdown and drill-down', () => {
  const scope: SpendingQuery = { date_from: '2026-01-01', store: [3, 5] }
  it('switches the breakdown in place and drops a generic filter where it leaves one sector', () => {
    const query: SpendingQuery = { ...scope, category: 2, generic: 7, group_by: 'product' }
    expect(groupingHref(query, 'store')).toBe('/stats?date_from=2026-01-01&store=3,5&group_by=store&category=2&generic=7')
    expect(groupingHref(query, 'generic')).toBe('/stats?date_from=2026-01-01&store=3,5&group_by=generic&category=2')
    expect(groupingHref(query, 'category')).toBe('/stats?date_from=2026-01-01&store=3,5&category=2')
    expect(groupingHref({}, 'product')).toBe('/stats?group_by=product')
  })
  it('descends category → subcategories → generic products → products → the product card', () => {
    const [dairy, direct] = drilldown.currencies[0].items
    expect(itemHref(scope, category.currencies[0].items[0])).toBe('/stats?date_from=2026-01-01&store=3,5&category=1')
    expect(itemHref({ ...scope, category: 1 }, dairy)).toBe('/stats?date_from=2026-01-01&store=3,5&category=2')
    expect(direct.direct).toBe(true)
    expect(itemHref({ ...scope, category: 1 }, direct)).toBe('/stats?date_from=2026-01-01&store=3,5&group_by=generic&category=1')
    expect(itemHref({ ...scope, category: 1, group_by: 'generic' }, { kind: 'generic', id: 11, direct: false }))
      .toBe('/stats?date_from=2026-01-01&store=3,5&group_by=product&category=1&generic=11')
    expect(itemHref({ group_by: 'generic' }, { kind: 'generic', id: 11, direct: false })).toBe('/stats?group_by=product&generic=11')
    expect(itemHref({ ...scope, generic: 11, group_by: 'product' }, { kind: 'product', id: 24, direct: false })).toBe('/catalog/products/24')
  })
  it('leaves special rows and stores without a link', () => {
    for (const kind of ['unmatched', 'service', 'deposit'] as const) expect(itemHref({}, { kind, id: null, direct: false })).toBeUndefined()
    expect(itemHref({ group_by: 'store' }, { kind: 'store', id: 1, direct: false })).toBeUndefined()
  })
  it('has no crumbs at the root, whatever the breakdown', () => {
    expect(breadcrumbs({}, null)).toEqual([])
    expect(breadcrumbs({ ...scope, group_by: 'store' }, null)).toEqual([])
  })
  it('builds the way back from parent.path, keeping the filters', () => {
    const parent = { id: 2, name: 'Молочные продукты', path: [{ id: 1, name: 'Продукты питания' }, { id: 2, name: 'Молочные продукты' }] }
    const crumbs = breadcrumbs({ ...scope, category: 2 }, parent)
    expect(crumbs).toEqual([
      { label: 'Все траты', href: '/stats?date_from=2026-01-01&store=3,5' },
      { label: 'Продукты питания', href: '/stats?date_from=2026-01-01&store=3,5&category=1' },
      { label: 'Молочные продукты' },
    ])
    expect(upHref(crumbs)).toBe('/stats?date_from=2026-01-01&store=3,5&category=1')
    expect(upHref(breadcrumbs({ category: 1 }, drilldown.parent))).toBe('/stats')
    expect(upHref([])).toBeUndefined()
  })
  it('adds the levels below the category', () => {
    const generics = breadcrumbs({ category: 1, group_by: 'generic' }, drilldown.parent)
    expect(generics.map((crumb) => crumb.label)).toEqual(['Все траты', 'Продукты питания', 'Обобщённые продукты'])
    expect(generics[1].href).toBe('/stats?category=1')
    expect(upHref(generics)).toBe('/stats?category=1')
    const products = breadcrumbs({ category: 1, generic: 11, group_by: 'product' }, drilldown.parent, 'Курица')
    expect(products).toEqual([
      { label: 'Все траты', href: '/stats' },
      { label: 'Продукты питания', href: '/stats?category=1' },
      { label: 'Обобщённые продукты', href: '/stats?group_by=generic&category=1' },
      { label: 'Курица' },
    ])
    expect(breadcrumbs({ generic: 11, group_by: 'store' }, null, 'Курица')).toEqual([
      { label: 'Все траты', href: '/stats' }, { label: 'Курица', href: '/stats?group_by=product&generic=11' }, { label: 'Магазины' },
    ])
  })
  it('names an unknown level by its number instead of guessing', () => {
    expect(breadcrumbs({ category: 77 }, undefined).at(-1)).toEqual({ label: 'Категория №77' })
    // An answer for another category (still on screen while the next one loads) does not lend its name.
    expect(breadcrumbs({ category: 77 }, drilldown.parent).at(-1)).toEqual({ label: 'Категория №77' })
    expect(breadcrumbs({ generic: 5, group_by: 'product' }, null).at(-1)).toEqual({ label: 'Обобщённый продукт №5' })
  })
})

describe('result block', () => {
  it('keeps the previous answer while the next loads and drops it otherwise', () => {
    const last = { query: { category: 1 }, data: drilldown }
    expect(shownResult({ kind: 'ok', data: category }, {}, last)).toEqual({ query: {}, data: category, stale: false })
    expect(shownResult({ kind: 'loading' }, {}, last)).toEqual({ ...last, stale: true })
    expect(shownResult({ kind: 'loading' }, {}, undefined)).toBeUndefined()
    expect(shownResult({ kind: 'error', reason: 'network' }, {}, last)).toBeUndefined()
  })
  it('names the missing right instead of the local mode to a user of accounts, still without a retry', () => {
    const denied: SpendingFailure = { kind: 'error', reason: 'permission_denied', status: 403 }
    const former = failureView(denied)
    const me = (mode: 'accounts' | 'local_single') =>
      ({ mode, user: { id: 3, username: 'anna', is_staff: false }, permissions: { moderate_catalog: mode === 'local_single' }, csrf_token: 'token' })
    try {
      applyMe(me('accounts'))
      expect(failureView(denied)).toEqual({ retry: false, message: 'Нет права модератора каталога.' })
      expect(failureView({ kind: 'error', reason: 'range_too_large', status: 400 }).message).toBe('Слишком большой период. Уменьшите его в фильтрах.')
      for (const enter of [() => applyMe(me('local_single')), () => applyMe(null)]) { enter(); expect(failureView(denied)).toEqual(former) }
    } finally { resetSession() }
    expect(former).toEqual({ retry: false, message: expect.stringContaining('Локальный режим выключен') })
  })
  it('explains every refusal of the server examples locally, with a retry only where it can help', () => {
    const view = (reason: SpendingFailure['reason'], status?: number) => failureView({ kind: 'error', reason, status })
    expect(view('permission_denied', 403)).toEqual({ retry: false, message: expect.stringContaining('Локальный режим выключен') })
    expect(view('invalid_parameter', 400).retry).toBe(false)
    expect(view('range_too_large', 400)).toEqual({ retry: false, message: 'Слишком большой период. Уменьшите его в фильтрах.' })
    for (const reason of ['network', 'timeout', 'server', 'database_unavailable', 'invalid_response', 'not_acceptable'] as const) {
      expect(view(reason).retry).toBe(true)
    }
    expect(view('timeout').message).toContain('15 секунд')
    expect(view('database_unavailable', 503).message).toContain('временно недоступны')
    const texts = Object.values(statsErrorFixtures).map(({ reason, status }) => view(reason as SpendingFailure['reason'], status).message)
    // Nothing from the server's own messages.
    for (const text of texts) expect(text).not.toMatch(/Доступ запрещён|Некорректные параметры запроса|Ожидается/)
  })
  it('names the period of the answer', () => {
    expect(periodText({ date_from: null, date_to: null })).toBe('Период: всё время.')
    expect(periodText({ date_from: '2026-01-01', date_to: '2026-09-30' })).toBe('Период: 01.01.2026 — 30.09.2026, обе даты включительно.')
    expect(periodText({ date_from: '2026-01-01', date_to: null })).toBe('Период: с 01.01.2026 включительно.')
    expect(periodText({ date_from: null, date_to: '2026-09-30' })).toBe('Период: по 30.09.2026 включительно.')
  })
})
