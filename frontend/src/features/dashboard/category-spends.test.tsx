import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { isCategorySpends } from '../../api/budget-schema'
import type { CategorySpendItem, CategorySpends } from '../../api/budget'
import { backTarget } from '../../menu/back-target'
import { buildRoute, parseRoute } from '../../navigation/routes'
import { CategorySpendsView } from './CategorySpendsPage'
import { setListIcons } from '../../lib/list-icons'
import { categorySpendsHref, partShare, showsLines, spendNote, spendSource, spendTitle, wholeReceipt } from './category-spends-state'

const nb = (text: string) => text.replaceAll(' ', ' ')
const item = (fields: Partial<CategorySpendItem> = {}): CategorySpendItem => ({
  receipt_id: 812, source: 'manual', purchased_on: '2026-10-09', store: { id: 44, name: 'Steam' },
  note: 'Steam purchase · Выписка Kaspi Gold', owner: 'andrey', owner_name: 'Андрей',
  receipt_total: '8000.00', category_amount: '8000.00',
  lines: [{ id: 9001, name: 'Steam', amount: '8000.00', category_id: 51, category_name: 'Игры' }], ...fields,
})
const fixture = (): CategorySpends => ({
  month: '2026-10', previous_month: '2026-09',
  category: { id: 51, name: 'Игры', path: [{ id: 5, name: 'Развлечения' }, { id: 51, name: 'Игры' }] },
  children: [{ id: 511, name: 'Подписки' }],
  currencies: [{
    currency: 'KZT', total: '24500.40', receipts_count: 2,
    parts: [
      { id: 511, name: 'Подписки', direct: false, children_count: 0, amount: '16000.00', lines_count: 1 },
      { id: 51, name: 'Игры', direct: true, children_count: 0, amount: '8500.40', lines_count: 2 },
    ],
    items: [
      item(),
      item({ receipt_id: 71, source: 'photo', store: { id: 2, name: 'MAGNUM' }, note: '', receipt_total: '12500.00', category_amount: '500.40',
        lines: [{ id: 1, name: 'Карты UNO', amount: '400.00', category_id: 51, category_name: 'Игры' },
          { id: 2, name: 'Пазл', amount: '100.40', category_id: 51, category_name: 'Игры' }] }),
    ],
  }],
})

describe('«Траты категории» rules', () => {
  it('says where a spend came from and what it was', () => {
    expect(spendSource(item())).toBe('Выписка Kaspi Gold')
    expect(spendSource(item({ note: 'Яндекс Go · Выписка ForteBank' }))).toBe('Выписка ForteBank')
    expect(spendSource(item({ source: 'photo', note: '' }))).toBe('по чеку')
    expect(spendSource(item({ note: 'кофе с другом' }))).toBe('вручную')
    expect(spendTitle(item())).toBe('Steam')
    expect(spendTitle(item({ store: null }))).toBe('Steam purchase')
    expect(spendTitle(item({ store: null, note: ' · Выписка Kaspi Gold', lines: [] }))).toBe('Без места')
    expect(spendNote(item())).toBe('Steam purchase')
    expect(spendNote(item({ store: null }))).toBeUndefined()
  })
  it('shows the whole receipt only when it has other categories too', () => {
    expect(wholeReceipt(item(), 'KZT')).toBeUndefined()
    expect(wholeReceipt(item({ category_amount: '500.40', receipt_total: '12500.00' }), 'KZT')).toBe(`из ${nb('12 500 ₸')} по чеку`)
  })
  it('measures a part against the total and lists lines that say more than the row', () => {
    expect(partShare({ amount: '16000.00' }, '24500.40')).toBe(65)
    expect(partShare({ amount: '-5.00' }, '24500.40')).toBe(0)
    expect(partShare({ amount: '5.00' }, '0.00')).toBe(0)
    expect(showsLines(item())).toBe(false)
    expect(showsLines(item({ source: 'photo' }))).toBe(true)
    expect(showsLines(fixture().currencies[0].items[1])).toBe(true)
  })
  it('reads the answer of the server and refuses a wrong one', () => {
    expect(isCategorySpends(fixture())).toBe(true)
    expect(isCategorySpends({ ...fixture(), month: '2026-13' })).toBe(false)
    const broken = fixture()
    broken.currencies[0].items[0] = { ...broken.currencies[0].items[0], category_amount: 12 as unknown as string }
    expect(isCategorySpends(broken)).toBe(false)
  })
})

