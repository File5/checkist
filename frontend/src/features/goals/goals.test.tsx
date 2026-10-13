import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addContribution, createGoal, isGoal, isGoalDetail, reconcileGoal } from '../../api/goals'
import type { Goal, GoalDetail } from '../../api/goals'
import { clearRecognitionCsrf } from '../../api/local'
import { publicFixture } from '../../api/recognition-test-support'
import { headerAction } from '../../menu/back-target'
import { buildRoute, parseRoute } from '../../navigation/routes'
import { ContributionForm, GoalForm, InterestRecord, ReconcileForm } from './GoalForms'
import { GoalView } from './GoalPage'
import { GoalsView } from './GoalsPage'
import {
  barShare, contributionBody, contributionTitle, deadlineText, depositLines, depositTerms, excludedText, goalBody, goalDraftOf, goalErrors,
  goalMeta, growthSeries, moneyValue, paceText, rateText, rateValue, reconcileBody, savedOf,
} from './goals-state'

const NBSP = String.fromCharCode(0xa0)
const plain = (text: string) => text.replaceAll(NBSP, ' ')
const html = (node: ReactElement) => plain(renderToStaticMarkup(node).replace(/<svg\b.*?<\/svg>/g, ''))
const noop = () => {}
const liza = { username: 'liza', display_name: 'Лиза' }
const andrey = { username: 'andrey', display_name: 'Андрей' }

function goal(patch: Partial<Goal> = {}): Goal {
  return {
    id: 3, name: 'Отпуск', amount: '600000.00', currency: 'KZT', deadline: '2027-04-30', shared: true, owner: null, created_by: andrey,
    saved: '252000.00', percent: 42, remaining: '348000.00', reached: false, excluded: [], contributions_count: 3,
    pace: { per_month: '40000.00', months_left: 9 }, need_per_month: '49714.29', overdue: false,
    kind: 'saving', rate: null, capitalization: 'monthly', deposit: null, ...patch,
  }
}
function detail(patch: Partial<GoalDetail> = {}): GoalDetail {
  return {
    ...goal(), people: [andrey, liza],
    contributions: [
      { id: 7, amount: '100000.00', currency: 'KZT', date: '2026-10-03', user: liza, note: 'Выписка Kaspi Gold', kind: 'deposit' },
      { id: 6, amount: '52000.00', currency: 'KZT', date: '2026-09-10', user: andrey, note: '', kind: 'deposit' },
    ],
    series: null, ...patch,
  }
}

describe('words of a goal', () => {
  it('tells the progress, the pace and the deadline', () => {
    expect(plain(savedOf(goal()))).toBe('252 000 из 600 000 ₸')
    expect(plain(goalMeta(goal(), true))).toBe('до 30 апр. 2027')
    expect(plain(goalMeta(goal({ shared: false, owner: liza, deadline: null }), true))).toBe('Лиза')
    expect(goalMeta(goal({ shared: false, owner: liza, deadline: null }), false)).toBe('')
    expect(plain(goalMeta(deposit(), true))).toBe('депозит 14,5 % · до 30 июн. 2027')
    expect(plain(goalMeta(goal({ reached: true }), true))).toBe('цель достигнута')
    expect(plain(goalMeta(goal({ overdue: true }), true))).toBe('срок 30 апр. 2027 прошёл')
    expect(plain(paceText(goal()) ?? '')).toBe('В среднем откладываете 40 000 ₸ в месяц — до цели ~9 месяцев.')
    expect(plain(paceText(goal({ pace: { per_month: '40000.00', months_left: 1 } })) ?? '')).toContain('~1 месяц.')
    expect(paceText(goal({ pace: null }))).toBe('За последние три месяца взносов не было — прогноза пока нет.')
    expect(paceText(goal({ pace: null, contributions_count: 0 }))).toBeNull()
    expect(paceText(goal({ reached: true }))).toBeNull()
    expect(plain(deadlineText(goal()) ?? '')).toBe('Чтобы успеть к 30 апр. 2027, нужно 49 715 ₸ в месяц.')
    expect(plain(deadlineText(goal({ overdue: true, need_per_month: null })) ?? '')).toBe('Срок 30 апр. 2027 прошёл — осталось 348 000 ₸.')
    expect(deadlineText(goal({ deadline: null, need_per_month: null }))).toBeNull()
    expect(plain(excludedText(goal({ excluded: [{ currency: 'USD', amount: '20.00' }] })) ?? '')).toContain('20 $')
    expect([barShare(goal()), barShare(goal({ percent: 150 }))]).toEqual([42, 100])
  })

  it('reads the forms and builds their bodies', () => {
    expect([moneyValue('600 000'), moneyValue('1200,5'), moneyValue('0'), moneyValue('abc')]).toEqual(['600000', '1200.5', null, null])
    const draft = { ...goalDraftOf(null, 'KZT', true), name: ' Отпуск ', amount: '600 000', deadline: '2027-04-30' }
    expect(goalErrors(draft)).toEqual({})
    expect(goalBody(draft, true)).toEqual({ name: 'Отпуск', amount: '600000', currency: 'KZT', deadline: '2027-04-30', shared: true, kind: 'saving' })
    expect(goalBody({ ...draft, deadline: '' }, false)).toEqual({ name: 'Отпуск', amount: '600000', currency: 'KZT', deadline: null, kind: 'saving' })
    expect(Object.keys(goalErrors({ ...draft, name: '', amount: '-1', currency: 'K', kind: 'deposit', rate: '101' })))
      .toEqual(['name', 'amount', 'currency', 'rate'])
    expect(goalDraftOf(goal(), 'USD', false)).toEqual({ name: 'Отпуск', amount: '600000', currency: 'KZT', deadline: '2027-04-30', shared: true,
      kind: 'saving', rate: '', capitalization: 'monthly' })
    expect(contributionBody({ amount: '5 000', date: '2026-10-13', user: 'liza' })).toEqual({ amount: '5000', date: '2026-10-13', user: 'liza' })
  })
})

