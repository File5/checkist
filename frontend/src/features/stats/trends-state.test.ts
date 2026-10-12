import { describe, expect, it } from 'vitest'
import type { TrendsMonthlyCurrency, TrendsPricesCurrency } from '../../api/trends'
import { sparkline } from '../../lib/charts/sparkline'
import {
  categoryChart, categoryParams, changeBadge, closeMonthHref, indexChart, indexSummary, inMonth, lastMonthChange, limitRows, loadingOf,
  monthBreakdown, monthHref, monthlyChart, monthName, monthRowHeadings, monthRows, moverCounts, moverRows, optionLabel, partsChart,
  sinceMonth, spendSummary, uncategorizedKey, windowParams,
} from './trends-state'
import { categoryFixture, limitsFixture, monthlyFixture, pricesFixture, utilitiesFixture } from './trends-test-support'

const nb = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ')

describe('address and requests', () => {
  it('asks for the window of the address and the chosen category; the opened month never reaches the server', () => {
    expect(windowParams({})).toEqual({ months: 12 })
    expect(windowParams({ months: 24, month: '2026-08', category: 3 })).toEqual({ months: 24 })
    expect(categoryParams({ months: 6, category: 3, month: '2026-08' })).toEqual({ months: 6, category: 3 })
    expect(categoryParams({})).toEqual({ months: 12 })
    expect(windowParams({ from: '2026-05', to: '2026-10', month: '2026-08' })).toEqual({ from: '2026-05', to: '2026-10' })
    expect(categoryParams({ from: '2026-05', to: '2026-10', category: 3 })).toEqual({ from: '2026-05', to: '2026-10', category: 3 })
  })
  it('opens a month and closes it with the same column', () => {
    expect(monthHref({ months: 6 }, '2026-08')).toBe('/stats/trends?months=6&month=2026-08')
    expect(monthHref({ month: '2026-08' }, '2026-08')).toBe('/stats/trends')
    expect(closeMonthHref({ category: 2, month: '2026-08' })).toBe('/stats/trends?category=2')
  })
  it('treats a block that has not asked yet as loading', () => {
    expect(loadingOf({ kind: 'idle' })).toEqual({ kind: 'loading' })
  })
})

describe('month words', () => {
  it('declines the month for a sentence', () => {
    expect(nb(monthName('2026-09'))).toBe('сентябрь 2026')
    expect(nb(inMonth('2026-08'))).toBe('в августе 2026')
    expect(nb(sinceMonth('2025-10'))).toBe('с октября 2025')
    expect(optionLabel(['Жильё', 'Коммунальные услуги'])).toBe('Жильё › Коммунальные услуги')
  })
})

describe('«Траты по месяцам»', () => {
  const block = monthlyFixture().currencies[0]
  it('stacks top-level categories in the order of the legend and adds «Без категории» when it is positive', () => {
    const chart = monthlyChart(block, {})
    expect(chart.legend.map((entry) => [entry.key, entry.tone])).toEqual([['6', 6], ['1', 1], ['5', 5], [uncategorizedKey, 0]])
    expect(chart.columns).toHaveLength(12)
    const last = chart.columns.at(-1)!
    expect(last.x).toBe('2026-09-01')
    expect(nb(last.totalText)).toBe('191 EUR')
    expect(last.href).toBe('/stats/trends?month=2026-09')
    expect(last.segments.map((segment) => [segment.key, nb(segment.valueText)])).toEqual([
      ['6', '86 EUR'], ['1', '87 EUR'], ['5', '14 EUR'], [uncategorizedKey, '6 EUR'],
    ])
  })
  it('keeps an empty month as a column of zero', () => {
    const empty: TrendsMonthlyCurrency = { ...block, months: block.months.map((entry) => ({ ...entry, total: '0.00', categories: [], uncategorized: '0.00' })) }
    const chart = monthlyChart(empty, {})
    expect(chart.columns.every((column) => column.segments.length === 0)).toBe(true)
    expect(chart.legend.map((entry) => entry.key)).not.toContain(uncategorizedKey)
  })
  it('breaks an opened month down with links into «Траты» of that month', () => {
    const details = monthBreakdown(block, '2026-02')!
    expect(nb(details.title)).toBe('февраль 2026')
    expect(details.spendingHref).toBe('/stats?date_from=2026-02-01&date_to=2026-02-28&currency=EUR')
    expect(details.rows[0].href).toBe(`/stats?date_from=2026-02-01&date_to=2026-02-28&currency=EUR&category=${details.rows[0].key}`)
    expect(details.rows.at(-1)!.key).toBe(uncategorizedKey)
    expect(monthBreakdown(block, '2020-01')).toBeNull()
    expect(monthBreakdown(block, undefined)).toBeNull()
  })
})

