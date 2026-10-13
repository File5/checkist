import { readFileSync } from 'node:fs'
import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Income, IncomeMonth, IncomeSummary, IncomeTrends } from '../../api/incomes'
import { buildRoute, parseRoute } from '../../navigation'
import { ExpenseForm } from '../expense/ExpensePage'
import { draftFromIncome, emptyDraft, incomeBody, incomeChip, serverErrors } from '../expense/expense-form'
import { draftFromParse } from '../expense/parse-text'
import { IncomeSummaryView } from './IncomeSummary'
import { IncomesView } from './IncomesPage'
import { incomeSeries, summaryParts } from './incomes-state'

const NBSP = String.fromCharCode(0xa0)
const plain = (text: string) => text.replaceAll(NBSP, ' ')
const html = (node: ReactElement) => plain(renderToStaticMarkup(node).replace(/<svg\b.*?<\/svg>/g, ''))

const summary = (patch: Partial<IncomeSummary> = {}): IncomeSummary => ({
  month: '2026-10', base_currency: 'KZT', income: '950000.00', spent: '200000.00', saved: '750000.00', saved_percent: '78.95',
  excluded: [], ...patch,
})
const salary: Income = {
  id: 7, received_on: '2026-10-05', amount: '650000.00', currency: 'KZT', category: { id: 1, name: 'Зарплата' }, note: 'аванс',
  owner: 'liza', owner_name: 'Лиза', base_amount: '650000.00',
}

describe('the income line of «Главная» (Vitest/SSR, not browser visual acceptance)', () => {
  it('shows income, spent and saved with its share; no income is a request, not a zero', () => {
    expect(summaryParts(summary(), 'KZT')?.map((part) => [part.label, plain(part.value), part.note && plain(part.note)])).toEqual([
      ['Доход', '950 000 ₸', undefined], ['Потрачено', '200 000 ₸', undefined], ['Отложено', '750 000 ₸', '79 %'],
    ])
    expect(summaryParts(summary({ saved: '-50000.00', saved_percent: '-5.26' }), 'KZT')?.[2]).toEqual({ label: 'Перерасход', value: `50${NBSP}000${NBSP}₸`, note: `5${NBSP}%` })
    expect(summaryParts(summary({ income: null, saved: null, saved_percent: null }), 'KZT')).toBeNull()
    expect(html(<IncomeSummaryView data={summary({ income: null, saved: null, saved_percent: null })} />))
      .toBe('<p class="ck-panel inc-summary inc-summary-empty">Доход не внесён — <a href="/receipts/new?kind=income">добавить</a></p>')
    const line = html(<IncomeSummaryView data={summary()} />)
    expect(line).toContain('<div class="inc-summary-item"><dt>Доход</dt><dd class="ck-figures">950 000 ₸</dd></div>')
    expect(line).toContain('<dt>Отложено</dt><dd class="ck-figures">750 000 ₸<span class="inc-summary-note"> (79 %)</span></dd>')
    expect(line).toContain('<a class="inc-summary-link" href="/incomes?month=2026-10">Доходы</a>')
  })
  it('is one line of the dashboard, right before the regular payments', () => {
    const source = readFileSync(new URL('../dashboard/DashboardPage.tsx', import.meta.url), 'utf8')
    expect(source).toContain('      <IncomeSummary month={data.month} />\n      <RecurringDue month={data.month} />\n')
  })
})

