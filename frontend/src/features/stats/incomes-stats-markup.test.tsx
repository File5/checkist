import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { IncomeStats } from '../../api/incomes'
import { incomeSeries } from '../incomes/incomes-state'
import { IncomeStatsBlocks } from './IncomesStatsPage'

const plain = (markup: string) => markup.replace(/[\u00a0\u202f]/g, ' ')
const text = (markup: string) => plain(markup).replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const stats = (patch: Partial<IncomeStats> = {}): IncomeStats => ({
  months: 12, month_from: '2025-11', month_to: '2026-10', base_currency: 'KZT', income: '1000000.00', spent: '200000.00',
  saved: '800000.00', saved_percent: '80.00', categories_scope: 'family', excluded: [],
  categories: [{ id: 1, name: 'Зарплата', total: '950000.00' }, { id: 2, name: 'Подработка', total: '50000.00' }], ...patch,
})
const render = (data: IncomeStats) => renderToStaticMarkup(<IncomeStatsBlocks state={{ kind: 'ok', data }} onRetry={() => {}} />)

describe('«Статистика → Доходы» (Vitest/SSR, not the browser)', () => {
  it('shows the family total of the period and every category of the head with a bar against the largest one', () => {
    const markup = render(stats())
    expect(text(markup)).toContain('Доход 1 000 000 ₸ Потрачено 200 000 ₸ Отложено 800 000 ₸ (80 %)')
    expect(text(markup)).toContain('Зарплата 950 000 ₸')
    expect(text(markup)).toContain('Подработка 50 000 ₸')
    expect(markup).toContain('<li class="trends-row trends-cat-1">')
    expect(markup).toContain('<span style="width:100%"></span>')
    expect(markup).toContain('<span style="width:5%"></span>')
    expect(markup).not.toContain('Только ваши записи')
  })
  it('says that a member of a family sees the categories of their own records only', () => {
    const markup = render(stats({ categories_scope: 'own', categories: [{ id: 1, name: 'Зарплата', total: '300000.00' }] }))
    expect(text(markup)).toContain('Только ваши записи: записи других членов семьи видит главный в семье. Итог выше — доход всей семьи.')
    expect(text(markup)).toContain('Зарплата 300 000 ₸')
    expect(text(render(stats({ categories_scope: 'own', categories: [] })))).toContain('Ваших записей дохода за период нет.')
  })
  it('asks for an income instead of a zero, and names the sums without a rate', () => {
    const markup = render(stats({ income: null, saved: null, saved_percent: null, categories: [], excluded: [{ currency: 'USD', total: '170.00' }] }))
    expect(text(markup)).toContain('За период доход не внесён: отложенное считать не из чего.')
    expect(text(markup)).toContain('Доходов за период нет.')
    expect(markup).toContain('<a class="action-link" href="/receipts/new?kind=income">Внести доход</a>')
    expect(text(markup)).toContain('Нет курса Нацбанка — не вошли: 170 $.')
  })
  it('draws income against spends and what was saved, month by month', () => {
    const lines = incomeSeries({ months: 2, month_from: '2026-09', month_to: '2026-10', base_currency: 'KZT', excluded: [], items: [
      { month: '2026-09', income: null, spent: '10.00', saved: null, saved_percent: null },
      { month: '2026-10', income: '950000.00', spent: '200000.00', saved: '750000.00', saved_percent: '78.95' },
    ] }, true)
    expect(lines.map((line) => [line.label, line.points.length])).toEqual([['Доход', 1], ['Потрачено', 2], ['Отложено', 1]])
  })
})
