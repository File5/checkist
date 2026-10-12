import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { dashboardFixture, limitFixture } from '../../api/budget-test-support'
import type { Dashboard } from '../../api/budget'
import type { Category } from '../../api/types'
import { DashboardView } from './DashboardPage'
import { LimitsView } from './LimitsPage'
import type { LimitsViewProps } from './LimitsPage'

const nb = (text: string) => text.replaceAll(' ', '\u00a0')
const view = (data: Dashboard = dashboardFixture(), today = '2026-10') => renderToStaticMarkup(<DashboardView data={data} today={today} date="2026-10-20" />)
const between = (html: string, start: string, end: string) => html.slice(html.indexOf(start), html.indexOf(end, html.indexOf(start)))
/** The pictures (components/Icon) are left out where an expectation reads the words. */
const noIcons = (html: string) => html.replace(/<svg\b.*?<\/svg>/g, '')

describe('«Главная» markup (Vitest/SSR, not browser visual acceptance)', () => {
  it('fills the header row of the shell: «‹», «›» while a later month is past, and the family (in place without a shell)', () => {
    const html = noIcons(view())
    expect(html).toContain('<a class="ck-round dash-month-step" aria-label="Предыдущий месяц" href="/?month=2026-09"></a>')
    // Nothing after the current month of the device: no step at all.
    expect(html).not.toContain('Следующий месяц')
    expect(html).toContain('<ul class="dash-family" aria-label="Семья">')
    expect(html).toContain('<li class="dash-avatar dash-cat-1" title="andrey"><span aria-hidden="true">A</span><span class="dash-visually-hidden">andrey</span></li>')
    expect(html).toContain('<li class="dash-avatar dash-cat-2" title="liza"><span aria-hidden="true">L</span><span class="dash-visually-hidden">liza</span></li>')
    expect(noIcons(view(dashboardFixture(), '2026-11'))).toContain('<a class="ck-round dash-month-step" aria-label="Следующий месяц" href="/?month=2026-11"></a>')
    // The month is the heading of the page (usePageTitle): no second heading in the screen.
    expect(html).not.toMatch(/<h[12][^>]*>Октябрь/)
    const source = readFileSync(new URL('./DashboardPage.tsx', import.meta.url), 'utf8')
    expect(source).toContain("usePageTitle(monthTitle(month).replace('\\u00a0', ' '))")
    expect(source).toContain('<HeaderSlot side="start">')
    expect(source).toContain('<HeaderSlot side="end">')
  })
  it('shows what the family spent, the comparison, the overall limit and the days in the hero card', () => {
    const spent = noIcons(between(view(), 'dash-hero', '</section>'))
    expect(spent).toContain('<div class="ck-panel-head"><p class="dash-label">Потрачено семьёй</p><a class="dash-card-link" href="/stats/trends">Динамика</a></div>')
    expect(spent).toContain(`<p class="dash-total ck-hero-figure">${nb('287 450 ₸')}</p>`)
    expect(spent).toContain(`<p class="dash-compare dash-compare-less">на\u00a012\u00a0% меньше, чем ${nb('в сентябре')}</p>`)
    expect(spent).toContain('role="progressbar" aria-label="Потрачено 71% общего лимита" aria-valuemin="0" aria-valuemax="100" aria-valuenow="71"')
    expect(spent).toContain('<span class="dash-bar-fill" style="width:71%"></span>')
    expect(spent).toContain(`<span>Осталось <span class="dash-value dash-strong">${nb('112 550 ₸')}</span> из <span class="dash-value">${nb('400 000 ₸')}</span></span>`)
    expect(spent).toContain(`<span class="dash-days">${nb('ещё 19 дней')}</span>`)
    // Everything spent is in a limited category: nothing to explain under the bar.
    expect(spent).not.toContain('Категории с лимитом')
  })
  it('says the overall overspend and drops the days left of a past month', () => {
    const data = dashboardFixture()
    const over = { ...data, currencies: [{ ...data.currencies[0], spent: '410000.00', limited_spent: '410000.00' }] }
    const html = view(over, '2026-11')
    expect(html).toContain('dash-bar dash-bar-over')
    expect(html).toContain(`<span class="dash-over">Сверх лимита на <span class="dash-value">${nb('10 000 ₸')}</span></span>`)
    expect(html).not.toContain('dash-days')
  })
  it('has the two big actions of the artifact, in the page and not pinned: the camera of «Снять чек» and the form of «Трата»', () => {
    const html = view()
    const actions = between(html, 'class="dash-actions"', '</div>')
    expect(actions).toMatch(/<button type="button" class="dash-action dash-action-shot"><svg class="ck-icon"[^>]*>.*?<\/svg>Снять чек<\/button>/)
    expect(actions).toContain('<input class="ck-quick-shot-input" type="file" accept="image/*" capture="environment" tabindex="-1" aria-hidden="true"/>')
    expect(actions).toMatch(/<a class="dash-action dash-action-spend" href="\/receipts\/new"><svg class="ck-icon"[^>]*>.*?<\/svg>Трата<\/a>/)
    // «Из галереи» lives in the «＋» sheet of the bottom bar.
    expect(actions).not.toContain('Из галереи')
    expect(html).not.toContain('ck-action-bar')
  })
  it('compares the overall limit with the spending of limited categories only, not the whole month', () => {
    const data = dashboardFixture()
    // October 2026 on the server: 472 273 spent in all, 245 015 of it in «Жильё», the only limit is 250 000.
    const real = { ...data, currencies: [{ ...data.currencies[0], spent: '472272.10', limit_total: '250000.00', limited_spent: '245014.02' }] }
    const hero = between(view(real, '2026-10'), 'dash-hero', '</section>')
    expect(hero).not.toContain('Сверх лимита на')
    expect(hero).toContain(`Осталось <span class="dash-value dash-strong">${nb('4 986 ₸')}</span>`)
    expect(hero).toContain(`Категории с лимитом: <span class="dash-value">${nb('245 015 ₸')}</span>`)
  })
  it('lists the limited categories with bars and «spent / limit» on one line, the others below without bars', () => {
    const limits = between(view(), 'dash-limits', '</section>')
    expect(limits).toContain('<a class="dash-card-link" href="/budget/limits">Изменить</a>')
    expect(limits).toContain(`<li class="dash-limit dash-cat-3"><a class="dash-limit-head dash-limit-link" href="/spends/category/3?month=2026-10"><span class="dash-dot" aria-hidden="true"></span><span class="dash-limit-name">Продукты</span><span class="dash-limit-value ck-figures"><span class="dash-limit-spent">${nb('92 300')}</span><span class="dash-limit-of"> / ${nb('120 000 ₸')}</span></span></a>`)
    expect(limits).toContain('aria-label="Продукты: потрачено 76% лимита"')
    const cafe = between(limits, 'dash-cat-2', '</li>')
    expect(cafe).toContain('dash-bar dash-bar-over')
    expect(cafe).toContain(`<span class="dash-limit-spent dash-limit-spent-over">${nb('54 300')}</span>`)
    expect(cafe).toContain(`Сверх лимита на <span class="dash-value">${nb('4 300 ₸')}</span>`)
    expect(between(limits, 'Дом', '</li>')).toContain('aria-valuenow="0"')
    expect(limits.indexOf('Продукты')).toBeLessThan(limits.indexOf('Кафе'))
    // Without a limit: below the limited ones, under «Без лимита», one line each, no bar.
    const plain = between(limits, 'dash-plain-block', '</ul>')
    expect(plain).toContain('<h3 class="dash-plain-title">Без лимита</h3>')
    expect(plain).toContain(`<li class="dash-plain dash-cat-5"><a class="dash-plain-head dash-limit-link" href="/spends/category/11?month=2026-10"><span class="dash-dot" aria-hidden="true"></span><span class="dash-plain-name">Транспорт</span><span class="dash-plain-value ck-figures">${nb('21 501 ₸')}</span></a></li>`)
    expect(plain).toContain('Не разобрано')
    expect(plain).not.toContain('dash-bar')
    expect(limits.indexOf('Дом')).toBeLessThan(limits.indexOf('Транспорт'))
  })
  it('nests the limited sub-categories under their top-level row, a thinner bar each', () => {
    const data = dashboardFixture()
    const home = { category_id: 10, name: 'Жильё', spent: '250000.00', limit: null, limit_id: null, children: [
      { category_id: 17, name: 'Аренда', spent: '200000.00', limit: '200000.00', limit_id: 31, children: [] },
      { category_id: 21, name: 'Коммунальные услуги', spent: '50000.00', limit: null, limit_id: null, children: [
        { category_id: 22, name: 'Электричество', spent: '18000.00', limit: '15000.00', limit_id: 32, children: [] },
      ] },
    ] }
    const html = view({ ...data, currencies: [{ ...data.currencies[0], categories: [home, ...data.currencies[0].categories] }] })
    const row = between(html, 'dash-cat-4', 'dash-cat-3')
    // The top-level row without its own limit but with a limited sub-category: what was spent, no bar.
    expect(row).toContain(`<span class="dash-limit-name">Жильё</span><span class="dash-limit-value ck-figures">${nb('250 000 ₸')}</span></a><button type="button" class="dash-sub-toggle" aria-expanded="true" aria-controls="dash-sub-KZT-10">`)
    // Open by itself: «Электричество» two levels down is over its limit; the list is not hidden.
    expect(row).toContain('<ul class="dash-sublimit-list" id="dash-sub-KZT-10" aria-label="Жильё: подкатегории"><li')
    expect(row).not.toContain('aria-label="Жильё: потрачено')
    expect(row).toContain(`<li class="dash-sublimit"><a class="dash-limit-head dash-limit-link" href="/spends/category/17?month=2026-10"><span class="dash-sublimit-name">Аренда</span><span class="dash-limit-value dash-sublimit-value ck-figures"><span class="dash-limit-spent">${nb('200 000')}</span><span class="dash-limit-of"> / ${nb('200 000 ₸')}</span></span></a><div class="dash-bar dash-bar-small" role="progressbar" aria-label="Аренда: потрачено 100% лимита"`)
    // An ancestor of a limited one: its spends, no bar, its own nested list.
    expect(row).toContain(`<span class="dash-sublimit-name">Коммунальные услуги</span><span class="dash-limit-value dash-sublimit-value ck-figures">${nb('50 000 ₸')}</span></a><button type="button" class="dash-sub-toggle" aria-expanded="true" aria-controls="dash-sub-KZT-21">`)
    expect(row).toContain('<div class="dash-bar dash-bar-small dash-bar-over" role="progressbar" aria-label="Электричество: потрачено 100% лимита"')
    expect(row).toContain(`<p class="dash-over dash-sublimit-over">Сверх лимита на <span class="dash-value">${nb('3 000 ₸')}</span></p>`)
    // An older server sends no `children`: the row is as before.
    expect(between(view(), 'dash-cat-3', '</li>')).not.toContain('dash-sublimit')
  })
  it('folds the sub-categories by default: top-level rows only, a button with the count beside the row link', () => {
    const data = dashboardFixture()
    const rent = { category_id: 17, name: 'Аренда', spent: '220000.00', limit: '220000.00', limit_id: 31, children: [] }
    const plain = (category_id: number, name: string) => ({ category_id, name, spent: '1000.00', limit: null, limit_id: null, children: [] })
    const home = { category_id: 10, name: 'Жильё', spent: '251692.00', limit: '260000.00', limit_id: 30, children: [
      rent, plain(18, 'Коммунальные услуги'), plain(19, 'Электричество'), plain(20, 'Интернет'), plain(23, 'Вода'), plain(24, 'Вывоз мусора'),
    ] }
    const render = (expanded?: Record<string, boolean>, row = home) => noIcons(between(
      renderToStaticMarkup(<DashboardView data={{ ...data, currencies: [{ ...data.currencies[0], categories: [row, ...data.currencies[0].categories] }] }} today="2026-10" expanded={expanded} />),
      'dash-cat-4', 'dash-cat-3'))
    const row = render()
    // The row link still opens «Траты категории»; the button is a sibling after it, never inside it.
    expect(row).toContain('<a class="dash-limit-head dash-limit-link" href="/spends/category/10?month=2026-10">')
    expect(row).toContain(`</div><button type="button" class="dash-sub-toggle" aria-expanded="false" aria-controls="dash-sub-KZT-10"><span class="dash-sub-text"><span class="dash-visually-hidden">Жильё: </span><span class="dash-sub-count">${nb('6 подкатегорий')}</span><span class="dash-sub-hint ck-figures">Аренда ${nb('220 000')} / ${nb('220 000')}</span></span></button>`)
    expect(row).toContain('<ul class="dash-sublimit-list" id="dash-sub-KZT-10" aria-label="Жильё: подкатегории" hidden="">')
    expect(row.match(/<a /g)).toHaveLength(7)
    // Opened by the person (or from this browser): the same list, shown, no hint.
    const open = render({ 10: true })
    expect(open).toContain('aria-expanded="true" aria-controls="dash-sub-KZT-10"')
    expect(open).toContain('<ul class="dash-sublimit-list" id="dash-sub-KZT-10" aria-label="Жильё: подкатегории"><li')
    expect(open).not.toContain('dash-sub-hint')
    // Two limits do not fit one line: only the count.
    const two = render(undefined, { ...home, children: [rent, { ...plain(23, 'Вода'), limit: '5000.00', limit_id: 33 }] })
    expect(two).toContain(`<span class="dash-sub-count">${nb('2 подкатегории')}</span></span></button>`)
    expect(two).not.toContain('dash-sub-hint')
    // A row without sub-categories has no button.
    expect(between(view(), 'dash-cat-3', '</li>')).not.toContain('dash-sub-toggle')
  })
  it('shows the names of the family and of who added a spend, the usernames without them', () => {
    const data = { ...dashboardFixture(), people: [{ username: 'andrey', display_name: 'Андрей' }, { username: 'liza', display_name: 'Лиза' }] }
    data.recent = data.recent.map((item) => ({ ...item, owner_name: item.owner === 'liza' ? 'Лиза' : 'Андрей' }))
    const html = view(data)
    expect(html).toContain('<li class="dash-avatar dash-cat-1" title="Андрей"><span aria-hidden="true">А</span><span class="dash-visually-hidden">Андрей</span></li>')
    expect(html).toContain('<li class="dash-avatar dash-cat-2" title="Лиза"><span aria-hidden="true">Л</span><span class="dash-visually-hidden">Лиза</span></li>')
    expect(html).toContain(`<span class="ck-row-meta">Лиза · ${nb('12 октября')} · ${nb('23 позиции')}</span>`)
    expect(html).not.toContain('liza')
  })
  it('lists recent spends as rows of the list brick, linked to their receipts, with a tinted badge', () => {
    const recent = between(view(), 'dash-recent"', '</section>')
    expect(recent).toContain('<div class="ck-panel-head"><h2 id="dash-recent-heading">Последние траты</h2><a class="dash-card-link" href="/receipts">Все</a></div>')
    expect(recent).toContain(`<li><a class="ck-row dash-recent-item" href="/receipts/12"><span class="ck-row-badge dash-badge dash-cat-3" aria-hidden="true">П</span><span class="ck-row-main"><span class="ck-row-title dash-recent-title">Magnum</span><span class="ck-row-meta">liza · ${nb('12 октября')} · ${nb('23 позиции')}</span></span><span class="ck-row-amount ck-figures">${nb('18 940 ₸')}</span></a></li>`)
    expect(recent).toContain(`andrey · ${nb('11 октября')} · вручную`)
    expect(recent).toContain('<span class="ck-row-badge dash-badge dash-cat-0" aria-hidden="true">К</span>')
    // «сегодня» and «вчера» by the date of the device.
    expect(renderToStaticMarkup(<DashboardView data={dashboardFixture()} today="2026-10" date="2026-10-12" />)).toContain(`liza · сегодня · ${nb('23 позиции')}`)
  })
  it('says so for a month without spends and keeps the actions', () => {
    const empty = { ...dashboardFixture(), currencies: [], recent: [] }
    const html = view(empty)
    expect(html).toContain(`<p class="dash-empty-title">${nb('В октябре')} трат пока нет</p>`)
    expect(html).toContain('Снимите чек или добавьте трату')
    expect(html).toContain('dash-action-shot')
    expect(html).toContain('<p class="dash-note">Трат пока нет.</p>')
    expect(html).not.toContain('dash-hero')
    expect(view(empty, '2026-12')).toContain(`${nb('В октябре')} трат не было`)
    // The empty month offers its action right there.
    expect(between(html, 'dash-empty', '</section>')).toContain('<a class="dash-empty-action" href="/receipts/new">Добавить трату</a>')
    expect(html).not.toContain('ck-hero-figure')
  })
  it('puts the money and the actions in one column, the limits in the other, and slides another month in', () => {
    const html = view()
    const main = html.indexOf('<div class="dash-column dash-column-main">')
    const side = html.indexOf('<div class="dash-column dash-column-side">')
    expect(main).toBeGreaterThan(0)
    expect(html.indexOf('dash-hero')).toBeGreaterThan(main)
    expect(html.indexOf('dash-actions')).toBeGreaterThan(html.indexOf('dash-hero'))
    expect(html.indexOf('dash-recent')).toBeLessThan(side)
    expect(html.indexOf('dash-limits')).toBeGreaterThan(side)
    expect(html).toContain('<div class="dash">')
    const forward = renderToStaticMarkup(<DashboardView data={dashboardFixture()} today="2026-10" slide="forward" />)
    expect(forward).toContain('<div class="dash dash-slide-forward">')
    const back = renderToStaticMarkup(<DashboardView data={dashboardFixture()} today="2026-10" slide="back" />)
    expect(back).toContain('<div class="dash dash-slide-back">')
  })
  it('keeps the limits of a month with zero spends', () => {
    const data = dashboardFixture()
    const html = view({ ...data, currencies: [{ ...data.currencies[0], spent: '0.00', categories: [data.currencies[0].categories[4]] }] })
    expect(html).toContain('трат пока нет')
    expect(html).toContain('Дом')
  })
  it('does not say «семьёй» for one person, never sums currencies and shows another one as a compact row', () => {
    const data = dashboardFixture()
    const euro = { currency: 'EUR', spent: '120.00', previous_spent: '0.00', limit_total: null,
      categories: [{ category_id: 3, name: 'Продукты', spent: '120.00', limit: null, limit_id: null }] }
    const html = view({ ...data, members: ['andrey'], currencies: [data.currencies[0], euro] })
    expect(html).toContain('<ul class="dash-family" aria-label="Кто тратит">')
    // One hero figure on the screen: the second currency is a row of «Другие валюты».
    expect(html.match(/ck-hero-figure/g)).toHaveLength(1)
    expect(html).toContain('<p class="dash-label">Потрачено</p>')
    const others = between(html, 'dash-others', '</section>')
    expect(others).toContain('<h2 id="dash-others-heading">Другие валюты</h2>')
    expect(others).toContain(`<li class="ck-row dash-other" aria-label="Потрачено, EUR"><span class="ck-row-badge dash-currency-badge" aria-hidden="true">€</span><span class="ck-row-main"><span class="ck-row-title">Евро</span><span class="ck-row-meta">в\u00a0сентябре трат не было</span></span><span class="ck-row-amount ck-figures dash-other-amount">${nb('120 €')}</span></li>`)
    // Another currency without limits gets no limits card of its own: its spends are already in «Другие валюты».
    expect(html).not.toContain('Лимиты<span class="dash-currency"> · €</span>')
    const limited = view({ ...data, currencies: [data.currencies[0], { ...euro, limit_total: '200.00' }] })
    expect(limited).toContain('Лимиты<span class="dash-currency"> · €</span>')
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

describe('«Лимиты» as a tree of categories', () => {
  const sub = (id: number, name: string, parent: Category): Category => ({
    ...category(id, name), path: [...parent.path, { id, name }], parent_id: parent.id, depth: parent.depth + 1,
  })
  const home = category(10, 'Жильё')
  const rent = sub(17, 'Аренда', home)
  const utilities = sub(21, 'Коммунальные услуги', home)
  const power = sub(22, 'Электричество', utilities)
  const tree = [home, rent, utilities, power, category(8, 'Кафе')]
  const view = (extra: Partial<LimitsViewProps> = {}) => limits({ categories: tree, limits: [], ...extra })

  it('hides sub-categories behind a toggle until one of them has a limit', () => {
    const html = view()
    expect(noIcons(html)).toContain('<button type="button" class="limits-toggle" aria-expanded="false" aria-label="Показать подкатегории «Жильё»">Показать 3\u00a0подкатегории</button>')
    expect(html).not.toContain('limit-17')
    expect(html).toContain('<label class="limits-name" for="limit-10">Жильё</label>')
    // «Кафе» has no sub-categories: no toggle.
    expect(html.match(/class="limits-toggle"/g)).toHaveLength(1)
  })
  it('shows every level with an amount field, indented, the colour of its top-level category', () => {
    const html = view({ limits: [limitFixture({ id: 30, category_id: 22, category_name: 'Электричество', amount: '15000.00' })] })
    expect(noIcons(html)).toContain('aria-expanded="true" aria-label="Скрыть подкатегории «Жильё»">Скрыть 3\u00a0подкатегории</button>')
    expect(html).toContain('<li class="limits-row limits-row-sub dash-cat-4" style="--limits-depth:1">')
    expect(html).toContain('<li class="limits-row limits-row-sub dash-cat-4" style="--limits-depth:2">')
    // The path is read out before the name: «Жильё › Коммунальные услуги › Электричество».
    expect(html).toContain('<label class="limits-name" for="limit-22"><span class="dash-visually-hidden">Жильё › Коммунальные услуги › </span>Электричество</label>')
    expect(html).toContain('<input id="limit-22" inputMode="decimal" autoComplete="off" enterKeyHint="done" placeholder="Сумма в месяц" aria-invalid="false" value="15000"/>')
    expect(html).toContain('<input id="limit-17" inputMode="decimal"')
    expect(html).toContain('aria-label="Удалить лимит «Электричество»"')
  })
  it('follows the person who closed or opened a top-level category', () => {
    const limited = [limitFixture({ id: 30, category_id: 22 })]
    expect(view({ limits: limited, toggled: { 10: false } })).not.toContain('limit-22')
    expect(view({ toggled: { 10: true } })).toContain('limit-22')
  })
})

describe('«Лимиты» markup (Vitest/SSR, not browser visual acceptance)', () => {
  it('lists top-level categories with an amount field per row', () => {
    const html = limits()
    expect(html).toContain('Лимиты общие: их видят и меняют все члены семьи.')
    expect(html).toContain('<button type="button" class="dash-chip" aria-pressed="true">KZT</button>')
    expect(html).toContain('<button type="button" class="dash-chip" aria-pressed="false">USD</button>')
    expect(html).toContain('<label class="limits-name" for="limit-3">Продукты</label>')
    expect(html).toContain(`<span class="limits-current ck-figures">${nb('120 000 ₸')}</span>`)
    // The field names its currency by the sign; the chips choose it by the code.
    expect(html).toContain('<span class="limits-input-currency" aria-hidden="true">₸</span>')
    expect(html).toContain('<input id="limit-3" inputMode="decimal" autoComplete="off" enterKeyHint="done" placeholder="Сумма в месяц" aria-invalid="false" value="120000"/>')
    expect(html).toContain('<span class="limits-current ck-figures">без лимита</span>')
    expect(html).toContain('<input id="limit-8" inputMode="decimal" autoComplete="off" enterKeyHint="done" placeholder="Сумма в месяц" aria-invalid="false" value=""/>')
    // One bar saves every changed row: nothing to save until an amount changes; only an existing limit can be deleted.
    expect(html).toContain('<div class="limits-savebar ck-action-bar"><button type="button" class="limits-save" disabled="">Сохранить</button></div>')
    expect(html.match(/limits-save/g)).toHaveLength(2)
    expect(html.match(/Удалить<\/button>/g)).toHaveLength(1)
    expect(html).toContain('aria-label="Удалить лимит «Продукты»"')
    expect(html).toContain('<li class="limits-row dash-cat-3">')
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
    // Both rows changed: the refused one goes too, so its error is said again at its field.
    expect(html).toContain('<button type="button" class="limits-save">Сохранить · 2\u00a0изменения</button>')
    expect(html.match(/limits-row-changed/g)).toHaveLength(2)
  })
  it('locks a row while it is saved', () => {
    const html = limits({ drafts: { '3:KZT': '1' }, statuses: { '3:KZT': { kind: 'busy' } } })
    expect(html).toContain('<form class="limits-form" noValidate="" aria-busy="true">')
    expect(html).toContain('<button type="button" class="limits-save" disabled="">Сохраняем…</button>')
    expect(html).toContain('class="ck-button-danger limits-delete" disabled="" aria-label="Удалить лимит «Продукты»"')
  })
  it('speaks to one person without a family and offers the catalog without categories', () => {
    const html = limits({ family: false, categories: [] })
    expect(html).toContain('Лимит — сколько вы готовы потратить на категорию за месяц.')
    expect(html).toContain('Категорий пока нет: их заводят в каталоге.')
    expect(html).toContain('<a class="action-link" href="/catalog">В каталог</a>')
  })
})
