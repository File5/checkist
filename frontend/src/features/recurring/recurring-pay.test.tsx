import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { monthPaymentFixture, recurringFixture } from '../../api/recurring-test-support'
import type { RecurringYear } from '../../api/recurring'
import { isRecurringMonth } from '../../api/recurring'
import type { PaymentMethodValue } from '../../lib/payment-methods'
import { RecurringDueView } from './RecurringDue'
import { PayForm, PaymentYear, PaySection } from './RecurringPay'
import { methodName, payExpected, payNotice, yearMonthText } from './recurring-state'

const NBSP = String.fromCharCode(0xa0)
const plain = (text: string) => text.replaceAll(NBSP, ' ')
const html = (node: ReactElement) => plain(renderToStaticMarkup(node).replace(/<svg\b.*?<\/svg>/g, ''))
const TODAY = '2026-10-13'
const paid = (purchased_on: string, total: string, payment_method: PaymentMethodValue) => ({ receipt_id: 100, purchased_on, total, payment_method })
const year: RecurringYear = {
  months: [
    { month: '2026-10', state: 'paid', paid: paid('2026-10-05', '220000.00', 'kaspi_gold') },
    { month: '2026-09', state: 'paid', paid: paid('2026-09-04', '220000.00', '') },
    { month: '2026-08', state: 'elsewhere', paid: null },
    { month: '2026-07', state: 'skipped', paid: null },
    { month: '2026-06', state: 'overdue', paid: null },
    { month: '2026-05', state: 'before', paid: null },
  ],
  total: '440000.00',
  methods: [{ payment_method: 'kaspi_gold', total: '220000.00' }, { payment_method: '', total: '220000.00' }],
}

