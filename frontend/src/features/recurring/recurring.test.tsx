import { readFileSync } from 'node:fs'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { monthPaymentFixture, recurringFixture } from '../../api/recurring-test-support'
import type { Category } from '../../api/types'
import { RecurringDueView } from './RecurringDue'
import { RecurringForm, RecurringView } from './RecurringPage'
import {
  amountValue, changeText, counted, decisionNotice, draftBody, draftErrors, draftOf, forMonth, foundText, incomeDue, stateText,
} from './recurring-state'

const NBSP = String.fromCharCode(0xa0)
/** Words are compared with ordinary spaces: `glue` puts no-break ones where a value must not break (checked once). */
const plain = (text: string) => text.replaceAll(NBSP, ' ')
const html = (node: ReactElement) => plain(renderToStaticMarkup(node).replace(/<svg\b.*?<\/svg>/g, ''))
const TODAY = '2026-10-13'

describe('words of regular payments', () => {
  it('names the month, the count and the state', () => {
    expect(plain(forMonth('2026-09', TODAY))).toBe('за сентябрь')
    expect(plain(forMonth('2025-12', TODAY))).toBe('за декабрь 2025')
    expect([1, 3, 5, 11, 22].map((count) => plain(foundText(count)))).toEqual([
      'Нашёл 1 регулярный платёж', 'Нашёл 3 регулярных платежа', 'Нашёл 5 регулярных платежей', 'Нашёл 11 регулярных платежей',
      'Нашёл 22 регулярных платежа',
    ])
    const row = monthPaymentFixture()
    const words = (patch: Partial<typeof row>) => plain(stateText({ ...row, ...patch }, TODAY))
    expect(words({})).toBe('оплачен 5 октября')
    expect(words({ added: true })).toBe('добавлен по средней')
    expect(words({ state: 'overdue', paid: null })).toBe('просрочен с 5 октября')
    expect(words({ state: 'due', due_date: '2026-10-25', paid: null })).toBe('до 25 октября')
    expect(words({ state: 'due', due_date: '2026-10-13', paid: null })).toBe('срок сегодня')
    expect(words({ state: 'due', due_date: '2026-10-14', paid: null })).toBe('срок завтра')
    expect(words({ state: 'skipped' })).toBe('не было')
    expect(words({ state: 'elsewhere' })).toBe('оплачено иначе')
  })
  it('shows a change of the amount only when it is one', () => {
    expect(plain(changeText({ currency: 'USD', last_amount: '225.00', previous_amount: '200.00' }) ?? '')).toBe('было 200 $, стало 225 $')
    expect(changeText({ currency: 'USD', last_amount: '225.00', previous_amount: null })).toBeNull()
  })
  it('tells what an answer did', () => {
    const question = recurringFixture().questions[0]
    const added = decisionNotice(question, 'added', 55, TODAY)
    expect([plain(added.text), added.receiptId]).toEqual(['Добавил трату «Интернет» за сентябрь — 6 700 ₸.', 55])
    expect(plain(decisionNotice(question, 'skipped', null, TODAY).text)).toBe('«Интернет» за сентябрь: отметил, что платежа не было.')
  })
  it('checks the form and builds its body', () => {
    expect(amountValue('6 700,5')).toBe('6700.5')
    expect(amountValue(`6${NBSP}700`)).toBe('6700')
    for (const wrong of ['', '0', '0,00', '-5', '1.234', 'abc']) expect(amountValue(wrong)).toBeNull()
    const empty = draftOf(null, 'KZT')
    expect(Object.keys(draftErrors(empty)).sort()).toEqual(['amount', 'category_id', 'due_day', 'name'])
    expect(draftErrors({ ...empty, name: 'Аренда', category_id: 6, amount: '220000', due_day: '32' })).toEqual({ due_day: 'Число от 1 до 31.' })
    expect(draftBody({ ...empty, name: ' Аренда ', store_name: ' ', category_id: 6, amount: '220 000', due_day: '5', currency: 'kzt' })).toEqual({
      name: 'Аренда', store_name: null, category_id: 6, currency: 'KZT', amount: '220000', due_day: 5, active: true,
    })
    expect(draftOf(monthPaymentFixture(), 'USD')).toEqual({
      name: 'Аренда', store_name: 'Съемное жилье', category_id: 6, currency: 'KZT', amount: '220000', due_day: '5', active: true, kind: 'spend',
    })
    // A regular income: no place, the kind goes with the body.
    const salary = draftOf(null, 'KZT', 'income')
    expect(draftErrors(salary).name).toBe('Назовите доход.')
    expect(draftBody({ ...salary, name: 'Зарплата', store_name: 'Работа', category_id: 1, amount: '650 000', due_day: '10' })).toEqual({
      name: 'Зарплата', store_name: null, category_id: 1, currency: 'KZT', amount: '650000', due_day: 10, active: true, kind: 'income',
    })
  })
})

