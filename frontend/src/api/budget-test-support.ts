import type { BudgetLimit, Dashboard } from './budget-types'

/** The example of the contract and of the approved mockup: a family of Андрей and Лиза, October 2026, tenge. */
export function dashboardFixture(): Dashboard {
  return {
    month: '2026-10', previous_month: '2026-09', days_left: 19, members: ['andrey', 'liza'],
    currencies: [{
      currency: 'KZT', spent: '287450.00', previous_spent: '326100.00', limit_total: '400000.00', limited_spent: '287450.00',
      categories: [
        { category_id: 3, name: 'Продукты', spent: '92300.00', limit: '120000.00', limit_id: 7 },
        { category_id: 8, name: 'Кафе', spent: '54300.00', limit: '50000.00', limit_id: 8 },
        { category_id: 11, name: 'Транспорт', spent: '21500.50', limit: null, limit_id: null },
        { category_id: 1, name: 'Не разобрано', spent: '1200.00', limit: null, limit_id: null },
        { category_id: 6, name: 'Дом', spent: '0.00', limit: '30000.00', limit_id: 9 },
      ],
    }],
    recent: [
      { id: 12, source: 'photo', title: 'Magnum', category_name: 'Продукты', owner: 'liza', purchased_on: '2026-10-12', total: '18940.00', currency: 'KZT', lines_count: 23 },
      { id: 13, source: 'manual', title: 'Такси до аэропорта', category_name: 'Транспорт', owner: 'andrey', purchased_on: '2026-10-11', total: '4500.00', currency: 'KZT', lines_count: 1 },
      { id: 14, source: 'photo', title: 'Кофейня', category_name: null, owner: 'andrey', purchased_on: '2026-10-01', total: '1500.50', currency: 'KZT', lines_count: 1 },
    ],
  }
}

export function limitFixture(overrides: Partial<BudgetLimit> = {}): BudgetLimit {
  return { id: 7, category_id: 3, category_name: 'Продукты', currency: 'KZT', amount: '120000.00', ...overrides }
}