describe('summary strip', () => {
  it('compares the last month with the previous one and with the average by arrow, sign and words', () => {
    const card = spendSummary(monthlyFixture().currencies[1])
    expect(nb(card.monthTitle)).toBe('сентябрь 2026')
    expect(nb(card.spent)).toBe('7 836 KZT')
    expect(card.vsPrevious && [card.vsPrevious.badge.arrow, nb(card.vsPrevious.badge.text), nb(card.vsPrevious.label)]).toEqual(['▼', '−12,41 %', 'чем в августе 2026'])
    expect(card.vsAverage && [card.vsAverage.badge.tone, nb(card.vsAverage.badge.text)]).toEqual(['up', '+8,10 %'])
  })
  it('makes a badge of a percent string without arithmetic', () => {
    expect(changeBadge(null)).toBeNull()
    expect(changeBadge('0.00')).toMatchObject({ tone: 'same', arrow: '=' })
    expect(changeBadge('-3.10')).toMatchObject({ tone: 'down', arrow: '▼' })
    expect(nb(changeBadge('152.58')!.words)).toBe('больше на 152,58 %')
    expect(nb(changeBadge('-4.73', 'дороже', 'дешевле')!.words)).toBe('дешевле на 4,73 %')
  })
})

describe('«Месяц к месяцу»', () => {
  const block = monthlyFixture().currencies[0]
  it('lists top-level categories with their sub-categories, two last months and the change', () => {
    const rows = monthRows(block, { months: 6 })
    expect(rows.map((row) => [row.name, row.depth, row.badge?.arrow ?? null])).toEqual([
      ['Не разобрано', 0, '▲'], ['Продукты питания', 0, '▲'], ['Молочные продукты', 1, '▼'], ['Овощи и фрукты', 1, '▲'], ['Хлеб', 1, '▲'], ['Бытовая химия', 0, '▼'],
    ])
    expect(rows[1].values).toHaveLength(12)
    expect(rows[1].href).toBe('/stats/trends?months=6&category=1')
    expect(nb(rows[1].last)).toBe('87 EUR')
    expect(Object.values(monthRowHeadings(block)).map(nb)).toEqual(['август 2026', 'сентябрь 2026'])
  })
})

