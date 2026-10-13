import type { ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { addContribution, createGoal, isGoal, isGoalDetail } from '../../api/goals'
import type { Goal, GoalDetail } from '../../api/goals'
import { clearRecognitionCsrf } from '../../api/local'
import { publicFixture } from '../../api/recognition-test-support'
import { headerAction } from '../../menu/back-target'
import { buildRoute, parseRoute } from '../../navigation/routes'
import { ContributionForm, GoalForm } from './GoalForms'
import { GoalView } from './GoalPage'
import { GoalsView } from './GoalsPage'
import {
  barShare, contributionBody, deadlineText, excludedText, goalBody, goalDraftOf, goalErrors, goalMeta, moneyValue, paceText, savedOf,
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
    pace: { per_month: '40000.00', months_left: 9 }, need_per_month: '49714.29', overdue: false, ...patch,
  }
}
function detail(patch: Partial<GoalDetail> = {}): GoalDetail {
  return {
    ...goal(), people: [andrey, liza],
    contributions: [
      { id: 7, amount: '100000.00', currency: 'KZT', date: '2026-10-03', user: liza, note: 'Выписка Kaspi Gold' },
      { id: 6, amount: '52000.00', currency: 'KZT', date: '2026-09-10', user: andrey, note: '' },
    ],
    ...patch,
  }
}

describe('words of a goal', () => {
  it('tells the progress, the pace and the deadline', () => {
    expect(plain(savedOf(goal()))).toBe('252 000 из 600 000 ₸')
    expect(plain(goalMeta(goal()))).toBe('Общая · до 30 апр. 2027')
    expect(plain(goalMeta(goal({ shared: false, owner: liza, deadline: null })))).toBe('Личная · Лиза')
    expect(plain(goalMeta(goal({ reached: true })))).toBe('Общая · цель достигнута')
    expect(plain(goalMeta(goal({ overdue: true })))).toBe('Общая · срок 30 апр. 2027 прошёл')
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
    expect(goalBody(draft, true)).toEqual({ name: 'Отпуск', amount: '600000', currency: 'KZT', deadline: '2027-04-30', shared: true })
    expect(goalBody({ ...draft, deadline: '' }, false)).toEqual({ name: 'Отпуск', amount: '600000', currency: 'KZT', deadline: null })
    expect(Object.keys(goalErrors({ name: '', amount: '-1', currency: 'K', deadline: '', shared: false }))).toEqual(['name', 'amount', 'currency'])
    expect(goalDraftOf(goal(), 'USD', false)).toEqual({ name: 'Отпуск', amount: '600000', currency: 'KZT', deadline: '2027-04-30', shared: true })
    expect(contributionBody({ amount: '5 000', date: '2026-10-13', user: 'liza' })).toEqual({ amount: '5000', date: '2026-10-13', user: 'liza' })
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
})
