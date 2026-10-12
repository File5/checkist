import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { dashboardFixture, limitFixture } from '../../api/budget-test-support'
import type { Dashboard } from '../../api/budget'
import type { Category } from '../../api/types'
import { DashboardView } from './DashboardPage'
import { LimitsView } from './LimitsPage'
import type { LimitsViewProps } from './LimitsPage'

const nb = (text: string) => text.replaceAll(' ', '\u00a0')
const view = (data: Dashboard = dashboardFixture(), today = '2026-10') => renderToStaticMarkup(<DashboardView data={data} today={today} />)
const between = (html: string, start: string, end: string) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)))

describe('«Главная» markup (Vitest/SSR, not browser visual acceptance)', () => {
  it('heads the month with steps through the address and the family', () => {
    const html = view()
    expect(html).toContain('<h2 class="dash-month-title">Октябрь\u00a02026</h2>')
    expect(html).toContain('<a class="dash-month-step" aria-label="Предыдущий месяц" href="/?month=2026-09">‹</a>')
    // Nothing after the current month of the device.
    expect(html).toContain('<span class="dash-month-step dash-month-step-off" aria-hidden="true">›</span>')
    expect(html).not.toContain('Следующий месяц')
    expect(html).toContain('<ul class="dash-family" aria-label="Семья">')
    expect(html).toContain('<li class="dash-avatar dash-cat-1" title="andrey"><span aria-hidden="true">A</span><span class="dash-visually-hidden">andrey</span></li>')
    expect(html).toContain('<li class="dash-avatar dash-cat-2" title="liza"><span aria-hidden="true">L</span><span class="dash-visually-hidden">liza</span></li>')
    expect(view(dashboardFixture(), '2026-11')).toContain('<a class="dash-month-step" aria-label="Следующий месяц" href="/?month=2026-11">›</a>')
  })
  it('shows what the family spent, the comparison and the overall limit', () => {
    const spent = between(view(), 'dash-spent', '</section>')
    expect(spent).toContain('<p class="dash-label">Потрачено семьёй</p>')
    expect(spent).toContain(`<p class="dash-total">${nb('287 450 KZT')}</p>`)
    expect(spent).toContain(`<p class="dash-compare dash-compare-less">на\u00a012\u00a0% меньше, чем ${nb('в сентябре')}</p>`)
    expect(spent).toContain('role="progressbar" aria-label="Потрачено 71% общего лимита" aria-valuemin="0" aria-valuemax="100" aria-valuenow="71"')
    expect(spent).toContain('<span class="dash-bar-fill" style="width:71%"></span>')
    expect(spent).toContain(`Осталось <span class="dash-value dash-strong">${nb('112 550 KZT')}</span> из <span class="dash-value">${nb('400 000 KZT')}</span>`)
    expect(spent).toContain(`<span class="dash-days"> · ${nb('ещё 19 дней')}</span>`)
  })
  it('says the overall overspend and drops the days left of a past month', () => {
    const data = dashboardFixture()
    const over = { ...data, currencies: [{ ...data.currencies[0], spent: '410000.00' }] }
    const html = view(over, '2026-11')
    expect(html).toContain('dash-bar dash-bar-over')
    expect(html).toContain(`<span class="dash-over">Сверх лимита на <span class="dash-value">${nb('10 000 KZT')}</span></span>`)
    expect(html).not.toContain('dash-days')
  })
  it('has the two big actions: the camera of «Снять чек» and the form of «Трата»', () => {
    const actions = between(view(), 'dash-actions', '</div>')
    expect(actions).toContain('<button type="button" class="dash-action dash-action-shot">Снять чек</button>')
    expect(actions).toContain('<input class="ck-quick-shot-input" type="file" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true"/>')
    expect(actions).toContain('<a class="dash-action dash-action-spend" href="/receipts/new">Трата</a>')
  })
  it('lists the limits by category colour with bars, overspend and categories without a limit', () => {
    const limits = between(view(), 'dash-limits', '</section>')
    expect(limits).toContain('<a class="dash-link" href="/budget/limits">Изменить</a>')
    expect(limits).toContain(`<li class="dash-limit dash-cat-4"><div class="dash-limit-head"><span class="dash-dot" aria-hidden="true"></span><span class="dash-limit-name">Продукты</span><span class="dash-limit-value">${nb('92 300')} / ${nb('120 000 KZT')}</span></div>`)
    expect(limits).toContain('aria-label="Продукты: потрачено 76% лимита"')
    const cafe = between(limits, 'dash-cat-3', '</li>')
    expect(cafe).toContain('dash-bar dash-bar-over')
    expect(cafe).toContain(`Сверх лимита на <span class="dash-value">${nb('4 300 KZT')}</span>`)
    const transport = between(limits, 'dash-cat-6', '</li>')
    expect(transport).toContain(`<span class="dash-limit-value">${nb('21 500,50 KZT')}</span>`)
    expect(transport).not.toContain('dash-bar')
    expect(between(limits, 'dash-cat-2', '</li>')).toContain('Не разобрано')
    expect(between(limits, 'Дом', '</li>')).toContain('aria-valuenow="0"')
    expect(limits.indexOf('Продукты')).toBeLessThan(limits.indexOf('Кафе'))
  })
  it('lists recent spends linked to their receipts with a tinted badge', () => {
    const recent = between(view(), 'dash-recent', '</section>')
    expect(recent).toContain('<h2 id="dash-recent-heading">Последние траты</h2>')
    expect(recent).toContain(`<a class="dash-recent-item" href="/receipts/12"><span class="dash-badge dash-cat-4" aria-hidden="true">П</span><span class="dash-recent-main"><span class="dash-recent-title">Magnum</span><span class="dash-recent-meta">liza · ${nb('12 октября')} · ${nb('23 позиции')}</span></span><span class="dash-recent-amount">${nb('18 940 KZT')}</span></a>`)
    expect(recent).toContain(`andrey · ${nb('11 октября')} · вручную`)
    expect(recent).toContain('<span class="dash-badge dash-cat-0" aria-hidden="true">К</span>')
    expect(recent).toContain('<a class="dash-link" href="/receipts">Все</a>')
  })
  it('says so for a month without spends and keeps the actions', () => {
    const empty = { ...dashboardFixture(), currencies: [], recent: [] }
    const html = view(empty)
    expect(html).toContain(`<p class="dash-empty-title">${nb('В октябре')} трат пока нет</p>`)
    expect(html).toContain('Снимите чек или добавьте трату')
    expect(html).toContain('dash-action-shot')
    expect(html).toContain('<p class="dash-note">Трат пока нет.</p>')
    expect(html).not.toContain('dash-spent')
    expect(view(empty, '2026-12')).toContain(`${nb('В октябре')} трат не было`)
  })
  it('keeps the limits of a month with zero spends', () => {
    const data = dashboardFixture()
    const html = view({ ...data, currencies: [{ ...data.currencies[0], spent: '0.00', categories: [data.currencies[0].categories[4]] }] })
    expect(html).toContain('трат пока нет')
    expect(html).toContain('Дом')
  })
  it('does not say «семьёй» for one person and never sums currencies', () => {
    const data = dashboardFixture()
    const euro = { currency: 'EUR', spent: '120.00', previous_spent: '0.00', limit_total: null,
      categories: [{ category_id: 3, name: 'Продукты', spent: '120.00', limit: null, limit_id: null }] }
    const html = view({ ...data, members: ['andrey'], currencies: [data.currencies[0], euro] })
    expect(html).toContain('<ul class="dash-family" aria-label="Кто тратит">')
    expect(html.match(/<p class="dash-label">Потрачено<\/p>/g)).toHaveLength(2)
    expect(html).toContain(`<p class="dash-total">${nb('120 EUR')}</p>`)
    expect(html).toContain('<p class="dash-compare dash-compare-new">в\u00a0сентябре трат не было</p>')
    expect(html).toContain('Лимиты<span class="dash-currency"> · EUR</span>')
    expect(html).toContain('Лимиты не заданы.')
    expect(html).not.toContain('<table')
  })
})