describe('the route of «Траты категории»', () => {
  it('opens a category of a month and drops a wrong month', () => {
    expect(parseRoute('/spends/category/51?month=2026-10')).toEqual({ kind: 'category-spends', categoryId: 51, month: '2026-10' })
    expect(parseRoute('/spends/category/51/')).toEqual({ kind: 'category-spends', categoryId: 51 })
    expect(parseRoute('/spends/category/51?month=2026-13')).toEqual({ kind: 'category-spends', categoryId: 51 })
    expect(parseRoute('/spends/category/0')).toEqual({ kind: 'not-found', path: '/spends/category/0' })
    expect(parseRoute('/spends/category/x')).toEqual({ kind: 'not-found', path: '/spends/category/x' })
    expect(buildRoute({ kind: 'category-spends', categoryId: 51, month: '2026-10' })).toBe('/spends/category/51?month=2026-10')
    expect(buildRoute({ kind: 'category-spends', categoryId: 51 })).toBe(categorySpendsHref(51))
  })
  it('leads back to «Главная» of the same month, or where the person came from', () => {
    expect(backTarget({ route: { kind: 'category-spends', categoryId: 51, month: '2026-09' }, returnTo: undefined }))
      .toEqual({ to: '/?month=2026-09', label: 'Назад на главную' })
    expect(backTarget({ route: { kind: 'category-spends', categoryId: 51 }, returnTo: undefined })?.to).toBe('/')
    expect(backTarget({ route: { kind: 'category-spends', categoryId: 511 }, returnTo: '/spends/category/51?month=2026-10' })?.to)
      .toBe('/spends/category/51?month=2026-10')
  })
})

describe('«Траты категории» markup (Vitest/SSR, not browser visual acceptance)', () => {
  const view = (data = fixture(), today = '2026-10') => renderToStaticMarkup(<CategorySpendsView data={data} today={today} />)
  const noIcons = (html: string) => html.replace(/<svg\b.*?<\/svg>/g, '')
  it('heads with the path, the month and its steps in the first card, and the hero total', () => {
    const html = noIcons(view())
    expect(html).toContain('<nav class="cat-crumbs" aria-label="Категории выше"><a href="/spends/category/5?month=2026-10">Развлечения</a></nav>')
    // The name is the heading of the page (the header row of the shell, usePageTitle): no second heading in the screen.
    expect(html).not.toMatch(/<h[12][^>]*>Игры/)
    expect(readFileSync(new URL('./CategorySpendsPage.tsx', import.meta.url), 'utf8')).toContain('usePageTitle(category.name)')
    expect(html).toContain('<nav class="cat-month" aria-label="Месяц"><span class="cat-spends-month">Октябрь\u00a02026</span>')
    expect(html).toContain('<a class="ck-round dash-month-step" aria-label="Предыдущий месяц" href="/spends/category/51?month=2026-09"></a>')
    expect(html).not.toContain('Следующий месяц')
    expect(html).toContain('<span class="ck-round dash-month-step dash-month-step-off" aria-hidden="true"></span>')
    expect(noIcons(view(fixture(), '2026-11'))).toContain('aria-label="Следующий месяц" href="/spends/category/51?month=2026-11"></a>')
    expect(html).toContain('<p class="dash-label">Потрачено</p>')
    expect(html).toContain(`<p class="dash-total ck-hero-figure">${nb('24 501 ₸')}</p>`)
    expect(html.match(/ck-hero-figure/g)).toHaveLength(1)
  })
  it('breaks the total down by sub-category, each a link one level deeper', () => {
    const html = view()
    expect(html).toContain('<a class="cat-part cat-part-link" href="/spends/category/511?month=2026-10">')
    expect(html).toContain('<span class="cat-part-name">Игры без подкатегории</span>')
    expect(html).toContain('style="width:65%"')
  })
  it('lists each spend with its place, source, who added it and the part of this category', () => {
    const html = view()
    // By hand or by a receipt, as in «Траты»: a picture on the tint of the top-level category, the meta line says it.
    expect(html).toMatch(/<a class="cat-spend-row" href="\/receipts\/812"><span class="cat-spend-badge dash-cat-5" data-icon="tag" aria-hidden="true"><svg[^>]*>.*?<\/svg><\/span><span class="cat-spend-main"><span class="cat-spend-title">Steam<\/span><span class="cat-spend-note">Steam purchase<\/span>/)
    // The picture of the category of the page (inherited by the server), or how each spend came in by the choice of the device.
    const icons = (markup: string) => [...markup.matchAll(/class="cat-spend-badge[^"]*" data-icon="([a-z]+)"/g)].map((match) => match[1])
    const games = { ...fixture(), category: { ...fixture().category, icon: 'ticket' } }
    expect(new Set(icons(view(games)))).toEqual(new Set(['ticket']))
    setListIcons('source')
    try {
      expect(icons(view(games))).toContain('card')
    } finally {
      setListIcons('category')
    }
    expect(html).toContain(`<time dateTime="2026-10-09">${nb('9 октября')}</time> · Выписка Kaspi Gold · Андрей`)
    expect(html).toContain(`<span class="ck-figures">${nb('501 ₸')}</span><span class="cat-spend-whole">из ${nb('12 500 ₸')} по чеку</span>`)
    expect(html).toContain('<details class="cat-spend-lines"><summary>Позиции: 2</summary>')
    expect(html).toContain(`<li class="ck-leader"><span class="cat-spend-line-name">Карты UNO<span class="cat-spend-line-category"> · Игры</span></span><span class="ck-figures">${nb('400 ₸')}</span></li>`)
    // A spend of one line from a statement needs no list of lines.
    expect(html.match(/cat-spend-lines/g)).toHaveLength(1)
  })
  it('offers «Главная» for an empty month', () => {
    const html = view({ ...fixture(), currencies: [] }, '2026-11')
    expect(html).toContain(`${nb('В октябре')} трат в этой категории не было`)
    expect(html).toContain('<a class="action-link" href="/?month=2026-10">На главную</a>')
  })
})