describe('«Категория во времени»', () => {
  it('draws every month and the average as a flat dashed second line', () => {
    const block = utilitiesFixture().currencies[0]
    const [amount, average] = categoryChart(block)
    expect(amount.points.map((point) => point.value)).toEqual([28800, 17200, 17600, 18000, 30800, 35100])
    expect(new Set(average.points.map((point) => point.valueText)).size).toBe(1)
    expect(average.slot).toBe(1)
    const change = lastMonthChange(block)!
    expect([change.tone, nb(change.last), nb(change.text)]).toEqual(['more', '35 100 KZT', 'Больше, чем в сентябре 2026 (30 800 KZT)'])
  })
  it('splits utilities by sub-category in colours of the categories and keeps the category\'s own lines neutral', () => {
    const block = utilitiesFixture().currencies[0]
    const parts = partsChart(block, 'Жильё › Коммунальные услуги', block.months.map((entry) => entry.month))!
    expect(parts.legend.map((entry) => [entry.label, entry.tone])).toEqual([
      ['Электричество', 5], ['Отопление и газ', 6], ['ОСИ/КСК', 1], ['Вода', 2], ['Вывоз мусора', 3], ['Жильё › Коммунальные услуги: без подкатегории', 0],
    ])
    // Summer without heating: the segment is left out, not drawn as zero.
    expect(parts.columns[1].segments.map((segment) => segment.key)).toEqual(['23', '25', '26', '27'])
    expect(nb(parts.columns[5].totalText)).toBe('35 100 KZT')
    expect(partsChart({ ...block, parts: [] }, 'x', [])).toBeNull()
  })
  it('shows parts of a category with sub-categories from the demo', () => {
    const block = categoryFixture().currencies[0]
    expect(block.parts.at(-1)!.direct).toBe(true)
    expect(partsChart(block, 'Продукты питания', block.months.map((entry) => entry.month))!.legend.at(-1)!.tone).toBe(0)
  })
})

describe('«Лимиты по месяцам»', () => {
  it('marks over-limit months by more than colour and counts them', () => {
    const [eur] = limitRows(limitsFixture().limits)
    expect([eur.name, nb(eur.amount)]).toEqual(['Продукты питания', '80 EUR'])
    expect(eur.cells.map((cell) => [nb(cell.percent), cell.over, cell.fill])).toEqual([
      ['86,16 %', false, 86], ['103,68 %', true, 100], ['88,63 %', false, 89], ['92,91 %', false, 93], ['95,94 %', false, 96], ['107,64 %', true, 100],
    ])
    expect(eur.overCount).toBe(2)
    expect(limitRows([{ ...limitsFixture().limits[0], category: null }])[0].name).toBe('Категория удалена')
  })
})

describe('«Как менялись цены»', () => {
  const block = pricesFixture().currencies[0]
  it('draws only the months with an index', () => {
    const gap: TrendsPricesCurrency = { ...block, points: block.points.map((point, index) => (index === 3 ? { ...point, index: null } : point)) }
    expect(indexChart(gap)[0].points).toHaveLength(11)
    expect(indexChart(block)[0].points[0].valueText).toBe('100,00')
  })
  it('says how prices changed since the first month and how many products rose and fell', () => {
    const summary = indexSummary(block)!
    expect([nb(summary.text), summary.badge.arrow]).toEqual(['Цены на те же товары выросли на 0,89 % с октября 2025', '▲'])
    expect(indexSummary({ ...block, change_percent: null, index_month: null })).toBeNull()
    expect(nb(moverCounts(block))).toBe('Подорожало: 23 товара, подешевело: 4 товара')
    expect(nb(moverCounts({ ...block, risen_total: 1, fallen_total: 11 }))).toBe('Подорожало: 1 товар, подешевело: 11 товаров')
  })
  it('shows old → new unit price with a signed change', () => {
    const [riser] = moverRows(block.risers, block.currency)
    expect([riser.name, nb(riser.old), nb(riser.next), nb(riser.change)]).toEqual(['Demo Butterkeks', '1,55 EUR/шт', '1,62 EUR/шт', '+4,52 %'])
    expect(nb(moverRows(block.fallers, block.currency)[0].change)).toBe('−3,88 %')
  })
})

describe('sparkline geometry', () => {
  it('draws from zero, puts a flat zero on the bottom and marks the last value', () => {
    expect(sparkline([0, 10], 100, 20, 0)).toEqual({ line: 'M0 20L100 0', last: { x: 100, y: 0 } })
    expect(sparkline([0, 0, 0], 100, 20, 0).line).toBe('M0 20L50 20L100 20')
    expect(sparkline([], 100, 20)).toEqual({ line: '', last: null })
  })
})
