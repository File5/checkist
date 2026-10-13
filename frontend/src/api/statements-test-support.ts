/** Fictional statement drafts in the shape of `GET /api/statements/{id}/` for the tests of the client. */
import type { StatementDetail, StatementRow, StatementRule } from './statements'

const food = { id: 1, name: 'Еда и напитки', path: [{ id: 1, name: 'Еда и напитки' }] }
const cafe = { id: 3, name: 'Кафе и рестораны', path: [{ id: 3, name: 'Кафе и рестораны' }] }
const rent = { id: 9, name: 'Аренда', path: [{ id: 8, name: 'Жильё' }, { id: 9, name: 'Аренда' }] }

export function rowFixture(patch: Partial<StatementRow> = {}): StatementRow {
  return {
    id: 1, date: '2026-10-05', amount: '-18450.00', currency: 'KZT', operation: 'Покупка', details: 'ТОО "MAGNUM CASH&CARRY"',
    merchant: 'MAGNUM CASH&CARRY', mcc: null, refund: '0.00', spend: '18450.00', kind: 'spend', state: 'spend', reason: null,
    category: food, store_name: 'MAGNUM', source: 'builtin', ai: null, duplicate_of: null, receipt_id: null, goal: null,
    contribution_id: null, ...patch,
  }
}

/** A draft with a recognised spend, a refund netted in, two questionable rows of one payee (the model answered for
 * one payee, another waits), an entered duplicate, a saved row, a transfer, cash and two incomings. */
export function statementFixture(patch: Partial<StatementDetail> = {}): StatementDetail {
  return {
    id: 4, bank: 'kaspi_gold', bank_name: 'Kaspi Gold', date_from: '2026-09-13', date_to: '2026-10-12',
    created_at: '2026-10-13T05:00:00Z', saved_at: null, rows_count: 11, saved_count: 1,
    ai: { waiting: 1, active: true, executor: { available: true, state: 'idle', last_seen_at: null } },
    rows: [
      rowFixture(),
      rowFixture({ id: 2, date: '2026-10-03', amount: '-6400.00', refund: '1200.00', spend: '5200.00' }),
      rowFixture({ id: 3, date: '2026-10-03', amount: '1200.00', spend: '0.00', kind: 'refund', state: 'skipped', reason: 'refund', category: null, source: null }),
      rowFixture({ id: 4, date: '2026-10-01', amount: '-3200.00', spend: '3200.00', details: 'ИП Кофейня Зерно', merchant: 'ИП Кофейня Зерно', store_name: 'ИП Кофейня Зерно', state: 'review', category: cafe, source: 'model', ai: 'done' }),
      rowFixture({ id: 5, date: '2026-09-30', amount: '-3300.00', spend: '3300.00', details: 'ИП Кофейня Зерно', merchant: 'ИП Кофейня Зерно', store_name: 'ИП Кофейня Зерно', state: 'review', category: cafe, source: 'model', ai: 'done' }),
      rowFixture({ id: 6, date: '2026-09-29', amount: '-8900.00', spend: '8900.00', details: 'Студия йоги Лотос', merchant: 'Студия йоги Лотос', store_name: 'Студия йоги Лотос', state: 'review', category: null, source: null, ai: 'waiting' }),
      rowFixture({ id: 7, date: '2026-09-28', amount: '-4500.00', spend: '4500.00', state: 'duplicate', reason: 'duplicate', category: null, source: null,
        duplicate_of: { id: 70, purchased_on: '2026-09-28', total: '4500.00', currency: 'KZT', store_name: 'Кафе Дубль' }, details: 'Кафе Дубль', merchant: 'Кафе Дубль', store_name: 'Кафе Дубль' }),
      rowFixture({ id: 8, date: '2026-09-27', amount: '-1450.00', spend: '1450.00', receipt_id: 81, details: 'YANDEX.GO', merchant: 'YANDEX.GO', store_name: 'Yandex Go' }),
      rowFixture({ id: 9, date: '2026-09-20', amount: '-220000.00', spend: '220000.00', operation: 'Перевод', details: 'Олег Б.', merchant: 'Олег Б.', kind: 'transfer', state: 'skipped', reason: 'transfer', category: null, store_name: null, source: null }),
      rowFixture({ id: 10, date: '2026-09-19', amount: '150000.00', spend: '0.00', operation: 'Пополнение', details: 'С Kaspi Депозита', merchant: 'С Kaspi Депозита', kind: 'own_move', state: 'skipped', reason: 'own_move', category: null, store_name: null, source: null }),
      rowFixture({ id: 11, date: '2026-09-18', amount: '35000.00', spend: '0.00', operation: 'Перевод', details: 'Дмитрий С.', merchant: 'Дмитрий С.', kind: 'income', state: 'skipped', reason: 'income', category: null, store_name: null, source: null }),
      rowFixture({ id: 12, date: '2026-09-17', amount: '412.00', spend: '0.00', operation: 'Разное', details: 'Kaspi Бонус: кэшбэк', merchant: 'Kaspi Бонус: кэшбэк', kind: 'income', state: 'skipped', reason: 'income', category: null, store_name: null, source: null }),
    ],
    ...patch,
  }
}

export function ruleFixture(patch: Partial<StatementRule> = {}): StatementRule {
  return {
    id: 1, pattern: 'Олег Б.', action: 'category', category: rent, store_name: 'Съёмное жильё', goal: null, origin: 'manual',
    updated_at: '2026-10-13T05:00:00Z', ...patch,
  }
}
