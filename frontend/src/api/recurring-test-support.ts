import type { RecurringMonth, RecurringMonthPayment, RecurringState } from './recurring.ts'

const history = (states: RecurringState[]) => states.map((state, index) => ({ month: `2026-${String(index + 5).padStart(2, '0')}`, state }))

/** A payment of October 2026 in the shape of `GET /api/recurring/`. */
export function monthPaymentFixture(patch: Partial<RecurringMonthPayment> = {}): RecurringMonthPayment {
  return {
    id: 1, name: 'Аренда', store: { id: 7, name: 'Съемное жилье' }, category: { id: 6, name: 'Аренда' }, currency: 'KZT',
    amount: '220000.00', due_day: 5, active: true, created_by: { username: 'local', display_name: 'Андрей' },
    state: 'paid', due_date: '2026-10-05', paid: { receipt_id: 101, purchased_on: '2026-10-05', total: '220000.00' }, added: false,
    average: '220000.00', last_amount: '220000.00', previous_amount: null,
    history: history(['paid', 'paid', 'paid', 'paid', 'paid', 'paid']),
    ...patch,
  }
}

/** October 2026, the 13th: rent paid, internet and a subscription open, a question about September, two suggestions. */
export function recurringFixture(patch: Partial<RecurringMonth> = {}): RecurringMonth {
  return {
    month: '2026-10', previous_month: '2026-09', today: '2026-10-13',
    payments: [
      monthPaymentFixture(),
      monthPaymentFixture({
        id: 2, name: 'Интернет', store: { id: 8, name: 'Beeline' }, category: { id: 11, name: 'Интернет' }, amount: '6700.00', due_day: 3,
        state: 'overdue', due_date: '2026-10-03', paid: null, average: '6700.00', last_amount: '7200.00', previous_amount: '6700.00',
        history: history(['paid', 'paid', 'paid', 'paid', 'overdue', 'overdue']),
      }),
      monthPaymentFixture({
        id: 3, name: 'ChatGPT', store: null, category: { id: 15, name: 'Связь и подписки' }, currency: 'USD', amount: '20.00', due_day: 25,
        state: 'due', due_date: '2026-10-25', paid: null, average: null, last_amount: null, history: history(['before', 'before', 'before', 'before', 'before', 'due']),
      }),
    ],
    questions: [{ payment_id: 2, name: 'Интернет', month: '2026-09', due_date: '2026-09-03', currency: 'KZT', amount: '6700.00', from_history: true }],
    suggestions: [
      { store_id: 9, store_name: 'YouTube Premium', category_id: 15, category_name: 'Связь и подписки', currency: 'KZT', amount: '2990.00',
        due_day: 10, months: 6, last_date: '2026-10-04', name: 'YouTube Premium' },
    ],
    totals: [{ currency: 'KZT', payments: 2, done: 1, left: '6700.00' }, { currency: 'USD', payments: 1, done: 0, left: '20.00' }],
    ...patch,
  }
}
