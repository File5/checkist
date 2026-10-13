import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { TrendsMonthlyCurrency } from '../../api/trends'
import { statsIncomesHref } from '../../navigation'
import { MonthRowCards, MonthToMonthBlock } from './trends-dashboard'
import TrendsPeriodPicker, { PeriodForm } from './trends-period-picker'
import { monthRows } from './trends-state'

const html = (node: React.ReactElement) => renderToStaticMarkup(node).replace(/[\u00a0\u202f]/g, ' ')
const text = (markup: string) => markup.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ')
const count = (markup: string, needle: string) => markup.split(needle).length - 1

describe('«Динамика» period (Vitest/SSR, not browser acceptance)', () => {
  it('shows the ready periods as chips in one row, the period in words and the inline form on a wide screen', () => {
    const markup = html(<TrendsPeriodPicker query={{ from: '2026-05', to: '2026-10', category: 3 }} current="2026-10" first="2025-02" narrow={false} native={false} />)
    expect(markup).toContain('role="region" aria-label="Готовые периоды"')
    expect(count(markup, 'class="ck-chip"')).toBe(7)
    expect(markup).toContain('<a class="ck-chip" aria-current="true" href="/stats/trends?from=2026-05&amp;to=2026-10&amp;category=3">6 месяцев</a>')
    expect(markup).toContain('href="/stats/trends?from=2025-02&amp;to=2026-10&amp;category=3">Всё время</a>')
    expect(text(markup)).toContain('Период: май 2026 — октябрь 2026 , 6 месяцев')
    expect(markup).toContain('name="from" value="05.2026"')
    expect(markup).toContain('placeholder="ММ.ГГГГ"')
    expect(markup).not.toContain('role="dialog"')
    expect(text(markup)).toContain('не больше 60 месяцев')
  })
  it('on a phone shows one button «Период: …» and keeps the ready periods and «Свой период» in its sheet', () => {
    const closed = html(<TrendsPeriodPicker query={{}} current="2026-10" first={undefined} narrow native />)
    expect(closed).toContain('<button type="button" class="stats-period-open" aria-haspopup="dialog" aria-expanded="false"><span class="stats-period-text"><span class="stats-period-word">Период: </span><strong>12 месяцев</strong></span>')
    expect(closed).not.toContain('<form')
    expect(closed).not.toContain('ck-chip')
    const custom = html(<TrendsPeriodPicker query={{ from: '2026-05', to: '2026-10', category: 3 }} current="2026-10" first="2024-01" narrow native />)
    expect(custom).toContain('<strong>6 месяцев</strong>')
    expect(html(<TrendsPeriodPicker query={{ from: '2026-02', to: '2026-10' }} current="2026-10" first="2024-01" narrow native />))
      .toMatch(/<strong>фев\.? 2026 — окт\.? 2026<\/strong>/)
    const open = html(<TrendsPeriodPicker query={{ category: 3 }} current="2026-10" first={undefined} narrow native open />)
    expect(open).toContain('role="dialog"')
    expect(open).toContain('<p class="trends-period-current" aria-live="polite">')
    expect(open).toContain('<span class="stats-period-choice" aria-disabled="true" title="Узнаём, с какого месяца есть чеки…">')
    expect(open).toMatch(/<a class="stats-period-choice" aria-current="true" href="\/stats\/trends\?from=2025-11&amp;to=2026-10&amp;category=3">.*12 месяцев.*<\/a>/)
    expect(open).toContain('<h3 class="stats-period-custom">Свой период</h3>')
    expect(open).toContain('<form class="trends-period-form" noValidate="" aria-label="Свой период">')
  })
  it('leads the ready periods of «Доходы» to its own address', () => {
    const open = html(<TrendsPeriodPicker query={{ months: 24 }} current="2026-10" first="2026-01" narrow native open
      hrefOf={(period) => statsIncomesHref(period)} />)
    expect(open).toContain('href="/stats/incomes?from=2026-08&amp;to=2026-10"')
    expect(open).toMatch(/<a class="stats-period-choice" aria-current="true" href="\/stats\/incomes\?from=2024-11&amp;to=2026-10">/)
  })
  it('uses the native month field where the browser has one', () => {
    const markup = html(<PeriodForm period={{ from: '2026-05', to: '2026-10' }} current="2026-10" native onApply={() => {}} />)
    expect(markup).toContain('type="month"')
    expect(markup).toContain('name="to" value="2026-10"')
    expect(markup).not.toContain('placeholder="ММ.ГГГГ"')
  })
})