const category = (id: number, name: string): Category => ({
  id, name, path: [{ id, name }], parent_id: null, depth: 0, children_count: 0, generic_products_count: 0, products_count: 0, products_total: 0,
})
const noop = () => {}
const limits = (extra: Partial<LimitsViewProps> = {}) => renderToStaticMarkup(<LimitsView categories={[category(3, 'Продукты'), category(8, 'Кафе')]}
  limits={[limitFixture()]} currencies={['KZT', 'USD']} currency="KZT" family drafts={{}} statuses={{}}
  onCurrency={noop} onAddCurrency={() => undefined} onDraft={noop} onSave={noop} onDelete={noop} {...extra} />)

describe('«Лимиты» markup (Vitest/SSR, not browser visual acceptance)', () => {
  it('lists top-level categories with an amount field per row', () => {
    const html = limits()
    expect(html).toContain('Лимиты общие: их видят и меняют все члены семьи.')
    expect(html).toContain('<button type="button" class="dash-chip" aria-pressed="true">KZT</button>')
    expect(html).toContain('<button type="button" class="dash-chip" aria-pressed="false">USD</button>')
    expect(html).toContain('<label class="limits-name" for="limit-3">Продукты</label>')
    expect(html).toContain(`<span class="limits-current">${nb('120 000 KZT')}</span>`)
    expect(html).toContain('<input id="limit-3" inputMode="decimal" autoComplete="off" enterKeyHint="done" placeholder="Сумма в месяц" aria-invalid="false" value="120000"/>')
    expect(html).toContain('<span class="limits-current">без лимита</span>')
    expect(html).toContain('<input id="limit-8" inputMode="decimal" autoComplete="off" enterKeyHint="done" placeholder="Сумма в месяц" aria-invalid="false" value=""/>')
    // Nothing to save until the amount changes; only an existing limit can be deleted.
    expect(html.match(/<button type="submit" class="limits-save" disabled="">Сохранить<\/button>/g)).toHaveLength(2)
    expect(html.match(/Удалить<\/button>/g)).toHaveLength(1)
    expect(html).toContain('aria-label="Удалить лимит «Продукты»"')
    expect(html).toContain('<li class="dash-card limits-row dash-cat-4">')
    expect(html).toContain('<a class="dash-link" href="/">На главную</a>')
    expect(html).not.toContain('<table')
  })
  it('shows a changed draft, a refusal at its field and the result', () => {
    const html = limits({
      drafts: { '3:KZT': '90000', '8:KZT': '0' },
      statuses: { '3:KZT': { kind: 'done', text: 'Сохранено.' }, '8:KZT': { kind: 'error', text: 'Лимит должен быть больше нуля.' } },
    })
    expect(html).toContain('aria-invalid="false" aria-describedby="limit-3-message" value="90000"')
    expect(html).toContain('<p class="limits-done" id="limit-3-message" role="status">Сохранено.</p>')
    expect(html).toContain('aria-invalid="true" aria-describedby="limit-8-message" value="0"')
    expect(html).toContain('<p class="receipt-field-error" id="limit-8-message" role="alert">Лимит должен быть больше нуля.</p>')
    expect(html.match(/<button type="submit" class="limits-save">Сохранить<\/button>/g)).toHaveLength(2)
  })
  it('locks a row while it is saved', () => {
    const html = limits({ drafts: { '3:KZT': '1' }, statuses: { '3:KZT': { kind: 'busy' } } })
    expect(html).toContain('<form class="limits-form" noValidate="" aria-busy="true">')
    expect(html).toContain('<button type="submit" class="limits-save" disabled="">Сохраняем…</button>')
    expect(html).toContain('class="receipt-secondary limits-delete" disabled="" aria-label="Удалить лимит «Продукты»"')
  })
  it('speaks to one person without a family and offers the catalog without categories', () => {
    const html = limits({ family: false, categories: [] })
    expect(html).toContain('Лимит — сколько вы готовы потратить на категорию за месяц.')
    expect(html).toContain('Категорий пока нет: их заводят в каталоге.')
    expect(html).toContain('<a class="action-link" href="/catalog">В каталог</a>')
  })
})
