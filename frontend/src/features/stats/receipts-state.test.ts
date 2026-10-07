import { describe, expect, it } from 'vitest'
import { isReceiptSeries } from '../../api/stats-schema'
import { statsErrorFixtures, statsFixture } from '../../api/stats-test-support'
import type { ReceiptSeries } from '../../api/stats'
import type { LocalApiErrorReason } from '../../api/types'
import { parseReceiptsStatsQuery } from '../../navigation'
import type { ReceiptsStatsQuery } from '../../navigation'
import { applyMe } from '../../session'
import { resetSession } from '../../session/store'
import { intervalName, trendCharts } from './receipts-series'
import {
  appliedErrors, applyFilters, canRetry, coarserIntervals, comparePlan, failureMessage, filterDraft, filterMessages, formErrors, hasPeriods, hasScope,
  intervalChoices, intervalHref, isActivePreset, localToday, periodPresets, periodProblems, presetHref, seriesParams, withoutScope,
} from './receipts-state'
import type { FilterDraft, StatsFailure } from './receipts-state'

const periods = { base_from: '2020-01-01', base_to: '2020-12-31', current_from: '2026-01-01', current_to: '2026-09-30' }
const draft = (patch: Partial<FilterDraft> = {}): FilterDraft => ({ ...filterDraft(periods), ...patch })
const failure = (reason: LocalApiErrorReason, fields?: string[]): StatsFailure => ({ kind: 'error', reason, ...(fields && { fields }) })
/** The adapter keeps exactly these names of a server error example. */
const serverFailure = (name: string): StatsFailure => failure(statsErrorFixtures[name].reason as LocalApiErrorReason, statsErrorFixtures[name].fields)

describe('periods of the comparison', () => {
  it('accepts two periods that do not overlap and no periods at all', () => {
    expect(periodProblems(periods)).toEqual({})
    expect(periodProblems({})).toEqual({})
  })
  it('asks for every missing date once any date is set', () => {
    expect(periodProblems({ base_from: '2020-01-01' })).toEqual({
      base_to: filterMessages.required, current_from: filterMessages.required, current_to: filterMessages.required,
    })
  })
  it.each([['2026-01-01', '2026-01-01'], ['2026-06-30', '2026-01-01']])('refuses a base period that ends on %s when the current one starts on %s', (base_to, current_from) => {
    expect(periodProblems({ ...periods, base_to, current_from })).toEqual({ current_from: filterMessages.overlap })
  })
  it('allows the current period to start the day after the base one', () => {
    expect(periodProblems({ ...periods, base_to: '2025-12-31' })).toEqual({})
  })
  it('marks both bounds of a reversed period', () => {
    expect(periodProblems({ ...periods, base_from: '2021-01-01' })).toEqual({ base_from: filterMessages.order, base_to: filterMessages.order })
  })
})

describe('form of the filters', () => {
  it('turns a valid draft into the address query and keeps the interval of the chart', () => {
    const result = applyFilters({ interval: 'year' }, draft({ country: 'DE', currency: 'EUR', store: [3, 1] }))
    expect(result.errors).toEqual({})
    expect(result.query).toEqual({ ...periods, country: 'DE', currency: 'EUR', store: [1, 3], interval: 'year' })
  })
  it('applies filters without periods: the chart alone can be narrowed', () => {
    const result = applyFilters({}, { ...filterDraft({}), currency: 'KZT' })
    expect(result).toEqual({ query: { currency: 'KZT' }, errors: {} })
  })
  it('reports missing dates, an overlap and too many stores without applying', () => {
    expect(applyFilters({}, draft({ current_to: '' })).errors).toEqual({ current_to: filterMessages.required })
    expect(applyFilters({}, draft({ base_to: '2026-03-01' })).errors).toEqual({ current_from: filterMessages.overlap })
    expect(applyFilters({}, draft({ store: Array.from({ length: 21 }, (_, index) => index + 1) })).errors).toEqual({ store: filterMessages.store })
  })
  it('refuses a date the address could not hold', () => {
    expect(applyFilters({}, draft({ base_from: '2020-02-30' })).errors).toEqual({ base_from: filterMessages.date })
    expect(applyFilters({}, draft({ country: 'D1' })).errors).toEqual({ country: filterMessages.country })
  })
  it('restores the draft from the address', () => {
    expect(filterDraft({ ...periods, store: [2, 5], country: 'KZ' })).toEqual({ ...periods, country: 'KZ', currency: '', store: [2, 5] })
  })
  it('keeps an applied problem on a field only until that field is edited', () => {
    const applied = filterDraft({ ...periods, store: [99] })
    const fromAddress = { store: filterMessages.store, current_from: filterMessages.overlap }
    expect(formErrors(applied, applied, {}, fromAddress)).toEqual(fromAddress)
    expect(formErrors({ ...applied, store: [] }, applied, {}, fromAddress)).toEqual({ current_from: filterMessages.overlap })
    expect(formErrors({ ...applied, current_from: '2026-02-01' }, applied, { base_to: filterMessages.required }, fromAddress))
      .toEqual({ base_to: filterMessages.required, store: filterMessages.store })
  })
})