describe('«Осталось оплатить» on «Главная» (Vitest/SSR, not browser visual acceptance)', () => {
  it('is one line of the dashboard, right after the two big actions', () => {
    const source = readFileSync(new URL('../dashboard/DashboardPage.tsx', import.meta.url), 'utf8')
    expect(source).toContain('      <Actions />\n      <IncomeSummary month={data.month} />\n      <RecurringDue month={data.month} />\n')
  })
  it('draws nothing without payments and suggestions, a quiet line with suggestions alone', () => {
    const empty = recurringFixture({ payments: [], questions: [], suggestions: [], totals: [] })
    expect(html(<RecurringDueView data={empty} />)).toBe('')
    expect(html(<RecurringDueView data={{ ...empty, suggestions: recurringFixture().suggestions }} />))
      .toBe('<p class="ck-panel rec-card rec-hint"><a class="rec-hint-link" href="/recurring">Нашёл 1 регулярный платёж — посмотреть</a></p>')
  })
  it('asks about last month with three answers and lists what is left, the paid ones folded', () => {
    const raw = renderToStaticMarkup(<RecurringDueView data={recurringFixture()} />)
    // An amount never breaks: «6 700 ₸» holds no-break spaces.
    expect(raw).toContain(['6', '700', '₸'].join(NBSP))
    const page = html(<RecurringDueView data={recurringFixture()} />)
    expect(page).toContain('<h2 id="rec-ask-heading">За сентябрь не нашёл оплату</h2>')
    expect(page).toContain('Сам ничего не добавлю — ответьте по каждому платежу.')
    expect(page).toContain('<button type="button" class="rec-ask-add">Добавить по средней <span class="ck-figures">6 700 ₸</span></button>')
    expect(page).toContain('<button type="button" class="ck-button-secondary">Не было</button><button type="button" class="ck-button-secondary">Оплачено иначе</button>')
    expect(page).toContain('<h2 id="rec-due-heading">Осталось оплатить</h2><a class="rec-card-link" href="/recurring">Все</a>')
    expect(page).toContain('2 платежа · <span><span class="ck-figures rec-sum-value">6 700 ₸</span></span><span> + <span class="ck-figures rec-sum-value">20 $</span></span>')
    const open = page.slice(page.indexOf('rec-due-heading'), page.indexOf('<details'))
    expect(open).toContain('<span class="ck-row-title">Интернет</span><span class="ck-row-meta rec-meta-overdue">просрочен с 3 октября</span>')
    expect(open).toContain('<span class="ck-row-meta rec-meta-due">до 25 октября</span>')
    expect(open).not.toContain('Аренда')
    expect(page).toContain('<details class="rec-closed"><summary>Оплачено 1 из 3</summary>')
    expect(page).toContain('<p class="rec-more"><a class="rec-hint-link" href="/recurring">Нашёл 1 регулярный платёж — посмотреть</a></p>')
  })
  it('without the history of payments offers the expected amount, not «по средней»', () => {
    const data = recurringFixture()
    const page = html(<RecurringDueView data={{ ...data, questions: [{ ...data.questions[0], from_history: false, amount: '1990.00' }] }} />)
    expect(page).toContain('>Добавить <span class="ck-figures">1 990 ₸</span></button>')
  })
  it('says «Всё оплачено» and names a past month', () => {
    const paid = recurringFixture({ payments: [monthPaymentFixture()], questions: [], suggestions: [], totals: [{ currency: 'KZT', payments: 1, done: 1, left: null }] })
    expect(html(<RecurringDueView data={paid} />)).toContain('<h2 id="rec-due-heading">Регулярные платежи</h2>')
    expect(html(<RecurringDueView data={paid} />)).toContain('<p class="rec-all-paid">Всё оплачено</p>')
    const past = recurringFixture({ month: '2026-09', questions: [] })
    expect(html(<RecurringDueView data={past} />)).toContain('<h2 id="rec-due-heading">Не оплачено в сентябре</h2>')
  })
})