describe('«Оплатил» and the history of a payment (Vitest/SSR, not browser visual acceptance)', () => {
  it('reads the history of a year and an older server without it', () => {
    const data = recurringFixture({ payments: [monthPaymentFixture({ year }), monthPaymentFixture({ id: 2, year: null })] })
    expect(isRecurringMonth(JSON.parse(JSON.stringify(data)))).toBe(true)
    expect(isRecurringMonth(recurringFixture())).toBe(true)
    const wrong = { ...year, months: [{ ...year.months[0], paid: { ...year.months[0].paid, payment_method: 'visa' } }] }
    expect(isRecurringMonth(recurringFixture({ payments: [monthPaymentFixture({ year: wrong as RecurringYear })] }))).toBe(false)
  })
  it('names a month by its day and way, or by what happened', () => {
    expect(year.months.map((item) => plain(yearMonthText(item, TODAY)))).toEqual([
      '5 октября · Kaspi Gold', '4 сентября · —', 'оплачено иначе', 'не было', 'просрочен', 'ещё не было платежа'])
    expect(yearMonthText({ month: '2026-10', state: 'due', paid: null }, TODAY)).toBe('ещё не срок')
    expect(yearMonthText({ month: '2026-10', state: 'paid', paid: null }, TODAY)).toBe('оплачен')
    expect([methodName('forte'), methodName(''), methodName('', '—')]).toEqual(['ForteBank', 'без способа', '—'])
  })
  it('shows the year by ways of payment, then a row a month without the months before the payment', () => {
    const page = html(<PaymentYear row={monthPaymentFixture({ year })} today={TODAY} />)
    expect(page).toContain('За год оплачено <span class="ck-figures rec-sum-value">440 000 ₸</span>')
    expect(page).toContain('<p class="rec-year-methods"><span class="rec-year-method">Kaspi Gold <span class="ck-figures">220 000 ₸</span></span> · '
      + '<span class="rec-year-method">без способа <span class="ck-figures">220 000 ₸</span></span></p>')
    expect(page).toContain('<span class="ck-row-title">Октябрь 2026</span><span class="ck-row-meta rec-meta-paid">5 октября · Kaspi Gold</span></span>'
      + '<span class="ck-row-amount ck-figures">220 000 ₸</span>')
    expect(page).toContain('<span class="ck-row-meta rec-meta-overdue">просрочен</span></span><span class="ck-row-amount ck-figures">—</span>')
    expect(page.match(/<li /g)).toHaveLength(5)
    expect(page).not.toContain('Май')
    expect(html(<PaymentYear row={monthPaymentFixture({ year: null })} today={TODAY} />)).toBe('')
    expect(html(<PaymentYear row={monthPaymentFixture({ year, kind: 'income' })} today={TODAY} />)).toBe('')
    expect(html(<PaymentYear row={monthPaymentFixture({ year: { months: [year.months[5]], total: null, methods: [] } })} today={TODAY} />)).toBe('')
  })
  it('offers «Оплатил» in the sheet while the month is open, never for an income or a closed month', () => {
    const open = monthPaymentFixture({ state: 'due', due_date: '2026-10-25', paid: null, year })
    const sheet = html(<PaySection row={open} month="2026-10" today={TODAY} busy={false} onPay={() => {}} />)
    expect(sheet).toContain('<button type="button" class="rec-pay-main">Оплатил</button><p class="rec-note">Ожидается 220 000 ₸ до 25 октября</p>')
    expect(sheet).toContain('История оплат')
    expect(sheet).toContain('<h3 class="rec-pay-heading">Изменить платёж</h3></div>')
    expect(html(<PaySection row={monthPaymentFixture({ year })} month="2026-10" today={TODAY} busy={false} onPay={() => {}} />)).not.toContain('Оплатил')
    expect(html(<PaySection row={{ ...open, kind: 'income' }} month="2026-10" today={TODAY} busy={false} onPay={() => {}} />)).toBe('')
    expect(plain(payExpected({ ...open, state: 'overdue', due_date: '2026-10-05' }, TODAY))).toBe('Ожидается 220 000 ₸ · срок был 5 октября')
  })
  it('opens the small form on the expected amount, today and the way chosen last', () => {
    const form = html(<PayForm row={monthPaymentFixture({ state: 'due', paid: null })} today={TODAY} busy={false} onSubmit={() => {}} onCancel={() => {}} />)
    expect(form).toMatch(/<span>Сумма, KZT<\/span><input id="[^"]+-amount" class="ck-figures" inputMode="decimal" autoComplete="off" enterKeyHint="done" placeholder="0" aria-invalid="false" value="220 000"\/>/)
    expect(form).toContain('<button type="button" class="expense-calc-key" aria-label="Плюс">+</button>')
    expect(form).toMatch(/<input id="[^"]+-day" type="date" max="2026-10-13" aria-invalid="false" value="2026-10-13"\/>/)
    expect(form).toMatch(/<span id="([^"]+)-method" class="rec-pay-label">Способ оплаты<\/span><div class="ck-method-chips" role="group" aria-labelledby="\1-method">/)
    expect(form).toContain('aria-pressed="false">Kaspi Gold</button>')
    expect(form).toContain('<button type="submit" class="rec-save">Сохранить · 220 000 ₸</button><button type="button" class="ck-button-secondary">Отмена</button>')
  })
  it('puts «Оплатил» under the amount of an open payment on «Главная», up to the current month only', () => {
    const data = recurringFixture()
    const page = html(<RecurringDueView data={data} onPay={() => {}} />)
    expect(page).toContain('<span class="rec-row-end"><span class="ck-row-amount ck-figures">6 700 ₸</span><button type="button" class="rec-pay-open" '
      + 'aria-haspopup="dialog">Оплатил<span class="rec-visually-hidden"> «Интернет»</span></button></span>')
    // Two open ones get it; the paid one, folded under them, does not.
    expect(page.match(/rec-pay-open/g)).toHaveLength(2)
    expect(html(<RecurringDueView data={data} />)).not.toContain('rec-pay-open')
    expect(html(<RecurringDueView data={{ ...data, month: '2026-11' }} onPay={() => {}} />)).not.toContain('rec-pay-open')
  })
  it('says what «Оплатил» did', () => {
    const input = { month: '2026-10', amount: '221500', payment_method: 'cash' as const, purchased_on: TODAY }
    const notice = payNotice({ name: 'Аренда', currency: 'KZT' }, input, 77, TODAY)
    expect([plain(notice.text), notice.receiptId]).toEqual(['«Аренда» за октябрь оплачен — 221 500 ₸, Наличные.', 77])
    expect(plain(payNotice({ name: 'Аренда', currency: 'KZT' }, { ...input, payment_method: '' }, 77, TODAY).text))
      .toBe('«Аренда» за октябрь оплачен — 221 500 ₸.')
  })
})
