import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getBudgetLimitHistory } from '../../api/budget'
import type { BudgetLimitChange, BudgetLimitHistory } from '../../api/budget'
import { isBudgetLimitHistory } from '../../api/budget-schema'
import { LimitHistory } from './LimitsPage'
import { filterHistory, historyCategories, historyChangeText, historyEntries } from './limits-state'

const nb = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ')
const food = { id: 1, name: 'Продукты', path: [{ id: 1, name: 'Продукты' }] }
const dairy = { id: 2, name: 'Молочное', path: [{ id: 1, name: 'Продукты' }, { id: 2, name: 'Молочное' }] }

function change(overrides: Partial<BudgetLimitChange> = {}): BudgetLimitChange {
  return {
    id: 3, changed_at: '2026-09-20T12:00:00Z', effective_month: '2026-09', kind: 'changed', category: dairy, currency: 'KZT',
    old_amount: '120000.00', new_amount: '150000.00', change_percent: '25.00',
    changed_by: { username: 'andrey', display_name: 'Андрей' }, ...overrides,
  }
}
const journal = (): BudgetLimitChange[] => [
  change(),
  change({ id: 2, changed_at: '2026-08-02T12:00:00Z', effective_month: '2026-08', category: food, old_amount: '200.40', new_amount: '180.00', change_percent: '-10.18', changed_by: null }),
  change({ id: 1, changed_at: '2026-07-03T12:00:00Z', effective_month: '2026-07', kind: 'created', old_amount: null, new_amount: '120000.00', change_percent: null }),
  change({ id: 4, kind: 'deleted', category: food, old_amount: '180.00', new_amount: null, change_percent: null }),
]
function answer(): BudgetLimitHistory {
  return {
    months: 2, month_from: '2026-08', month_to: '2026-09', changes: journal(),
    series: [{ category: dairy, currency: 'KZT', limit_id: 7, amount: '150000.00', months: [
      { month: '2026-08', amount: '120000.00' }, { month: '2026-09', amount: '150000.00' }] }],
  }
}

describe('«История изменений» without React', () => {
  it('says who changed which limit, old → new rounded up, and which way', () => {
    const entries = historyEntries(journal())
    expect(entries.map((entry) => [entry.date, entry.who, entry.category, nb(entry.text), entry.direction, entry.badge && nb(entry.badge)])).toEqual([
      ['20.09.2026', 'Андрей', 'Продукты › Молочное', '120 000 → 150 000 KZT', 'up', '▲ 25,00 %'],
      ['02.08.2026', '—', 'Продукты', '201 → 180 KZT', 'down', '▼ 10,18 %'],
      ['03.07.2026', 'Андрей', 'Продукты › Молочное', 'новый лимит 120 000 KZT', null, null],
      ['20.09.2026', 'Андрей', 'Продукты', 'удалён, был 180 KZT', null, null],
    ])
    expect(nb(historyChangeText({ kind: 'changed', old_amount: '0.50', new_amount: '1.00', currency: 'EUR' }))).toBe('1 → 1 EUR')
  })
  it('filters by a category of the journal', () => {
    const entries = historyEntries(journal())
    expect(historyCategories(entries)).toEqual([{ id: 1, name: 'Продукты' }, { id: 2, name: 'Продукты › Молочное' }])
    expect(filterHistory(entries, 1).map((entry) => entry.key)).toEqual(['2', '4'])
    expect(filterHistory(entries, null)).toHaveLength(4)
    expect(filterHistory(entries, 99)).toHaveLength(4)
  })
})

describe('«История изменений» markup', () => {
  it('lists the entries with the filter; amounts in figures', () => {
    const html = nb(renderToStaticMarkup(<LimitHistory state={{ kind: 'ok', changes: journal() }} category={2} />))
    expect(html).toContain('История изменений')
    expect(html).toContain('<option value="">Все категории</option>')
    expect(html).toContain('<option value="2" selected="">Продукты › Молочное</option>')
    expect(html).toContain('<time dateTime="2026-09-20T12:00:00Z">20.09.2026</time>')
    expect(html).toContain('<span class="ck-figures">120 000 → 150 000 KZT</span>')
    expect(html).toContain('class="limits-history-badge limits-history-up"')
    expect(html).not.toContain('201 → 180')
  })
  it('loading, empty and failed states', () => {
    expect(renderToStaticMarkup(<LimitHistory state={{ kind: 'loading' }} />)).toContain('Загружаем историю…')
    expect(renderToStaticMarkup(<LimitHistory state={{ kind: 'ok', changes: [] }} />)).toContain('Лимиты пока не менялись.')
    const failed = renderToStaticMarkup(<LimitHistory state={{ kind: 'error', message: 'Нет связи.' }} />)
    expect(failed).toContain('Нет связи.')
    // One category: no filter.
    expect(renderToStaticMarkup(<LimitHistory state={{ kind: 'ok', changes: [change()] }} />)).not.toContain('<select')
  })
})

describe('GET /api/budget/limits/history/ on the wire', () => {
  const fetchMock = vi.fn<typeof fetch>()
  beforeEach(() => { fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
  afterEach(() => { vi.unstubAllGlobals() })

  it('accepts the contract and refuses a kind that disagrees with the amounts or a short series', () => {
    expect(isBudgetLimitHistory(answer())).toBe(true)
    expect(isBudgetLimitHistory({ ...answer(), changes: [change({ kind: 'created' })] })).toBe(false)
    expect(isBudgetLimitHistory({ ...answer(), changes: [change({ kind: 'deleted' })] })).toBe(false)
    expect(isBudgetLimitHistory({ ...answer(), changes: [change({ changed_at: 'yesterday' })] })).toBe(false)
    const short = answer()
    short.series[0].months.pop()
    expect(isBudgetLimitHistory(short)).toBe(false)
  })
  it('sends the filters and refuses a bad month before asking', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify(answer()), { status: 200 }))
    const result = await getBudgetLimitHistory({ category: 2, currency: 'KZT', from: '2026-08' })
    expect(result.kind).toBe('ok')
    const url = String(fetchMock.mock.calls[0][0])
    expect(url).toContain('budget/limits/history/')
    expect(url).toContain('category=2')
    expect(url).toContain('currency=KZT')
    expect(url).toContain('from=2026-08')
    expect(await getBudgetLimitHistory({ to: '2026-13' })).toMatchObject({ kind: 'error', fields: ['to'] })
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