describe('/recurring (Vitest/SSR, not browser visual acceptance)', () => {
  it('explains the rule, offers the suggestions, lists the month with a strip of six months and the change of the amount', () => {
    const page = html(<RecurringView data={recurringFixture()} />)
    expect(page).toContain('два из трёх: место, категория, сумма')
    expect(page).toContain('<h2 id="rec-suggest-heading">Нашёл по истории</h2>')
    expect(page).toContain('<span class="ck-row-meta">около 10-го · 6 месяцев подряд · Связь и подписки</span>')
    expect(page).toContain('<button type="button">Добавить</button><button type="button" class="ck-button-secondary">Не надо</button>')
    expect(page).toContain('<h2 id="rec-list-heading">Октябрь 2026</h2><span class="rec-head-meta">оплачено 1 из 3</span>')
    expect(page).toContain('<span class="ck-row-meta rec-change ck-figures">было 6 700 ₸, стало 7 200 ₸</span>')
    expect(page).toContain('<span class="rec-history" role="img" aria-label="Полгода: май 2026 — оплачен, июнь 2026 — оплачен, июль 2026 — оплачен, '
      + 'август 2026 — оплачен, сентябрь 2026 — не оплачен, октябрь 2026 — не оплачен">')
    expect(page.match(/class="rec-dot rec-dot-overdue"/g)).toHaveLength(2)
    expect(page).toContain('<button type="button" class="rec-add" aria-haspopup="dialog">Добавить платёж</button>')
    expect(page).not.toContain('Выключены')
  })
  it('keeps the payments that are off in their own card and invites to add the first one', () => {
    const off = recurringFixture({ payments: [monthPaymentFixture({ state: 'inactive', active: false, paid: null })], suggestions: [], questions: [] })
    const page = html(<RecurringView data={off} />)
    expect(page).toContain('<h2 id="rec-off-heading">Выключены</h2>')
    expect(page).toContain('Регулярных платежей пока нет.')
    expect(page).not.toContain('rec-history')
  })
  it('draws the form as rows, the deletion behind one more question', () => {
    const categories = [
      { id: 5, name: 'Жильё', path: [], parent_id: null, depth: 0 }, { id: 6, name: 'Аренда', path: [{ id: 5, name: 'Жильё' }], parent_id: 5, depth: 1 },
      { id: 9, name: 'Не разобрано', path: [], parent_id: null, depth: 0 },
    ].map((category) => ({ ...category, children_count: 0, generic_products_count: 0, products_count: 0, products_total: 0 })) as Category[]
    const form = html(<RecurringForm payment={monthPaymentFixture()} categories={categories} currency="KZT" busy={false} onSubmit={() => {}} onDelete={() => {}} />)
    expect(form).toContain('<label class="rec-field" for="rec-form-name"><span>Название</span><input id="rec-form-name" maxLength="100" placeholder="Аренда" aria-invalid="false" value="Аренда"/></label>')
    // A sub-category is indented by two no-break spaces a level.
    expect(form).toContain('<option value="5">Жильё</option><option value="6" selected="">  Аренда</option>')
    expect(form).not.toContain('Не разобрано')
    expect(form).toContain('<span>Включён</span><input id="rec-form-active" type="checkbox" checked=""/>')
    expect(form).toContain('<button type="submit" class="rec-save">Сохранить</button><button type="button" class="ck-button-danger">Удалить платёж</button>')
    const fresh = html(<RecurringForm payment={null} categories={categories} currency="USD" busy={false} onSubmit={() => {}} />)
    expect(fresh).toContain('value="USD"')
    expect(fresh).not.toContain('Включён')
    expect(fresh).toContain('<button type="submit" class="rec-save">Добавить платёж</button>')
  })
})