describe('requests of the applied address', () => {
  it('asks nothing until periods are chosen', () => {
    expect(comparePlan({})).toEqual({ kind: 'idle' })
    expect(comparePlan({ country: 'DE', interval: 'year' })).toEqual({ kind: 'idle' })
  })
  it('builds the comparison request without the interval of the chart', () => {
    expect(comparePlan({ ...periods, currency: 'EUR', store: [1, 2], interval: 'quarter' }))
      .toEqual({ kind: 'request', params: { ...periods, currency: 'EUR', store: [1, 2] } })
  })
  it('refuses an incomplete or overlapping address locally with the fields the server names', () => {
    // error-required-parameter.json and error-periods-overlap.json name the same fields.
    expect(Object.keys((comparePlan({ base_from: '2020-01-01' }) as { errors: object }).errors)).toEqual(['base_to', 'current_from', 'current_to'])
    const overlap = parseReceiptsStatsQuery('?base_from=2020-01-01&base_to=2026-01-01&current_from=2026-01-01&current_to=2026-09-30').query
    expect(comparePlan(overlap)).toEqual({ kind: 'invalid', errors: { current_from: filterMessages.overlap } })
    expect(statsErrorFixtures['error-periods-overlap.json'].fields).toEqual(['current_from'])
  })
  it('spans the chart from the start of the base period to the end of the current one', () => {
    expect(seriesParams({ ...periods, country: 'DE', interval: 'year' })).toEqual({ date_from: '2020-01-01', date_to: '2026-09-30', country: 'DE', interval: 'year' })
    expect(seriesParams({})).toEqual({ interval: 'month' })
    expect(seriesParams({ current_from: '2026-01-01', current_to: '2026-09-30', store: [4] }))
      .toEqual({ date_from: '2026-01-01', date_to: '2026-09-30', store: [4], interval: 'month' })
  })
  it('maps the fields the server rejected to the fields of the form', () => {
    const query: ReceiptsStatsQuery = { ...periods, store: [99], country: 'DE' }
    expect(appliedErrors(query, [failure('invalid_parameter', ['store']), undefined])).toEqual({ store: filterMessages.store })
    expect(appliedErrors(query, [failure('invalid_parameter', ['date_from', 'date_to', 'country', 'limit'])]))
      .toEqual({ base_from: filterMessages.date, current_to: filterMessages.date, country: filterMessages.country })
    expect(appliedErrors(query, [serverFailure('error-periods-overlap.json')])).toEqual({ current_from: filterMessages.overlap })
    expect(appliedErrors({ country: 'DE' }, [serverFailure('error-required-parameter.json')])).toEqual({
      base_from: filterMessages.required, base_to: filterMessages.required, current_from: filterMessages.required, current_to: filterMessages.required,
    })
    expect(appliedErrors(query, [failure('network'), failure('range_too_large'), { kind: 'loading' }, { kind: 'idle' }])).toEqual({})
    expect(appliedErrors({ base_from: '2020-01-01' }, [])).toEqual(periodProblems({ base_from: '2020-01-01' }))
  })
  it('tells apart periods and scope and drops only the scope', () => {
    expect([hasPeriods({}), hasPeriods({ base_to: '2020-12-31' }), hasScope({}), hasScope({ store: [1] }), hasScope({ ...periods })]).toEqual([false, true, false, true, false])
    expect(withoutScope({ ...periods, country: 'DE', currency: 'EUR', store: [1], interval: 'year' })).toEqual({ ...periods, interval: 'year' })
  })
})