const deposit = (patch: Partial<GoalDetail> = {}) => detail({
  name: 'Kaspi Депозит', amount: '1200000.00', deadline: '2027-06-30', saved: '371484.60', kind: 'deposit', rate: '14.50', need_per_month: '82113.07',
  deposit: { deposits: '370000.00', interest: '1484.60', in_a_year: '425210.40', at_deadline: { total: '1012345.67', interest: '62345.67' }, by_interest: false },
  contributions: [
    { id: 9, amount: '115.40', currency: 'KZT', date: '2026-10-13', user: andrey, note: '', kind: 'interest' },
    { id: 7, amount: '100000.00', currency: 'KZT', date: '2026-10-03', user: liza, note: '', kind: 'deposit' },
  ],
  series: [
    { month: '2026-09', total: '270000.00', deposits: '270000.00', forecast: false },
    { month: '2026-10', total: '371484.60', deposits: '370000.00', forecast: false },
    { month: '2026-11', total: '415974.63', deposits: '410000.00', forecast: true },
  ],
  ...patch,
})

describe('words of a deposit', () => {
  it('tells the rate, the interest and the forecasts with interest', () => {
    expect([rateText('14.50'), rateText('12.00'), rateText('0.00'), rateText('100.00')].map(plain)).toEqual(['14,5 %', '12 %', '0 %', '100 %'])
    expect(plain(depositTerms(deposit()) ?? '')).toBe('Депозит · 14,5 % годовых · капитализация ежемесячно')
    expect(plain(depositTerms(deposit({ capitalization: 'none' })) ?? '')).toContain('без капитализации')
    expect(depositTerms(goal())).toBeNull()
    expect(plain(deadlineText(deposit()) ?? '')).toBe('Чтобы к 30 июн. 2027 было 1 200 000 ₸, вносите по 82 114 ₸ в месяц — с процентами.')
    const self = deposit({ need_per_month: '0.00', deposit: { ...deposit().deposit!, by_interest: true } })
    expect(plain(deadlineText(self) ?? '')).toBe('К 30 июн. 2027 цель будет достигнута процентами — без новых взносов.')
    expect(depositLines(deposit()).map(plain)).toEqual([
      'При нынешнем темпе к 30 июн. 2027 будет 1 012 346 ₸, из них проценты 62 346 ₸.',
      'Если больше не вносить — через год будет 425 211 ₸.',
    ])
    expect(depositLines(goal())).toEqual([])
    expect(plain(contributionTitle(deposit().contributions[0]))).toBe('Сверка с банком: +116 ₸')
    expect(plain(contributionTitle({ ...deposit().contributions[0], amount: '-84.60' }))).toBe('Сверка с банком: -85 ₸')
    expect(plain(contributionTitle(deposit().contributions[1]))).toBe('+100 000 ₸')
  })

  it('draws the sum solid, its forecast dashed from the last real month and the contributions apart', () => {
    const [total, forecast, deposits] = growthSeries(deposit())
    expect([total.key, total.points.map((point) => point.x)]).toEqual(['total', ['2026-09-01', '2026-10-01']])
    expect([forecast.key, forecast.slot, forecast.points.map((point) => point.value)]).toEqual(['forecast', 1, [371484.6, 415974.63]])
    expect([deposits.label, deposits.points.length, plain(deposits.points[2].valueText)]).toEqual(['Внесено', 3, '410 000 ₸'])
    expect(growthSeries(deposit({ series: [] })).map((line) => line.key)).toEqual(['total', 'deposits'])
  })

  it('reads the deposit form and the reconciliation', () => {
    expect([rateValue('14,5'), rateValue('0'), rateValue('12 %'), rateValue('101'), rateValue('1,234')]).toEqual(['14.5', '0', '12', null, null])
    const draft = { ...goalDraftOf(null, 'KZT', false), name: 'Депозит', amount: '1 200 000', kind: 'deposit' as const, rate: '14,5' }
    expect(goalBody(draft, false)).toEqual({ name: 'Депозит', amount: '1200000', currency: 'KZT', deadline: null, kind: 'deposit', rate: '14.5',
      capitalization: 'monthly' })
    expect(goalDraftOf(deposit(), 'KZT', false)).toMatchObject({ kind: 'deposit', rate: '14,5', capitalization: 'monthly' })
    expect(reconcileBody({ balance: '371 600', date: '2026-10-13' })).toEqual({ balance: '371600', date: '2026-10-13' })
  })
})