/** Shaped like the person's data: rent 200 000 in June and 220 000 from July, utilities and ОСИ monthly; 6 months to October. */
function realBlock(): TrendsMonthlyCurrency {
  const months = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10']
  const row = (id: number, name: string, amounts: string[], total: string, average: string, changes: (string | null)[]) => ({
    id, name, parent_id: 1, depth: 1, direct: false, total, amounts, change_percent: changes.at(-1) ?? null, average, change_percents: changes,
  })
  return {
    currency: 'KZT', total: '1219084.00', average: '203180.67', categories: [{ id: 1, name: 'Жильё', unassigned: false, total: '1219084.00' }],
    months: months.map((month) => ({ month, total: '0.00', categories: [], uncategorized: '0.00' })),
    summary: { month: '2026-10', spent: '248192.00', previous_month: '2026-09', previous: '240391.00', change_percent: '3.25', average_change_percent: '22.15' },
    rows: [
      row(2, 'Аренда', ['0.00', '200000.00', '220000.00', '220000.00', '220000.00', '220000.00'], '1080000.00', '180000.00', [null, null, '10.00', '0.00', '0.00', '0.00']),
      row(3, 'Коммунальные услуги', ['9800.00', '8100.00', '7900.00', '8300.00', '10732.00', '18923.00'], '63755.00', '10625.83', [null, '-17.35', '-2.47', '5.06', '29.30', '76.32']),
      row(4, 'Обслуживание дома (ОСИ/КСК)', ['0.00', '0.00', '0.00', '0.00', '9659.00', '9269.00'], '18928.00', '3154.67', [null, null, null, null, null, '-4.04']),
    ],
  }
}

describe('«Месяц к месяцу» with every month of the period', () => {
  it('gives every row all six months, the sum and the average; the line starts at the first month with spending', () => {
    const [rent, utilities, osi] = monthRows(realBlock(), { from: '2026-05', to: '2026-10' })
    expect(rent.months.map((cell) => [cell.month, cell.amount.replace(/\s/g, ' '), cell.badge?.text.replace(/\s/g, ' ') ?? null])).toEqual([
      ['2026-05', '0 ₸', null], ['2026-06', '200 000 ₸', null], ['2026-07', '220 000 ₸', '+10,00 %'],
      ['2026-08', '220 000 ₸', '0,00 %'], ['2026-09', '220 000 ₸', '0,00 %'], ['2026-10', '220 000 ₸', '0,00 %'],
    ])
    expect([rent.total, rent.average].map((value) => value.replace(/\s/g, ' '))).toEqual(['1 080 000 ₸', '180 000 ₸'])
    expect(rent.values).toHaveLength(5)
    expect(rent.sparkFrom?.replace(/\s/g, ' ')).toBe('с июня 2026')
    expect(utilities.values).toHaveLength(6)
    expect(utilities.sparkFrom).toBeNull()
    expect(osi.values).toEqual([9659, 9269])
  })
  it('on a phone lists all months newest first with the change, then the sum and the average', () => {
    const markup = html(<MonthToMonthBlock state={{ kind: 'ok', data: { months: 6, month_from: '2026-05', month_to: '2026-10', currencies: [realBlock()] } }}
      query={{ from: '2026-05', to: '2026-10' }} onRetry={() => {}} />)
    // The server render is the wide view: six month columns per row.
    expect(count(markup, '<th scope="col" class="trends-number"><time')).toBe(6)
    expect(count(markup, '<td class="trends-number">')).toBe(3 * 9)
    expect(text(markup)).toContain('Итого за период')
    const cards = html(<MonthRowCards rows={monthRows(realBlock(), {})} label="Месяц к месяцу, KZT" />)
    expect(count(cards, 'class="trends-month-strip-row"')).toBe(18)
    const rent = cards.slice(cards.indexOf('Аренда'), cards.indexOf('Коммунальные услуги'))
    expect(rent.indexOf('октябрь 2026')).toBeLessThan(rent.indexOf('май 2026'))
    expect(text(rent)).toContain('с июня 2026')
    expect(text(rent)).toContain('Итого за период 1 080 000 ₸')
    expect(text(rent)).toContain('В среднем за месяц 180 000 ₸')
  })
})