describe('ready periods and intervals', () => {
  it('offers 2020, last year and two full years against the right ends', () => {
    const presets = periodPresets('2026-10-07')
    expect(presets.map((preset) => [preset.key, preset.label, preset.dates])).toEqual([
      ['2020-now', '2020 против этого года (2026)', { base_from: '2020-01-01', base_to: '2020-12-31', current_from: '2026-01-01', current_to: '2026-10-07' }],
      ['last-now', 'Прошлый год против этого (2025 и 2026)', { base_from: '2025-01-01', base_to: '2025-12-31', current_from: '2026-01-01', current_to: '2026-10-07' }],
      ['full-years', '2024 против 2025 (два полных года)', { base_from: '2024-01-01', base_to: '2024-12-31', current_from: '2025-01-01', current_to: '2025-12-31' }],
    ])
    for (const preset of presets) expect(periodProblems(preset.dates)).toEqual({})
  })
  it('does not repeat 2020 when it is the last year, and offers nothing for a broken date', () => {
    expect(periodPresets('2021-03-05').map((preset) => preset.key)).toEqual(['last-now', 'full-years'])
    expect(periodPresets('today')).toEqual([])
  })
  it('keeps filters and the interval in a preset link and recognises the applied preset', () => {
    const [first, second] = periodPresets('2026-10-07')
    const query: ReceiptsStatsQuery = { currency: 'EUR', store: [2], interval: 'year' }
    expect(presetHref(query, first)).toBe('/stats/receipts?base_from=2020-01-01&base_to=2020-12-31&current_from=2026-01-01&current_to=2026-10-07&currency=EUR&store=2&interval=year')
    expect(isActivePreset({ ...query, ...first.dates }, first)).toBe(true)
    expect(isActivePreset({ ...query, ...first.dates }, second)).toBe(false)
  })
  it('reads the calendar date of the browser, not UTC', () => {
    expect(localToday(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05')
    expect(localToday(new Date(2026, 11, 31, 0, 1))).toBe('2026-12-31')
  })
  it('offers month, quarter and year, and a week only when the address asks for it', () => {
    expect(intervalChoices('month').map((choice) => [choice.interval, choice.label, choice.active])).toEqual([['month', 'Месяц', true], ['quarter', 'Квартал', false], ['year', 'Год', false]])
    expect(intervalChoices('week').map((choice) => choice.interval)).toEqual(['week', 'month', 'quarter', 'year'])
    expect(intervalHref({ ...periods, interval: 'year' }, 'month')).toBe('/stats/receipts?base_from=2020-01-01&base_to=2020-12-31&current_from=2026-01-01&current_to=2026-09-30')
    expect(intervalHref({ currency: 'EUR' }, 'quarter')).toBe('/stats/receipts?currency=EUR&interval=quarter')
  })
  it('suggests only coarser intervals after a too large range', () => {
    expect(coarserIntervals('week').map((choice) => choice.interval)).toEqual(['month', 'quarter', 'year'])
    expect(coarserIntervals('quarter').map((choice) => choice.label)).toEqual(['Год'])
    expect(coarserIntervals('year')).toEqual([])
  })
})

describe('failures', () => {
  it('gives every server error example its own local message', () => {
    expect(failureMessage(serverFailure('error-range-too-large.json'))).toContain('уменьшите период или укрупните интервал')
    expect(failureMessage(serverFailure('error-permission-denied.json'))).toContain('только в локальном режиме сервера')
    expect(failureMessage(serverFailure('error-invalid-parameter.json'))).toContain('Исправьте отмеченные поля')
    expect(failureMessage(serverFailure('error-periods-overlap.json'))).toContain('Исправьте отмеченные поля')
  })
  it.each([['network', 'связаться с сервером'], ['timeout', 'не ответил вовремя'], ['database_unavailable', 'временно недоступны'],
    ['server', 'ошибки сервера'], ['invalid_response', 'неожиданный ответ'], ['not_found', 'не знает такого адреса'], ['csrf_failed', 'неожиданный ответ']] as const)(
    'words %s without a server text', (reason, text) => expect(failureMessage(failure(reason))).toContain(text))
  it('names the missing right instead of the local mode to a user of accounts', () => {
    const denied = serverFailure('error-permission-denied.json')
    const former = failureMessage(denied)
    const me = (mode: 'accounts' | 'local_single') =>
      ({ mode, user: { id: 3, username: 'anna', is_staff: false }, permissions: { moderate_catalog: mode === 'local_single' }, csrf_token: 'token' })
    try {
      applyMe(me('accounts'))
      expect(failureMessage(denied)).toBe('Нет права модератора каталога.')
      expect(failureMessage(failure('network'))).toContain('связаться с сервером')
      for (const enter of [() => applyMe(me('local_single')), () => applyMe(null)]) { enter(); expect(failureMessage(denied)).toBe(former) }
    } finally { resetSession() }
    expect(former).toContain('только в локальном режиме сервера')
  })
  it('offers a repeat only where the same request can succeed', () => {
    expect((['network', 'timeout', 'server', 'database_unavailable', 'invalid_response', 'permission_denied'] as const).map((reason) => canRetry(failure(reason)))).toEqual(Array(6).fill(true))
    expect([canRetry(failure('invalid_parameter', ['store'])), canRetry(failure('range_too_large'))]).toEqual([false, false])
  })
})

describe('chart series from the server fixtures', () => {
  const series = (name: string): ReceiptSeries => {
    const body = statsFixture(name)
    if (!isReceiptSeries(body)) throw new Error(`${name} does not match the runtime schema`)
    return body
  }
  it('draws the average and the median receipt of a currency and the lines per receipt', () => {
    const [eur] = series('series-month.json').currencies
    const charts = trendCharts(eur)
    expect(charts.receipts.map((item) => [item.key, item.label, item.points.length])).toEqual([['avg', 'Средний чек', 9], ['median', 'Медианный чек', 9]])
    expect(charts.receipts[0].points[0]).toEqual({ x: '2026-01-01', value: 45.12, valueText: '45,12\u00a0EUR' })
    expect(charts.receipts[1].points[0]).toEqual({ x: '2026-01-01', value: 45.85, valueText: '45,85\u00a0EUR' })
    expect(charts.lines).toHaveLength(1)
    expect(charts.lines[0].points[0]).toEqual({ x: '2026-01-01', value: 14.75, valueText: '14,75' })
  })
  it('keeps each currency of the yearly answer apart with its own money text', () => {
    const data = series('series-year.json')
    expect(data.currencies.map((block) => block.currency)).toEqual(['EUR', 'KZT'])
    const [eur, kzt] = data.currencies.map(trendCharts)
    expect(eur.receipts[0].points.map((point) => point.x)).toEqual(data.currencies[0].buckets.map((bucket) => bucket.period_start))
    expect(eur.receipts[0].points.every((point) => point.valueText.endsWith('EUR'))).toBe(true)
    expect(kzt.receipts[0].points.every((point) => point.valueText.endsWith('KZT'))).toBe(true)
  })
  it('gives no charts for an empty answer', () => expect(series('series-empty.json').currencies).toEqual([]))
  it.each([
    ['2026-03-01', 'month', false, 'март 2026'], ['2026-03-01', 'month', true, 'мар 2026'], ['2026-04-01', 'quarter', false, '2 кв. 2026'],
    ['2026-10-01', 'quarter', true, '4 кв. 2026'], ['2026-01-01', 'year', false, '2026'], ['2026-03-02', 'week', false, 'неделя с 02.03.2026'],
    ['2026-03-02', 'week', true, '02.03.2026'], ['soon', 'month', false, 'soon'],
  ] as const)('names the interval %s (%s, short=%s) as «%s»', (x, interval, short, name) => expect(intervalName(x, interval, short)).toBe(name))
})