describe('goal screens', () => {
  it('lists shared goals, then personal ones, each row opening its goal', () => {
    const data = { today: '2026-10-13', base_currency: 'KZT', household: true,
      results: [goal(), goal({ id: 4, name: 'Курсы', shared: false, owner: liza, percent: 150, reached: true })] }
    const page = html(<GoalsView data={data} onAdd={noop} />)
    expect(page.indexOf('Общие семьи')).toBeLessThan(page.indexOf('Личные'))
    expect(page).toContain('<a class="ck-row goal-row" href="/goals/3">')
    expect(page).toContain('<span style="width:42%"></span>')
    expect(page).toContain('<span style="width:100%"></span>')
    expect(page).toContain('goal-badge goal-badge-done')
    expect(page).toContain('Новая цель')
    expect(html(<GoalsView data={{ ...data, results: [] }} onAdd={noop} />)).toContain('Целей пока нет')
  })

  it('shows one goal: the saved sum large, the bar, the forecast and the history', () => {
    const page = html(<GoalView goal={detail()} />)
    expect(page.match(/ck-hero-figure/g)).toHaveLength(1)
    expect(page).toContain('<span class="ck-hero-figure">252 000 ₸</span>')
    expect(page).toContain('role="img" aria-label="Накоплено 42 %"')
    expect(page).toContain('В среднем откладываете 40 000 ₸ в месяц — до цели ~9 месяцев.')
    expect(page).toContain('Чтобы успеть к 30 апр. 2027, нужно 49 715 ₸ в месяц.')
    expect(page).toContain('+100 000 ₸')
    expect(page).toContain('3 окт. 2026 · Лиза · Выписка Kaspi Gold')
    expect(page).toContain('Добавить взнос')
    expect(html(<GoalView goal={detail({ contributions: [], reached: true })} />)).toContain('Цель достигнута.')
  })

  it('shows a deposit: the approximate sum, the interest, the growth chart and «Сверить с банком»', () => {
    const page = html(<GoalView goal={deposit()} />)
    expect(page).toContain('Общая · Депозит · 14,5 % годовых · капитализация ежемесячно')
    expect(page).toContain('<span class="ck-hero-figure">≈ 371 485 ₸</span>')
    expect(page).toContain('≈ заработано процентами <span class="ck-figures">1 485 ₸</span>')
    expect(page).toContain('Рост депозита')
    expect(page).toContain('<dd class="ck-figures">370 000 ₸</dd>')
    expect(page).toContain('Сверить с банком')
    expect(page).toContain('Сверка с банком: +116 ₸')
    expect(page).toContain('goal-interest')
    expect(page).toContain('Если больше не вносить — через год будет 425 211 ₸.')
    expect(html(<GoalView goal={deposit({ series: [] })} />)).toContain('График появится после первого взноса.')
    expect(html(<GoalView goal={detail()} />)).not.toContain('Рост депозита')
    const form = html(<GoalForm goal={deposit()} currency="KZT" household busy={false} onSubmit={noop} />)
    expect(form).toContain('Ставка, % годовых')
    expect(form).toContain('value="14,5"')
    expect(form).toContain('aria-pressed="true">Ежемесячно</button>')
    expect(html(<GoalForm goal={null} currency="KZT" household busy={false} onSubmit={noop} />)).not.toContain('Ставка')
    const bank = html(<ReconcileForm currency="KZT" saved="371 485 ₸" today="2026-10-13" busy={false} onSubmit={noop} />)
    expect(bank).toContain('Остаток в банке, ₸')
    expect(bank).toContain('max="2026-10-13"')
    const record = html(<InterestRecord item={deposit().contributions[0]} busy={false} onDelete={noop} />)
    expect(record).toContain('Удалить сверку')
    expect(record).not.toContain('<input')
  })

  it('asks whose the goal is only in a family, and who put money aside only when there are several', () => {
    const form = (household: boolean) => html(<GoalForm goal={null} currency="KZT" household={household} busy={false} onSubmit={noop} />)
    expect(form(true)).toContain('Общая семьи')
    expect(form(false)).not.toContain('Общая семьи')
    expect(html(<GoalForm goal={goal()} currency="KZT" household busy={false} onSubmit={noop} onDelete={noop} />)).toContain('Удалить цель')
    const gift = (people = [andrey, liza]) => html(<ContributionForm item={null} currency="USD" people={people} today="2026-10-13" user="andrey"
      busy={false} onSubmit={noop} />)
    expect(gift()).toContain('Сумма, $')
    expect(gift()).toContain('<option value="liza">Лиза</option>')
    expect(gift([andrey])).not.toContain('Кто отложил')
    expect(gift()).toContain('value="2026-10-13"')
  })

  it('has its addresses and the way back to the list', () => {
    expect(parseRoute('/goals')).toEqual({ kind: 'goals' })
    expect(parseRoute('/goals/5')).toEqual({ kind: 'goal', goalId: 5 })
    expect(parseRoute('/goals/x')).toEqual({ kind: 'not-found', path: '/goals/x' })
    expect(buildRoute({ kind: 'goal', goalId: 5 })).toBe('/goals/5')
    expect(headerAction({ route: { kind: 'goal', goalId: 5 } })).toEqual({ kind: 'back', to: '/goals', label: 'Назад к целям' })
  })
})

