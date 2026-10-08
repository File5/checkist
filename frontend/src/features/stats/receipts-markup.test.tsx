import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { CountryEntry } from '../../api/countries'
import { isReceiptCompare, isReceiptSeries } from '../../api/stats-schema'
import { statsFixture } from '../../api/stats-test-support'
import type { ReceiptCompare, ReceiptSeries } from '../../api/stats'
import type { LocalApiErrorReason, StoreEntry } from '../../api/types'
import type { ReceiptsStatsQuery } from '../../navigation'
import { ReceiptsStatsPage } from './index'
import CompareBlock from './receipts-compare'
import { ReceiptsFiltersForm } from './receipts-filters'
import type { ReceiptsFiltersFormProps } from './receipts-filters'
import { filterDraft, filterMessages } from './receipts-state'
import type { CompareState, SeriesState, StatsFailure } from './receipts-state'
import TrendBlock from './receipts-trend'
import { indexAssumption, noMatchedNote } from './receipts-wording'

const noop = () => {}
/** Markup as a person reads it: non-breaking spaces as ordinary ones. */
const html = (node: React.ReactElement) => renderToStaticMarkup(node).replace(/[\u00a0\u202f]/g, ' ')
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
function compareFixture(name: string): ReceiptCompare {
  const body = statsFixture(name)
  if (!isReceiptCompare(body)) throw new Error(`${name} does not match the runtime schema`)
  return body
}
function seriesFixture(name: string): ReceiptSeries {
  const body = statsFixture(name)
  if (!isReceiptSeries(body)) throw new Error(`${name} does not match the runtime schema`)
  return body
}
const failure = (reason: LocalApiErrorReason, fields?: string[]): StatsFailure => ({ kind: 'error', reason, ...(fields && { fields }) })
const periods: ReceiptsStatsQuery = { base_from: '2020-01-01', base_to: '2020-12-31', current_from: '2026-01-01', current_to: '2026-09-30' }
const compare = (state: CompareState, query: ReceiptsStatsQuery = periods) => html(<CompareBlock state={state} query={query} onRetry={noop} />)
const trend = (state: SeriesState, query: ReceiptsStatsQuery = periods) => html(<TrendBlock state={state} query={query} onRetry={noop} />)
const loaded = (name: string): CompareState => ({ kind: 'ok', data: compareFixture(name) })

