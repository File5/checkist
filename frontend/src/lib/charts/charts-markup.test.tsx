import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LineChart, PieChart } from './index'
import type { ChartLinkProps, LineChartSeries, PieChartItem } from './index'

const count = (html: string, pattern: RegExp) => (html.match(pattern) ?? []).length
const rows = (html: string) => [...html.matchAll(/<tr[^>]*>(.*?)<\/tr>/g)].map((match) => match[1])

describe('PieChart markup (Node, not pointer or focus behaviour)', () => {
  const items: PieChartItem[] = [
    { key: 'c2', label: 'Молочные продукты', value: 412.3, valueText: '412,30 EUR', shareText: '20,70 %', href: '/stats?category=2' },
    { key: 'c9', label: 'Не разобрано', value: 388.1, valueText: '388,10 EUR', shareText: '19,48 %', href: '/stats?category=9', note: 'Категорию назначают в админке.' },
    { key: 'other', label: 'Прочее (3)', value: 74.05, valueText: '74,05 EUR', shareText: '3,72 %', tone: 'other' },
    { key: 'unmatched', label: 'Строки без товара', value: 11.2, valueText: '11,20 EUR', shareText: '1,26 %', tone: 'muted' },
    { key: 'deposit', label: 'Залог и тара', value: -2.5, valueText: '-2,50 EUR', shareText: '—', tone: 'muted' },
  ]
  const html = renderToStaticMarkup(<PieChart title="Траты по категориям, EUR" items={items} centerLabel="Всего" centerValue="1 986,40 EUR" />)

  it('draws only positive items and hides the drawing from assistive technology', () => {
    expect(html).toContain('<svg class="ck-pie-svg" viewBox="0 0 320 240" aria-hidden="true"')
    expect(count(html, /<g class="ck-pie-slice /g)).toBe(4)
    expect(html).toContain('ck-pie-slice ck-chart-c1')
    expect(html).toContain('ck-pie-slice ck-chart-c2')
    expect(html).toContain('ck-pie-slice ck-chart-other')
    expect(html).toContain('ck-pie-slice ck-chart-muted')
    expect(html).not.toContain('data-state=')
  })
  it('makes sectors links that stay out of the tab order, with the same address in the legend', () => {
    expect(count(html, /<a href="\/stats\?category=2"/g)).toBe(2)
    expect(html).toContain('<a href="/stats?category=2" class="ck-pie-link" tabindex="-1"><path')
    expect(html).toContain('<a href="/stats?category=2">Молочные продукты</a>')
    expect(count(html, /tabindex="-1"/g)).toBe(2)
    expect(count(html, /<a /g)).toBe(4)
  })
  it('labels sectors from 2 % on the chart and smaller ones only in the legend', () => {
    const drawing = html.slice(html.indexOf('<svg'), html.indexOf('</svg>'))
    expect(count(drawing, /<text /g)).toBe(3)
    expect(drawing).toContain('>20,70 %</text>')
    expect(drawing).toContain('>3,72 %</text>')
    expect(drawing).not.toContain('1,26 %')
  })
  it('keeps every item in the legend table with its name, sum and share', () => {
    expect(html).toContain('<caption>Траты по категориям, EUR</caption>')
    expect(html).toContain('<th scope="col">Название</th><th scope="col" class="ck-chart-number">Сумма</th><th scope="col" class="ck-chart-number">Доля</th>')
    const body = rows(html).slice(1)
    expect(body).toHaveLength(5)
    expect(body[0]).toContain('<td class="ck-chart-number">412,30 EUR</td><td class="ck-chart-number">20,70 %</td>')
    expect(body[1]).toContain('Категорию назначают в админке.')
    expect(body[2]).toContain('Прочее (3)')
    expect(body[3]).toContain('Строки без товара')
    expect(body[3]).not.toContain('Не входит в диаграмму')
    expect(body[4]).toContain('Залог и тара')
    expect(body[4]).toContain('Не входит в диаграмму: сумма не положительная.')
    expect(body[4]).toContain('ck-pie-swatch-none')
    expect(body[4]).toContain('-2,50 EUR')
  })
  it('shows the total in the middle until a sector is highlighted', () => {
    expect(html).toContain('<span class="ck-pie-center-label">Всего</span><strong>1 986,40 EUR</strong>')
  })
  it('draws a single 100 % sector as a full ring', () => {
    const single = renderToStaticMarkup(<PieChart title="Одна категория" items={[items[0]]} />)
    expect(count(single, /<g class="ck-pie-slice /g)).toBe(1)
    expect(single).toContain('d="M160 44A76 76 0 1 1 160 196A76 76 0 1 1 160 44ZM160 74A46 46 0 1 0 160 166A46 46 0 1 0 160 74Z"')
    expect(single).toContain('>20,70 %</text>')
  })
  it('renders a message for no items and keeps the table when nothing is positive', () => {
    const empty = renderToStaticMarkup(<PieChart title="Пусто" items={[]} />)
    expect(empty).toBe('<p class="ck-chart ck-chart-empty">Нет данных для диаграммы.</p>')
    expect(renderToStaticMarkup(<PieChart title="Пусто" items={[]} emptyMessage="За период трат нет." />)).toContain('За период трат нет.')
    const refunds = renderToStaticMarkup(<PieChart title="Возвраты" items={[items[4]]} />)
    expect(refunds).not.toContain('<svg')
    expect(refunds).toContain('диаграмма не построена')
    expect(refunds).toContain('Залог и тара')
  })
  it('repeats the palette with a hatch past eight ordinary items and uses the given link and headers', () => {
    const many = Array.from({ length: 10 }, (_, index): PieChartItem => ({
      key: `p${index}`, label: `Товар ${index + 1}`, value: 10, valueText: '10,00 EUR', shareText: '10,00 %', chartLabel: '10 %', href: `/catalog/products/${index + 1}`,
    }))
    const Link = ({ to, ...props }: ChartLinkProps) => <a {...props} href={to} data-spa="true" />
    const markup = renderToStaticMarkup(<PieChart title="Товары" items={many} linkComponent={Link} headers={{ name: 'Товар', value: 'Оплачено', share: 'Доля трат' }} />)
    expect(count(markup, /data-spa="true"/g)).toBe(20)
    expect(count(markup, /class="ck-pie-slice ck-chart-c1"/g)).toBe(2)
    expect(count(markup, /fill="url\(#[^)]+\)"/g)).toBe(2)
    expect(count(markup, /data-hatched="true"/g)).toBe(2)
    expect(markup).toContain('<th scope="col">Товар</th>')
    expect(markup).toContain('>10 %</text>')
    expect(markup).not.toContain('>10,00 %</text>')
  })
  it('escapes names instead of injecting markup', () => {
    const unsafe = renderToStaticMarkup(<PieChart title="<b>" items={[{ ...items[0], label: '<img src=x onerror=alert(1)>' }]} />)
    expect(unsafe).not.toContain('<img')
    expect(unsafe).toContain('&lt;img src=x onerror=alert(1)&gt;')
  })
})

describe('LineChart markup (Node, not keyboard or pointer behaviour)', () => {
  const eur = (value: number) => `${value.toFixed(2).replace('.', ',')} EUR`
  const point = (month: string, value: number) => ({ x: `2026-${month}-01`, value, valueText: eur(value) })
  const series: LineChartSeries[] = [
    { key: 'lidl', label: 'Lidl, Lindau', points: [point('01', 1.05), point('02', 1.05), point('04', 1.09)] },
    { key: 'aldi', label: 'Aldi, Lindau', note: 'похожий товар', points: [point('03', 0.99)] },
    { key: 'void', label: 'Без наблюдений', points: [] },
  ]
  const formatX = (x: string) => `${x.slice(5, 7)}.${x.slice(0, 4)}`
  const props = { title: 'Цена за штуку, EUR', series, interval: 'month' as const, formatX, formatValue: (value: number) => value.toFixed(2).replace('.', ',') }
  const html = renderToStaticMarkup(<LineChart {...props} valueAxisLabel="EUR/шт" />)
  const drawing = html.slice(html.indexOf('<svg class="ck-line-svg"'), html.indexOf('</svg>', html.indexOf('<svg class="ck-line-svg"')))

  it('exposes a focusable plot with a name, a key hint and a live line', () => {
    expect(html).toContain('<div class="ck-chart ck-line" role="group" aria-label="Цена за штуку, EUR">')
    expect(html).toMatch(/<div class="ck-line-plot" role="application" tabindex="0" aria-label="График: Цена за штуку, EUR" aria-roledescription="интерактивный график" aria-describedby="([^"]+)">/)
    const hintId = /aria-describedby="([^"]+)"/.exec(html)![1]
    expect(html).toContain(`<p class="ck-chart-note" id="${hintId}">`)
    expect(html).toContain('Esc — снять выделение')
    expect(html).toContain('<p class="ck-line-live" aria-live="polite" aria-atomic="true">Интервал не выбран.</p>')
    expect(html).toContain('<svg class="ck-line-svg" viewBox="0 0 640 300" aria-hidden="true"')
    expect(html).not.toContain('ck-line-tooltip')
    expect(html).not.toContain('ck-line-crosshair')
    expect(html).toContain('Вертикальная ось: EUR/шт.')
  })
  it('lists the series with checkboxes, a number and a non-colour key; a series without points is left out', () => {
    expect(html).toContain('<legend>Серии на графике</legend>')
    expect(count(html, /<input type="checkbox" checked=""\/>/g)).toBe(2)
    expect(html).toContain('<span class="ck-line-badge">1</span>Lidl, Lindau')
    expect(html).toContain('<span class="ck-line-badge">2</span>Aldi, Lindau<span class="ck-chart-note"> · похожий товар</span>')
    expect(html).not.toContain('Без наблюдений')
    const legend = html.slice(html.indexOf('<fieldset'), html.indexOf('</fieldset>'))
    expect(legend).toContain('ck-line-swatch ck-chart-c1')
    expect(legend).toContain('ck-line-swatch ck-chart-c2')
    expect(count(legend, /stroke-dasharray="7 4"/g)).toBe(1)
  })
  it('draws a broken line, a marker for a lone point and a label at each line end', () => {
    expect(count(drawing, /<g class="ck-line-series /g)).toBe(2)
    const [lidl, aldi] = drawing.split('<g class="ck-line-series ').slice(1)
    expect(count(lidl, /class="ck-line-path"/g)).toBe(1)
    expect(count(lidl, /class="ck-line-marker"/g)).toBe(3)
    expect(lidl).toContain('<g class="ck-line-end">')
    expect(lidl).toMatch(/>1<\/text>/)
    expect(count(aldi, /class="ck-line-path"/g)).toBe(0)
    expect(count(aldi, /class="ck-line-marker"/g)).toBe(1)
    expect(aldi).toMatch(/>2<\/text>/)
  })
  it('labels the axes through the caller’s formatters', () => {
    expect(drawing).toContain('>01.2026</text>')
    expect(drawing).toContain('>04.2026</text>')
    expect(drawing).toContain('>1,00</text>')
    expect(drawing).toContain('>1,10</text>')
  })
  it('gives the values as a table in <details>, with a dash where a series has no data', () => {
    const table = html.slice(html.indexOf('<details'))
    expect(table).toContain('<summary>Таблица значений</summary>')
    expect(table).toContain('role="region" aria-label="Таблица значений: Цена за штуку, EUR" tabindex="0"')
    expect(table).toContain('<caption>Цена за штуку, EUR</caption>')
    expect(table).toContain('<th scope="col">Интервал</th><th scope="col" class="ck-chart-number">Lidl, Lindau</th><th scope="col" class="ck-chart-number">Aldi, Lindau</th>')
    const body = rows(table).slice(1)
    expect(body).toEqual([
      '<th scope="row">01.2026</th><td class="ck-chart-number">1,05 EUR</td><td class="ck-chart-number">—</td>',
      '<th scope="row">02.2026</th><td class="ck-chart-number">1,05 EUR</td><td class="ck-chart-number">—</td>',
      '<th scope="row">03.2026</th><td class="ck-chart-number">—</td><td class="ck-chart-number">0,99 EUR</td>',
      '<th scope="row">04.2026</th><td class="ck-chart-number">1,09 EUR</td><td class="ck-chart-number">—</td>',
    ])
  })
  it('starts with the requested series switched off and keeps them in the legend and the table', () => {
    const hidden = renderToStaticMarkup(<LineChart {...props} defaultHiddenKeys={['aldi']} />)
    expect(count(hidden, /<input type="checkbox" checked=""\/>/g)).toBe(1)
    expect(count(hidden, /<input type="checkbox"\/>/g)).toBe(1)
    expect(count(hidden, /<g class="ck-line-series /g)).toBe(1)
    expect(hidden).not.toContain('>03.2026</text>')
    expect(hidden).toContain('<th scope="row">03.2026</th>')
    const none = renderToStaticMarkup(<LineChart {...props} defaultHiddenKeys={['aldi', 'lidl']} />)
    expect(count(none, /<g class="ck-line-series /g)).toBe(0)
    expect(none).toContain('Все серии скрыты.')
  })
  it('shows a single series without a legend and a one-point series as a marker', () => {
    const single = renderToStaticMarkup(<LineChart {...props} series={[series[1]]} />)
    expect(single).not.toContain('<fieldset')
    expect(count(single, /class="ck-line-marker"/g)).toBe(1)
    expect(count(single, /class="ck-line-path"/g)).toBe(0)
  })
  it('uses the caller’s short label and style slot', () => {
    const custom = renderToStaticMarkup(<LineChart {...props} series={[{ ...series[0], shortLabel: 'Lidl', slot: 3 }, series[1]]} />)
    expect(custom).toContain('<span class="ck-line-badge">Lidl</span>')
    expect(custom).toContain('ck-line-series ck-chart-c4')
    expect(custom).toMatch(/>Lidl<\/text>/)
  })
  it('renders a message when no series has data', () => {
    expect(renderToStaticMarkup(<LineChart {...props} series={[series[2]]} />)).toBe('<p class="ck-chart ck-chart-empty">Нет данных для графика.</p>')
    expect(renderToStaticMarkup(<LineChart {...props} series={[]} emptyMessage="Покупок за период нет." />)).toContain('Покупок за период нет.')
  })
})