describe('/incomes (Vitest/SSR)', () => {
  it('lists the visible records of the month with the family total and the categories', () => {
    const data: IncomeMonth = { month: '2026-10', base_currency: 'KZT', family_total: '950000.00', results: [salary] }
    const page = html(<IncomesView data={data} categories={[{ id: 1, name: 'Зарплата', built_in: true }]} />)
    expect(page).toContain('<h2 id="inc-month-heading">Октябрь 2026</h2>')
    expect(page).toContain('aria-label="Прошлый месяц" href="/incomes?month=2026-09"')
    expect(page).toContain('<span>Доход семьи</span><strong class="ck-figures">950 000 ₸</strong>')
    expect(page).toContain('<a class="ck-row" href="/incomes/7/edit">')
    expect(page).toContain('<span class="ck-row-meta">5 октября · Лиза · аванс</span>')
    expect(page).toContain('<a class="inc-add" href="/receipts/new?kind=income">Добавить доход</a>')
    expect(page).toContain('<li class="inc-chip">Зарплата</li>')
    const nothing = html(<IncomesView data={{ ...data, family_total: null, results: [] }} categories={[]} />)
    expect(nothing).toContain('не внесён')
    expect(nothing).toContain('Доходов за месяц пока нет.')
    // A member of the family sees the total but not the records of the others.
    expect(html(<IncomesView data={{ ...data, results: [] }} categories={[]} />)).toContain('Ваших записей за месяц нет.')
  })
  it('has its addresses', () => {
    expect(parseRoute('/receipts/new?kind=income')).toEqual({ kind: 'expense-new', income: true })
    expect(buildRoute({ kind: 'expense-new', income: true })).toBe('/receipts/new?kind=income')
    expect(parseRoute('/incomes?month=2026-09')).toEqual({ kind: 'incomes', month: '2026-09' })
    expect(parseRoute('/incomes?month=2026-13')).toEqual({ kind: 'incomes' })
    expect(buildRoute({ kind: 'incomes', month: '2026-09' })).toBe('/incomes?month=2026-09')
    expect(parseRoute('/incomes/5/edit')).toEqual({ kind: 'income-edit', incomeId: 5 })
    expect(buildRoute({ kind: 'income-edit', incomeId: 5 })).toBe('/incomes/5/edit')
    expect(parseRoute('/incomes/x/edit').kind).toBe('not-found')
  })
})

describe('«Трата / Доход» in the form (Vitest/SSR)', () => {
  const chips = [incomeChip({ id: 1, name: 'Зарплата', built_in: true }), incomeChip({ id: 2, name: 'Подработка', built_in: true })]
  it('draws the income without the place and the positions, every chip in sight', () => {
    const form = html(<ExpenseForm kind="income" draft={{ ...emptyDraft('KZT', '2026-10-13'), amount: '650000', category: 1 }} chips={chips}
      errors={{}} saving={false} onChange={() => {}} onSubmit={() => {}} today="2026-10-13" incomeId={7} />)
    expect(form).not.toContain('expense-place')
    expect(form).not.toContain('Позиции')
    expect(form).not.toContain('Все категории')
    expect(form).toContain('aria-pressed="true" title="Зарплата"')
    expect(form).toContain('Сохранить · 650 000 ₸')
    expect(form).toContain('Удалить доход')
  })
  it('builds the body of an income and reads it back', () => {
    expect(incomeBody({ ...emptyDraft('kzt', '2026-10-13'), amount: '650 000', category: 1, note: ' аванс ' })).toEqual({
      body: { amount: '650000', currency: 'KZT', category: 1, received_on: '2026-10-13', note: 'аванс' },
    })
    expect(incomeBody(emptyDraft('KZT', '2026-10-13'))).toEqual({ errors: { amount: 'Введите сумму больше нуля, не больше двух знаков после запятой.', category: 'Выберите категорию.' } })
    expect(draftFromIncome(salary)).toEqual({ amount: '650000', currency: 'KZT', category: 1, date: '2026-10-05', place: '', note: 'аванс', lines: [] })
    expect(serverErrors(['received_on'])).toEqual({ date: 'Укажите дату покупки.' })
  })
  it('takes «зарплата 650 000» of the parse as an income draft', () => {
    const draft = draftFromParse({ kind: 'income', total: '650000', currency: 'KZT', category: 1, purchased_on: '2026-10-13', store_name: null,
      note: '', lines: [] }, chips)
    expect([draft.amount, draft.category, draft.place, draft.lines]).toEqual(['650000', 1, '', []])
  })
})

describe('«Доход и отложено» of «Динамика»', () => {
  it('draws two lines with a gap for a month without an income', () => {
    const data: IncomeTrends = {
      months: 2, month_from: '2026-09', month_to: '2026-10', base_currency: 'KZT', excluded: [],
      items: [
        { month: '2026-09', income: null, spent: '10.00', saved: null, saved_percent: null },
        { month: '2026-10', income: '950000.00', spent: '200000.00', saved: '750000.00', saved_percent: '78.95' },
      ],
    }
    const [income, saved] = incomeSeries(data)
    expect([income.label, saved.label]).toEqual(['Доход', 'Отложено'])
    expect(income.points.map((point) => [point.x, point.value, plain(point.valueText)])).toEqual([['2026-10-01', 950000, '950 000 ₸']])
    expect(saved.points).toHaveLength(1)
  })
  it('is one line of the screen', () => {
    const source = readFileSync(new URL('../stats/TrendsPage.tsx', import.meta.url), 'utf8')
    expect(source.match(/<IncomeTrend query=\{query\} \/>/g)).toHaveLength(1)
  })
})