const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
beforeEach(() => { clearRecognitionCsrf(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { clearRecognitionCsrf(); vi.unstubAllGlobals() })

describe('goals on the wire', () => {
  it('accepts a goal and refuses a broken one', () => {
    expect(isGoalDetail(detail())).toBe(true)
    expect(isGoal(goal({ pace: null, need_per_month: null }))).toBe(true)
    expect(isGoal({ ...goal(), percent: -1 })).toBe(false)
    expect(isGoal({ ...goal(), saved: 252000 })).toBe(false)
    expect(isGoalDetail(deposit())).toBe(true)
    expect(isGoalDetail({ ...deposit(), kind: 'bond' })).toBe(false)
    expect(isGoalDetail({ ...deposit(), series: [{ month: '2026-13', total: '1.00', deposits: '1.00', forecast: false }] })).toBe(false)
  })

  it('creates a goal and adds a contribution with the CSRF token', async () => {
    fetchMock.mockResolvedValueOnce(json(publicFixture('csrf.json')))
    fetchMock.mockResolvedValueOnce(json(detail(), 201))
    fetchMock.mockResolvedValueOnce(json(detail(), 201))
    expect((await createGoal({ name: 'Отпуск', amount: '600000' })).kind).toBe('ok')
    expect((await addContribution(3, { amount: '5000', date: '2026-10-13' })).kind).toBe('ok')
    const [url, init] = fetchMock.mock.calls[2]
    expect(url).toBe('/api/goals/3/contributions/')
    expect(init?.method).toBe('POST')
    expect(JSON.parse(String(init?.body))).toEqual({ amount: '5000', date: '2026-10-13' })
  })

  it('reconciles a deposit with the bank', async () => {
    fetchMock.mockResolvedValueOnce(json(publicFixture('csrf.json')))
    fetchMock.mockResolvedValueOnce(json(deposit(), 201))
    expect((await reconcileGoal(3, { balance: '371600', date: '2026-10-13' })).kind).toBe('ok')
    const [url, init] = fetchMock.mock.calls[1]
    expect([url, init?.method, JSON.parse(String(init?.body))]).toEqual(['/api/goals/3/reconcile/', 'POST', { balance: '371600', date: '2026-10-13' }])
  })
})