describe('comparison block (Vitest/SSR, not browser acceptance)', () => {
  it('answers the main question of the demo in words and numbers', () => {
    const markup = compare(loaded('compare-2020-2026.json'))
    const eur = markup.split('<article')[1]
    expect(eur).toContain('<h4 id="')
    expect(eur).toContain('>EUR</h4>')
    expect(eur).toContain('<div class="stats-verdict" data-kind="grew">')
    expect(eur).toContain('Средний чек вырос на 18,71 EUR (+69,27 %): с 27,01 EUR до 45,72 EUR.')
    expect(eur).toContain('Главная причина: стал покупать больше позиций за поход — +8,65 EUR, 46,23 % изменения.')
    expect(text(eur)).toContain('+7,39 EUR (+39,50 % изменения) — выросли цены на те же товары')
    expect(text(eur)).toContain('+2,67 EUR (+14,27 % изменения) — другой состав покупок: позиции в среднем дороже')
    // Both periods with their dates and facts.
    expect(text(eur)).toContain('Базовый период 01.01.2020 – 31.12.2020 Походов в магазин 48 (3,99 в месяц) Средний чек 27,01 EUR Медианный чек 27,28 EUR Позиций на чек 11,5 Сумма на позицию 2,35 EUR')
    expect(text(eur)).toContain('Текущий период 01.01.2026 – 30.09.2026 Походов в магазин 36 (4,01 в месяц) Средний чек 45,72 EUR Медианный чек 45,52 EUR Позиций на чек 14,67 Сумма на позицию 3,12 EUR')
    expect(eur).toContain('Возвраты в расчёт не входят: в базовом периоде исключено 0, в текущем — 1.')
  })
  it('draws the terms as a bar and repeats them in a table whose total is the change', () => {
    const eur = compare(loaded('compare-2020-2026.json')).split('<article')[1]
    expect(eur.match(/<span class="stats-bar-segment [^>]*>/g)).toEqual([
      '<span class="stats-bar-segment stats-effect-quantity" data-sign="positive" style="width:46.23%" title="Количество позиций">',
      '<span class="stats-bar-segment stats-effect-price" data-sign="positive" style="width:39.5%" title="Цены на те же товары">',
      '<span class="stats-bar-segment stats-effect-mix" data-sign="positive" style="width:14.27%" title="Состав покупок">',
    ])
    expect(eur).toContain('<div class="stats-bar" aria-hidden="true">')
    expect(eur).not.toContain('← уменьшает чек')
    const table = eur.split('<table class="stats-table">')[1].split('</table>')[0]
    expect(table.match(/<tr>/g)).toHaveLength(5)
    expect(text(table)).toContain('Количество позиций стал покупать больше позиций за поход +8,65 EUR +46,23 %')
    expect(text(table)).toContain('Цены на те же товары выросли цены на те же товары +7,39 EUR +39,50 %')
    expect(text(table)).toContain('Состав покупок другой состав покупок: позиции в среднем дороже +2,67 EUR +14,27 %')
    expect(text(table)).toContain('Изменение среднего чека +18,71 EUR +69,27 % к базовому чеку')
  })
  it('shows the price index with its coverage and the assumption of the method', () => {
    const [, eur, kzt] = compare(loaded('compare-2020-2026.json')).split('<article')
    expect(eur).toContain('Цены на товары, купленные в обоих периодах, выросли на 24,04 % (индекс Фишера 1,2404).')
    expect(eur).toContain('<p class="stats-note">Ласпейрес 1,2403 · Пааше 1,2405</p>')
    expect(eur).toContain('Индекс посчитан по товарам, купленным в обоих периодах: 24 товара.')
    expect(eur).toContain('на них приходится 96,97 % трат на товары в базовом периоде и 79,05 % — в текущем.')
    expect(eur).toContain(indexAssumption)
    expect(eur).not.toContain('stats-warning')
    expect(kzt).toContain('выросли на 78,53 % (индекс Фишера 1,7853)')
  })
  it('warns visibly when the index stands on a small share of the spending', () => {
    const data = compareFixture('compare-2020-2026.json')
    data.currencies[0].price_index!.coverage_current_percent = '31.20'
    const markup = compare({ kind: 'ok', data })
    expect(markup.match(/<p class="stats-warning" role="note">/g)).toHaveLength(1)
    expect(markup).toContain('<strong>Внимание.</strong> Низкое покрытие')
  })
  it('lists the matched products with prices before and after and links to their cards', () => {
    const eur = compare(loaded('compare-2020-2026.json')).split('<article')[1]
    const products = eur.split('stats-products-table">')[1].split('</table>')[0]
    expect(products).toContain('Показаны 5 из 24 совпавших товаров с наибольшим изменением суммы покупок.')
    expect(products.match(/<a href="\/catalog\/products\/\d+">/g)).toEqual([24, 10, 21, 4, 17].map((id) => `<a href="/catalog/products/${id}">`))
    expect(text(products)).toContain('Demo Hähnchenbrust 600g 6,17 EUR/шт 7,87 EUR/шт +27,49 % 19 шт 18 шт 117,23 EUR 141,59 EUR')
    expect(products.match(/<th scope="col"/g)).toHaveLength(8)
    // Both wide tables scroll inside a focusable region named by its heading: the terms and the products.
    const regions = [...eur.matchAll(/<div class="stats-table-scroll" role="region" aria-labelledby="([^"]+)" tabindex="0">/g)].map((match) => match[1])
    expect(regions).toHaveLength(2)
    expect(eur.match(/<div class="stats-table-scroll"/g)).toHaveLength(2)
    expect(eur).toContain(`<h5 id="${regions[0]}">Из чего сложилось изменение</h5>`)
    expect(eur).toContain(`<h5 id="${regions[1]}">Товары, купленные в обоих периодах</h5>`)
  })
  it('keeps currencies apart and says so', () => {
    const markup = compare(loaded('compare-2020-2026.json'))
    expect(markup.match(/<article class="stats-currency"/g)).toHaveLength(2)
    expect(markup).toContain('Валюты не складываются и не пересчитываются')
    expect(markup).toContain('>KZT</h4>')
    expect(markup).toContain('Средний чек вырос на 4 424,92 KZT (+144,88 %)')
    expect(compare(loaded('compare-no-matched-products.json'))).not.toContain('Валюты не складываются')
  })
  it('replaces prices and mix with the price per line when no product matched', () => {
    const markup = compare(loaded('compare-no-matched-products.json'))
    expect(markup).toContain('Средний чек вырос на 21,36 EUR (+90,74 %): с 23,54 EUR до 44,90 EUR.')
    expect(markup.match(/<span class="stats-bar-segment stats-effect-([a-z_]+)"/g)).toEqual([
      '<span class="stats-bar-segment stats-effect-quantity"', '<span class="stats-bar-segment stats-effect-price_per_line"',
    ])
    expect(text(markup)).toContain('Цена позиции (цены и состав вместе) выросла средняя сумма за одну позицию +13,34 EUR —')
    expect(markup).toContain(noMatchedNote)
    expect(markup).not.toContain('Индекс цен')
    expect(markup).not.toContain('stats-products')
    expect(markup).not.toContain('Цены на те же товары')
  })
  it('shows a one-sided period without a decomposition', () => {
    const markup = compare(loaded('compare-one-sided.json'))
    expect(markup).toContain('<div class="stats-verdict" data-kind="no-base">')
    expect(markup).toContain('В базовом периоде походов в KZT нет, поэтому изменение среднего чека посчитать нельзя.')
    expect(markup).toContain('В текущем периоде: 1 поход, средний чек 7 836,00 KZT.')
    expect(text(markup)).toContain('Походов в магазин 0 (0 в месяц) Средний чек — Медианный чек —')
    expect(markup).not.toMatch(/<table|stats-bar|Индекс цен/)
  })
  it('hatches and labels a term that lowers the receipt', () => {
    const data = compareFixture('compare-2020-2026.json')
    const [eur] = data.currencies
    eur.change = { avg_receipt: '2.00', avg_receipt_percent: '7.40' }
    eur.effects = { ...eur.effects!, quantity: '-5.00', price: '6.00', mix: '1.00', quantity_percent: '-250.00', price_percent: '300.00', mix_percent: '50.00' }
    const markup = compare({ kind: 'ok', data: { ...data, currencies: [eur] } })
    expect(markup).toContain('<span class="stats-bar-segment stats-effect-quantity" data-sign="negative" style="width:41.67%" title="Количество позиций"></span><span class="stats-bar-zero"></span>')
    expect(markup).toContain('← уменьшает чек')
    expect(markup).toContain('<span class="stats-swatch stats-effect-quantity" data-sign="negative" aria-hidden="true"></span>')
    expect(text(markup)).toContain('-5,00 EUR (-250,00 % изменения) — стал покупать меньше позиций за поход, против общего изменения')
    expect(text(markup)).toContain('стал покупать меньше позиций за поход — действует против общего изменения -5,00 EUR -250,00 %')
  })

  it('keeps the heading as the focus target in every state', () => {
    const states: CompareState[] = [{ kind: 'idle' }, { kind: 'loading' }, failure('network'), loaded('compare-empty.json'), loaded('compare-2020-2026.json')]
    for (const state of states) expect(compare(state)).toMatch(/<h3 id="[^"]+" data-request-focus-target="true" tabindex="-1">Что изменилось между периодами<\/h3>/)
    expect(compare({ kind: 'loading' })).toMatch(/<section class="stats-panel" aria-labelledby="[^"]+" aria-busy="true">/)
    expect(compare({ kind: 'loading' })).toContain('Считаем сравнение периодов…')
  })
  it('invites to choose periods before anything is asked', () => {
    const markup = compare({ kind: 'idle' }, {})
    expect(markup).toContain('request-state-empty')
    expect(markup).toContain('Выберите базовый и текущий периоды')
    expect(markup).not.toMatch(/<table|<button/)
  })
  it('explains an incomplete or overlapping address without a repeat button', () => {
    const missing = compare({ kind: 'invalid', errors: { base_to: filterMessages.required, current_to: filterMessages.required } }, { base_from: '2020-01-01' })
    expect(missing).toContain(`Сравнение не построено. ${filterMessages.required} Исправьте отмеченные поля в форме выше.`)
    expect(compare({ kind: 'invalid', errors: { current_from: filterMessages.overlap } })).toContain(filterMessages.overlap)
    expect(missing).not.toContain('<button')
  })
  it('tells apart no visits at all and no visits under the filters', () => {
    const plain = compare(loaded('compare-empty.json'))
    expect(plain).toContain('Ни в базовом, ни в текущем периоде походов в магазин нет.')
    expect(plain).not.toContain('<a ')
    const filtered = compare(loaded('compare-empty.json'), { ...periods, currency: 'EUR', store: [2], interval: 'year' })
    expect(filtered).toContain('По выбранным стране, валюте и магазинам походов нет ни в одном из периодов.')
    expect(filtered).toContain('<a class="action-link" href="/stats/receipts?base_from=2020-01-01&amp;base_to=2020-12-31&amp;current_from=2026-01-01&amp;current_to=2026-09-30&amp;interval=year">Убрать фильтры, оставить периоды</a>')
  })
  it.each(['network', 'timeout', 'server', 'database_unavailable', 'invalid_response'] as const)('offers a repeat after %s', (reason) => {
    const markup = compare(failure(reason))
    expect(markup).toContain('request-state-error')
    expect(markup).toContain('<button type="button" data-request-retry="true">Повторить</button>')
  })
  it('says the local mode is off', () => {
    const markup = compare(failure('permission_denied'))
    expect(markup).toContain('Статистика чеков доступна только в локальном режиме сервера, сейчас он выключен.')
    expect(markup).toContain('без этого повтор не поможет')
    expect(markup.match(/<button/g)).toHaveLength(1)
  })
  it('sends a server refusal of parameters back to the form instead of a repeat', () => {
    const markup = compare(failure('invalid_parameter', ['store']), { ...periods, store: [99], interval: 'year' })
    expect(markup).toContain('Сервер не принял параметры запроса. Исправьте отмеченные поля в форме выше или сбросьте фильтры.')
    expect(markup).not.toContain('<button')
    expect(markup).toContain('<a class="action-link" href="/stats/receipts?interval=year">Сбросить периоды и фильтры</a>')
  })
})