describe('regular income (Vitest/SSR, not browser visual acceptance)', () => {
  const salary = monthPaymentFixture({
    id: 4, kind: 'income', name: 'Зарплата', store: null, category: { id: 1, name: 'Зарплата' }, amount: '650000.00', due_day: 12,
    state: 'overdue', due_date: '2026-10-12', paid: null,
  })
  it('asks «внести?» from a few days before its day, never counts it as a payment to make', () => {
    const data = recurringFixture({ payments: [...recurringFixture().payments, salary] })
    expect(incomeDue(data).map((row) => row.id)).toEqual([4])
    expect(incomeDue({ ...data, payments: [{ ...salary, due_date: '2026-10-25', state: 'due' }] })).toEqual([])
    expect(incomeDue({ ...data, payments: [{ ...salary, due_date: '2026-10-16', state: 'due' }] }).map((row) => row.id)).toEqual([4])
    expect(incomeDue({ ...data, payments: [{ ...salary, state: 'paid' }] })).toEqual([])
    expect(incomeDue({ ...data, month: '2026-09' })).toEqual([])
    expect(counted(data).map((row) => row.id)).toEqual([1, 2, 3])
    const page = html(<RecurringDueView data={data} />)
    expect(page).toContain('<h2 id="inc-due-heading">Регулярный доход</h2>')
    expect(page).toContain('<span class="inc-due-name">Зарплата 650 000 ₸ — внести?</span>')
    expect(page).toContain('<input inputMode="decimal" autoComplete="off" aria-label="Сумма «Зарплата», KZT" aria-invalid="false" value="650000"/>'
      + '<button type="submit">Внести</button>')
    // Alone, without payments: the question still comes.
    expect(html(<RecurringDueView data={recurringFixture({ payments: [salary], questions: [], suggestions: [], totals: [] })} />))
      .toContain('Зарплата 650 000 ₸ — внести?')
  })
  it('says «получен» and lists the regular income in its own card of /recurring', () => {
    expect(plain(stateText({ ...salary, state: 'paid', paid: { receipt_id: null, purchased_on: '2026-10-11', total: '600000.00' } }, TODAY)))
      .toBe('получен 11 октября')
    expect(plain(stateText(salary, TODAY))).toBe('не внесён, срок 12 октября')
    const page = html(<RecurringView data={recurringFixture({ payments: [salary] })} />)
    expect(page).toContain('<h2 id="rec-income-heading">Регулярный доход</h2>')
    expect(page).toContain('<span class="ck-row-title">Зарплата</span>')
    expect(page).toContain('<button type="button" class="ck-button-secondary rec-add" aria-haspopup="dialog">Добавить доход</button>')
    const form = html(<RecurringForm payment={null} kind="income" categories={[]} incomeCategories={[{ id: 1, name: 'Зарплата', built_in: true }]}
      currency="KZT" busy={false} onSubmit={() => {}} />)
    expect(form).not.toContain('rec-form-store')
    expect(form).toContain('<option value="1">Зарплата</option>')
    expect(form).toContain('<button type="submit" class="rec-save">Добавить доход</button>')
  })
})
