import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { dashboardFixture, limitFixture } from '../../api/budget-test-support'
import type { Dashboard, DashboardAllowance } from '../../api/budget'
import type { Category } from '../../api/types'
import { allowanceView } from './dashboard-state'
import { DashboardView } from './DashboardPage'
import { LimitsView, MonthBudgetPanel } from './LimitsPage'

const nb = (text: string) => text.replaceAll(' ', '\u00a0')
/** Spaces of any width as one: the glue of money (lib/text.ts) is not what these tests check. */
const plain = (text: string) => text.replace(/[\u00a0\u202f]/g, ' ')
const words = (html: string) => plain(html.replace(/<svg\b.*?<\/svg>/g, '').replace(/<[^>]+>/g, ''))
const seen = (value: { note: string }) => ({ ...value, note: plain(value.note) })
const noop = () => {}
const save = async () => undefined
const allowance: DashboardAllowance = {
  currency: 'KZT', basis: 'budget', amount: '700000.00', spent: '287450.00', unpaid: '23000.00', unpaid_count: 2,
  days_left: 19, per_day: '20449.47', overspent: null,
}
const view = (extra: Partial<Dashboard>, today = '2026-10') =>
  renderToStaticMarkup(<DashboardView data={{ ...dashboardFixture(), ...extra }} today={today} date="2026-10-13" />)

describe('«Можно тратить в день» (2026-10-13)', () => {
  it('says the day, the basis, the payments set aside and the days', () => {
    expect(seen(allowanceView(allowance))).toEqual({
      label: 'Можно тратить в день', amount: '20449.47', over: false,
      note: 'Бюджет месяца 700 000 ₸ минус траты и 2 платежа к оплате (23 000 ₸), поровну на 19 дней',
    })
    expect(plain(allowanceView({ ...allowance, basis: 'limits', unpaid: '0.00', unpaid_count: 0, days_left: 1, amount: '400000.00' }).note))
      .toBe('Сумма лимитов 400 000 ₸ минус траты, поровну на 1 день')
    expect(plain(allowanceView({ ...allowance, basis: 'income', unpaid: '0.00', unpaid_count: 0, days_left: 3 }).note))
      .toBe('Доход месяца 700 000 ₸ минус траты, поровну на 3 дня')
  })

  it('is an honest overspend below zero, never a negative day', () => {
    expect(seen(allowanceView({ ...allowance, per_day: null, overspent: '51437.63', unpaid: '0.00', unpaid_count: 0 }))).toEqual({
      label: 'Перерасход', amount: '51437.63', over: true, note: 'Траты больше бюджета месяца 700 000 ₸',
    })
    expect(plain(allowanceView({ ...allowance, basis: 'limits', per_day: null, overspent: '10.00', unpaid_count: 1 }).note))
      .toBe('Траты и 1 платёж к оплате больше суммы лимитов 700 000 ₸')
  })

  it('stands in the hero card of the current month only', () => {
    const html = view({ allowance })
    const hero = html.slice(html.indexOf('dash-hero'), html.indexOf('</section>', html.indexOf('dash-hero')))
    expect(hero).toContain('<div class="dash-allowance"><p class="dash-allowance-line"><span class="dash-allowance-label">Можно тратить в день</span>')
    expect(hero).toContain(`<span class="dash-allowance-value ck-figures">${nb('20 450 ₸')}</span>`)
    expect(view({ allowance: { ...allowance, per_day: null, overspent: '100.00' } })).toContain('<div class="dash-allowance dash-allowance-over">')
    // A past month: the server sends none, and a stale one is not drawn either.
    expect(view({ allowance }, '2026-11')).not.toContain('dash-allowance')
    expect(view({ allowance: null })).not.toContain('dash-allowance')
  })
})

describe('«Бюджет месяца» over the limits (2026-10-13)', () => {
  it('draws its bar at the top of the limits card of its currency', () => {
    const html = view({ budget: { amount: '400000.00', currency: 'KZT', spent: '287450.00' } })
    const card = html.slice(html.indexOf('dash-limits'))
    expect(card.indexOf('dash-budget')).toBeGreaterThan(-1)
    expect(card.indexOf('dash-budget')).toBeLessThan(card.indexOf('dash-limit-list'))
    expect(words(card)).toContain('Бюджет месяца287 450 / 400 000 ₸')
    expect(words(card)).toContain('Осталось 112 550 ₸')
    expect(card).toContain('aria-label="Потрачено 71% бюджета месяца"')
    const over = view({ budget: { amount: '200000.00', currency: 'KZT', spent: '287450.00' } })
    expect(words(over)).toContain('Сверх бюджета на 87 450 ₸')
  })

  it('stands alone in the card without limits and categories, and is absent without a budget', () => {
    const empty = { currencies: [], recent: [] }
    expect(words(view({ ...empty, budget: { amount: '400000.00', currency: 'KZT', spent: '0.00' } }))).toContain('Бюджет месяца')
    expect(view(empty)).toContain('Лимиты на месяц помогают видеть')
    expect(view({ budget: null })).not.toContain('dash-budget')
  })
})

describe('the budget panel of «Лимиты»', () => {
  const category: Category = { id: 3, name: 'Продукты', path: [{ id: 3, name: 'Продукты' }], parent_id: null, depth: 0, children_count: 0,
    generic_products_count: 0, products_count: 0, products_total: 0 }
  const limits = (budget?: Parameters<typeof LimitsView>[0]['budget']) => renderToStaticMarkup(<LimitsView categories={[category]}
    limits={[limitFixture()]} currencies={['KZT']} currency="KZT" base="KZT" family drafts={{}} statuses={{}}
    onCurrency={noop} onAddCurrency={() => undefined} onDraft={noop} onSave={noop} onDelete={noop} budget={budget} />)

  it('comes after the currency, before the rows, with a newer server only', () => {
    const html = limits({ state: { kind: 'ok', budget: { amount: '700000.00', currency: 'KZT', base_currency: 'KZT' } }, onSave: save })
    expect(html.indexOf('limits-budget')).toBeGreaterThan(html.indexOf('limits-currencies'))
    expect(html.indexOf('limits-budget')).toBeLessThan(html.indexOf('limits-list'))
    expect(limits()).not.toContain('limits-budget')
  })

  it('shows the amount, the field in the base currency, «Сохранить» and «Убрать»', () => {
    const html = renderToStaticMarkup(<MonthBudgetPanel family onSave={save}
      state={{ kind: 'ok', budget: { amount: '700000.00', currency: 'KZT', base_currency: 'KZT' } }} />)
    expect(html).toContain('<h2 id="limits-budget-heading" class="limits-small-heading">Бюджет месяца</h2>')
    expect(html).toContain(`<span class="limits-current ck-figures">${nb('700 000 ₸')}</span>`)
    expect(html).toContain('value="700000"')
    expect(html).toContain('<button type="submit" class="limits-budget-save">Сохранить бюджет</button>')
    expect(html).toContain('>Убрать</button>')
    const none = renderToStaticMarkup(<MonthBudgetPanel family={false} onSave={save}
      state={{ kind: 'ok', budget: { amount: null, currency: null, base_currency: 'KZT' } }} />)
    expect(none).toContain('не задан')
    expect(none).toContain('Сколько вы готовы потратить')
    expect(none).not.toContain('Убрать')
    expect(renderToStaticMarkup(<MonthBudgetPanel family onSave={save} state={{ kind: 'error', message: 'Нет связи.' }} />)).toContain('Нет связи.')
  })
})