describe('chart block (Vitest/SSR, not browser acceptance)', () => {
  it('draws two panels per currency with a table of the same values', () => {
    const markup = trend({ kind: 'ok', data: seriesFixture('series-year.json') }, { ...periods, interval: 'year' })
    expect(markup.match(/<article class="stats-currency"/g)).toHaveLength(2)
    expect(markup).toContain('Валюты не складываются: у каждой валюты чеков свои графики.')
    expect(markup.match(/role="group" aria-label="([^"]+)"/g)).toEqual([
      'role="group" aria-label="Средний и медианный чек, EUR"', 'role="group" aria-label="Позиций на чек"',
      'role="group" aria-label="Средний и медианный чек, KZT"', 'role="group" aria-label="Позиций на чек"',
    ])
    expect(markup.match(/<svg class="ck-line-svg"/g)).toHaveLength(4)
    expect(text(markup)).toContain('2020 27,01 EUR 27,28 EUR')
    expect(markup).toContain('Вертикальная ось: EUR.')
    expect(markup).toContain('Возвраты в график не входят: исключено 1.')
    expect(markup.match(/Возвраты в график/g)).toHaveLength(1)
  })
  it('names months in the table of a monthly chart', () => {
    const markup = trend({ kind: 'ok', data: seriesFixture('series-month.json') })
    expect(text(markup)).toContain('январь 2026 45,12 EUR 45,85 EUR')
    expect(markup).not.toContain('Валюты не складываются')
  })
  it('switches the interval with links that keep the periods and marks the current one', () => {
    const markup = trend({ kind: 'loading' }, { ...periods, currency: 'EUR', interval: 'quarter' })
    const nav = markup.split('aria-label="Интервал графика">')[1].split('</nav>')[0]
    const base = '/stats/receipts?base_from=2020-01-01&amp;base_to=2020-12-31&amp;current_from=2026-01-01&amp;current_to=2026-09-30&amp;currency=EUR'
    expect(nav.match(/<a [^>]*>[^<]*/g)).toEqual([
      `<a class="stats-chip" href="${base}">Месяц`, `<a class="stats-chip" aria-current="true" href="${base}&amp;interval=quarter">Квартал`,
      `<a class="stats-chip" href="${base}&amp;interval=year">Год`,
    ])
    expect(markup).toContain('Загружаем походы по времени…')
    expect(markup).toContain('Охват графика: с 01.01.2020 по 30.09.2026 — от начала базового периода до конца текущего.')
    expect(trend({ kind: 'loading' }, {})).toContain('Охват графика: все сохранённые чеки.')
    expect(trend({ kind: 'loading' }, { interval: 'week' })).toContain('>Неделя</a>')
  })
  it('asks to shrink the period or coarsen the interval after a too large range', () => {
    const markup = trend(failure('range_too_large'), { ...periods, interval: 'week' })
    expect(markup).toContain('Слишком много интервалов для одного графика: уменьшите период или укрупните интервал.')
    expect(markup).not.toContain('<button')
    expect(markup.match(/<a class="action-link"[^>]*>[^<]*/g)?.map((link) => link.split('>')[1])).toEqual(['Интервал: месяц', 'Интервал: квартал', 'Интервал: год'])
    expect(trend(failure('range_too_large'), { interval: 'year' })).toContain('Сбросить периоды и фильтры')
  })
  it('shows the other failures and both kinds of emptiness', () => {
    expect(trend(failure('permission_denied'))).toContain('только в локальном режиме сервера')
    expect(trend(failure('network'))).toContain('<button type="button" data-request-retry="true">Повторить</button>')
    expect(trend(failure('invalid_parameter', ['store']))).not.toContain('<button')
    const empty: SeriesState = { kind: 'ok', data: seriesFixture('series-empty.json') }
    expect(trend(empty, {})).toContain('Чеков пока нет: график появится после распознавания первых фото чеков.')
    expect(trend(empty)).toContain('За это время походов в магазин нет. Выберите другие периоды.')
    expect(trend(empty, { ...periods, country: 'KZ' })).toContain('<a class="action-link" href="/stats/receipts?base_from=2020-01-01&amp;base_to=2020-12-31&amp;current_from=2026-01-01&amp;current_to=2026-09-30">Убрать фильтры</a>')
    expect(trend(empty)).not.toContain('<svg')
  })
})

