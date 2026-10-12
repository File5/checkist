/// <reference types="node" />
/** Answers of «Динамика» for the tests: the backend's public examples and a utilities-shaped category like the real data. */
import { statsFixture } from '../../api/stats-test-support'
import { isTrendsCategory, isTrendsLimits, isTrendsMonthly, isTrendsPrices } from '../../api/trends-schema'
import type { TrendsCategory, TrendsLimits, TrendsMonthly, TrendsPrices } from '../../api/trends'

function checked<T>(name: string, guard: (value: unknown) => value is T): T {
  const body = statsFixture(name)
  if (!guard(body)) throw new Error(`${name} does not match the runtime schema`)
  return body
}
export const monthlyFixture = () => checked<TrendsMonthly>('trends-monthly.json', isTrendsMonthly)
export const categoryFixture = () => checked<TrendsCategory>('trends-category.json', isTrendsCategory)
export const suggestedFixture = () => checked<TrendsCategory>('trends-category-suggested.json', isTrendsCategory)
export const pricesFixture = () => checked<TrendsPrices>('trends-prices.json', isTrendsPrices)
export const limitsFixture = () => checked<TrendsLimits>('trends-limits.json', isTrendsLimits)

const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']
const part = (id: number, name: string, amounts: string[], total: string, direct = false) => ({
  id, name, parent_id: 21, depth: 2, direct, total, amounts, change_percent: null,
  average: (Number(total) / amounts.length).toFixed(2), change_percents: amounts.map(() => null),
})
/** Six months of utilities paid as manual spends by sub-category (May — October 2026), like the production data. */
export function utilitiesFixture(): TrendsCategory {
  const body: TrendsCategory = {
    months: 6, month_from: '2026-05', month_to: '2026-10',
    category: { id: 21, name: 'Коммунальные услуги', path: [{ id: 20, name: 'Жильё' }, { id: 21, name: 'Коммунальные услуги' }] },
    suggested: false,
    options: [
      { id: 20, name: 'Жильё', path: ['Жильё'], depth: 0 },
      { id: 22, name: 'Аренда', path: ['Жильё', 'Аренда'], depth: 1 },
      { id: 21, name: 'Коммунальные услуги', path: ['Жильё', 'Коммунальные услуги'], depth: 1 },
      { id: 23, name: 'Электричество', path: ['Жильё', 'Коммунальные услуги', 'Электричество'], depth: 2 },
    ],
    currencies: [{
      currency: 'KZT', total: '147500.00', average: '24583.33',
      months: months.map((month, index) => ({ month, amount: ['28800.00', '17200.00', '17600.00', '18000.00', '30800.00', '35100.00'][index], lines_count: 5 })),
      parts: [
        part(23, 'Электричество', ['9000.00', '9100.00', '9200.00', '9300.00', '9400.00', '9500.00'], '55500.00'),
        part(24, 'Отопление и газ', ['12000.00', '0.00', '0.00', '0.00', '12400.00', '12500.00'], '36900.00'),
        part(25, 'ОСИ/КСК', ['4000.00', '4100.00', '4200.00', '4300.00', '4400.00', '4500.00'], '25500.00'),
        part(26, 'Вода', ['3000.00', '3100.00', '3200.00', '3300.00', '3400.00', '3500.00'], '19500.00'),
        part(27, 'Вывоз мусора', ['800.00', '900.00', '1000.00', '1100.00', '1200.00', '4600.00'], '9600.00'),
        { ...part(21, 'Коммунальные услуги', ['0.00', '0.00', '0.00', '0.00', '0.00', '500.00'], '500.00', true), depth: 1, parent_id: 21 },
      ],
    }],
  }
  if (!isTrendsCategory(body)) throw new Error('the utilities example does not match the runtime schema')
  return body
}