describe('form of periods and filters (Vitest/SSR, not browser acceptance)', () => {
  const countries: CountryEntry[] = [
    { code: 'DE', name: 'Германия', currencies: ['EUR'], stores_count: 2, products_count: 30 },
    { code: 'KZ', name: 'Казахстан', currencies: ['KZT', 'USD'], stores_count: 1, products_count: 12 },
  ]
  const store = (id: number, name: string, country: string, address = ''): StoreEntry => ({ id, name, city: 'Musterstadt', country, address, timezone: 'Europe/Berlin', receipts_count: 3 })
  const stores = [store(1, 'Zahlenfrisch', 'DE', 'Beispielweg 1'), store(2, 'Billigmarkt', 'DE')]
  const form = (query: ReceiptsStatsQuery, patch: Partial<ReceiptsFiltersFormProps> = {}) => html(<ReceiptsFiltersForm
    query={query} draft={filterDraft(query)} errors={{}} today="2026-10-07"
    countries={{ kind: 'ok', items: countries, total: 2 }} stores={{ kind: 'ok', items: stores, total: 2 }}
    onChange={noop} onToggleStore={noop} onSubmit={noop} onReset={noop} onRetryCountries={noop} onRetryStores={noop} {...patch} />)

  it('shows the applied periods, filters and stores in labelled fields', () => {
    const markup = form({ ...periods, country: 'DE', currency: 'EUR', store: [2] })
    for (const [field, value] of Object.entries(periods)) expect(markup).toMatch(new RegExp(`<input id="[^"]+-${field}" type="date" aria-invalid="false" aria-describedby="[^"]+-period-note" name="${field}" value="${value}"/>`))
    expect(markup).toContain('<legend>Базовый период (было)</legend>')
    expect(markup).toContain('<legend>Текущий период (стало)</legend>')
    expect(markup).toContain('<option value="DE" selected="">Германия (DE)</option>')
    // Only the currencies of the chosen country.
    expect(markup.match(/<option value="[A-Z]{3}"[^>]*>/g)).toEqual(['<option value="EUR" selected="">'])
    expect(markup).toMatch(/<input type="checkbox" aria-invalid="false" aria-describedby="[^"]+-store-note" name="store" checked="" value="2"\/><span>Billigmarkt · Musterstadt · DE<\/span>/)
    expect(markup).toContain('<span>Zahlenfrisch · Beispielweg 1 · DE</span>')
    expect(markup).toContain('Выбрано: 1 из не более 20.')
    expect(markup).toContain('<button type="submit">Сравнить периоды</button>')
    expect(markup).toContain('Сбросить периоды и фильтры</button>')
  })
  it('offers every currency without a country and no reset on an empty form', () => {
    const markup = form({})
    expect(markup.match(/<option value="[A-Z]{3}"[^>]*>/g)).toEqual(['<option value="EUR">', '<option value="KZT">', '<option value="USD">'])
    expect(markup).not.toContain('Сбросить периоды и фильтры')
    expect(markup).not.toContain('role="alert"')
  })
  it('offers ready pairs of periods as links that keep the filters', () => {
    const markup = form({ currency: 'EUR', base_from: '2025-01-01', base_to: '2025-12-31', current_from: '2026-01-01', current_to: '2026-10-07' })
    const nav = markup.split('aria-label="Готовые пары периодов">')[1].split('</nav>')[0]
    expect(nav.match(/<a [^>]*>[^<]*/g)).toEqual([
      '<a class="stats-chip" href="/stats/receipts?base_from=2020-01-01&amp;base_to=2020-12-31&amp;current_from=2026-01-01&amp;current_to=2026-10-07&amp;currency=EUR">2020 против этого года (2026)',
      '<a class="stats-chip" aria-current="true" href="/stats/receipts?base_from=2025-01-01&amp;base_to=2025-12-31&amp;current_from=2026-01-01&amp;current_to=2026-10-07&amp;currency=EUR">Прошлый год против этого (2025 и 2026)',
      '<a class="stats-chip" href="/stats/receipts?base_from=2024-01-01&amp;base_to=2024-12-31&amp;current_from=2025-01-01&amp;current_to=2025-12-31&amp;currency=EUR">2024 против 2025 (два полных года)',
    ])
  })
  it('marks wrong fields and ties each message to its field', () => {
    const markup = form({ base_from: '2020-01-01', store: [99] }, {
      errors: { base_to: filterMessages.required, current_from: filterMessages.overlap, store: filterMessages.store, country: filterMessages.country },
    })
    const id = /<input id="([^"]+)-base_to"/.exec(markup)![1]
    expect(markup).toContain(`<input id="${id}-base_to" type="date" aria-invalid="true" aria-describedby="${id}-period-note ${id}-base_to-error" name="base_to" value=""/><p class="stats-field-error" id="${id}-base_to-error">${filterMessages.required}</p>`)
    expect(markup).toContain(`<p class="stats-field-error" id="${id}-current_from-error">${filterMessages.overlap}</p>`)
    expect(markup).toContain(`<input id="${id}-base_from" type="date" aria-invalid="false"`)
    expect(markup).toMatch(new RegExp(`<select id="${id}-country" name="country" aria-invalid="true" aria-describedby="${id}-country-error">`))
    expect(markup).toContain(`aria-describedby="${id}-store-note ${id}-store-error" name="store" checked="" value="99"/><span>Магазин ID 99 (нет в показанном списке)</span>`)
    expect(markup).toContain(`<p class="stats-field-error" id="${id}-store-error">${filterMessages.store}</p>`)
    expect(markup).toContain('<p class="stats-field-error" role="alert">Исправьте отмеченные поля.</p>')
  })
  it('stays usable while the reference lists load or after they failed', () => {
    const query: ReceiptsStatsQuery = { country: 'KZ', currency: 'KZT', store: [7] }
    const loading = form(query, { countries: { kind: 'loading' }, stores: { kind: 'loading' } })
    expect(loading).toContain('Загружаем список стран и валют…')
    expect(loading).toContain('Загружаем список магазинов…')
    expect(loading).toContain('<option value="KZ" selected="">KZ</option>')
    expect(loading).toContain('<option value="KZT" selected="">KZT</option>')
    expect(loading).toContain('value="7"/><span>Магазин ID 7 (нет в показанном списке)</span>')
    const failed = form(query, { countries: { kind: 'error' }, stores: { kind: 'error' } })
    expect(failed).toContain('Не удалось загрузить список стран и валют.')
    expect(failed).toContain('Не удалось загрузить список магазинов.')
    expect(failed.match(/<button type="button" class="stats-secondary" data-request-retry="true">Повторить<\/button>/g)).toHaveLength(2)
    expect(failed).toContain('<button type="submit">Сравнить периоды</button>')
  })
  it('says when the store list is cut or empty', () => {
    expect(form({}, { stores: { kind: 'ok', items: stores, total: 73 } })).toContain('Показаны первые 2 магазинов из 73. Выберите страну, чтобы сузить список.')
    expect(form({ country: 'KZ' }, { stores: { kind: 'ok', items: [], total: 0 } })).toContain('В выбранной стране магазинов нет.')
    expect(form({}, { stores: { kind: 'ok', items: [], total: 0 } })).toContain('Магазинов пока нет')
  })
})

describe('screen before any answer arrives (Vitest/SSR, not browser acceptance)', () => {
  const page = (query: ReceiptsStatsQuery) => html(<ReceiptsStatsPage query={query} />)
  it('opens with the form, an invitation and a loading chart, and no numbers of its own', () => {
    const markup = page({})
    expect(markup).toContain('<section class="stats-receipts" aria-labelledby="stats-receipts-heading"><h2 id="stats-receipts-heading">Почему изменился средний чек</h2>')
    expect(markup.match(/<h3\b[^>]*>[^<]*/g)?.map((heading) => heading.split('>')[1])).toEqual(['Периоды и фильтры', 'Что изменилось между периодами', 'Средний чек по времени'])
    expect(markup).toContain('Выберите базовый и текущий периоды')
    expect(markup).toContain('Загружаем походы по времени…')
    expect(markup).not.toContain('Считаем сравнение периодов…')
    expect(markup).not.toMatch(/Раздел в разработке|<table|<svg|\d+,\d{2} [A-Z]{3}/)
  })
  it('loads both blocks independently for a complete address', () => {
    const markup = page({ ...periods, currency: 'EUR', interval: 'year' })
    expect(markup).toContain('Считаем сравнение периодов…')
    expect(markup).toContain('Загружаем походы по времени…')
    expect(markup).toContain('name="base_from" value="2020-01-01"')
    expect(markup).toContain('<option value="EUR" selected="">EUR</option>')
    expect(markup).not.toContain('aria-invalid="true"')
  })
  it('marks the missing dates of an incomplete address and still loads the chart', () => {
    const markup = page({ base_from: '2020-01-01', base_to: '2020-12-31' })
    expect(markup).toContain(`Сравнение не построено. ${filterMessages.required}`)
    expect(markup.match(/aria-invalid="true"/g)).toHaveLength(2)
    expect(markup).toMatch(/name="current_from" value=""\/><p class="stats-field-error" id="[^"]+-current_from-error">/)
    expect(markup).toContain('Загружаем походы по времени…')
    expect(markup).not.toContain('Считаем сравнение периодов…')
  })
  it('marks the start of the current period when the periods of the address overlap', () => {
    const markup = page({ base_from: '2020-01-01', base_to: '2026-01-01', current_from: '2026-01-01', current_to: '2026-09-30' })
    expect(markup).toContain(`Сравнение не построено. ${filterMessages.overlap}`)
    expect(markup.match(/aria-invalid="true"/g)).toHaveLength(1)
    expect(markup).toMatch(new RegExp(`name="current_from" value="2026-01-01"/><p class="stats-field-error" id="[^"]+-current_from-error">${filterMessages.overlap}</p>`))
  })
})
