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

describe('PieChart legend rows of an item’s parts (Node, not pointer or focus behaviour)', () => {
  const base: PieChartItem[] = [
    { key: 'g1', label: 'Молоко', value: 120, valueText: '120,00 EUR', shareText: '48,00 %', href: '/stats?generic=1' },
    { key: 'g2', label: 'Хлеб', value: 80, valueText: '80,00 EUR', shareText: '32,00 %', href: '/stats?generic=2' },
    { key: 'other', label: 'Прочее', value: 40, valueText: '40,00 EUR', shareText: '16,00 %', tone: 'other', note: 'Ещё 3 обобщённых продукта с меньшими суммами, одной строкой.' },
    { key: 'unmatched', label: 'Строки без товара', value: 10, valueText: '10,00 EUR', shareText: '4,00 %', tone: 'muted' },
  ]
  const children = [
    { key: 'g3', label: 'Сыр', href: '/stats?generic=3', valueText: '25,00 EUR', shareText: '10,00 %', note: '4 строки · 3 чека' },
    { key: 'g4', label: 'Соль', href: '/stats?generic=4', valueText: '10,00 EUR', shareText: '4,00 %' },
    { key: 'rest', label: 'Ещё 12 товаров с меньшими суммами, одной строкой', valueText: '5,00 EUR', shareText: '2,00 %', note: 'Чтобы увидеть их, сузьте период.' },
  ]
  const withOther = (extra: Partial<PieChartItem>) => base.map((item) => (item.key === 'other' ? { ...item, ...extra } : item))
  const render = (items: PieChartItem[]) => renderToStaticMarkup(<PieChart title="Траты, EUR" items={items} centerLabel="Всего" centerValue="250,00 EUR" />)
  const drawingOf = (html: string) => html.slice(html.indexOf('<div class="ck-pie-figure">'), html.indexOf('<table'))
  const trs = (html: string) => [...html.matchAll(/<tr([^>]*)>(.*?)<\/tr>/g)].slice(1).map((match) => ({ attrs: match[1], body: match[2] }))

  const plain = render(base)
  const collapsed = render(withOther({ action: { label: 'Показать состав', ariaLabel: 'Показать состав «Прочего», EUR', href: '/stats?other=open', expanded: false } }))
  const expanded = render(withOther({
    note: '3 обобщённых продукта с меньшими суммами.',
    action: { label: 'Скрыть состав', href: '/stats', expanded: true },
    children, childrenPrefix: 'В составе «Прочего»: ',
    childrenStatus: <p role="status">Доли состава посчитаны от другой суммы.</p>,
  }))

  it('keeps the former markup when no item has the new fields', () => {
    expect(plain).not.toMatch(/ck-pie-child|ck-pie-action|ck-chart-hidden|aria-expanded|colSpan|colspan/)
    expect(trs(plain).map((row) => row.attrs)).toEqual(['', '', '', ''])
    expect(trs(plain)[2].body).toBe(
      '<th scope="row"><span class="ck-pie-name"><span class="ck-pie-swatch ck-chart-other" aria-hidden="true"></span>'
      + '<span class="ck-pie-name-text">Прочее<span class="ck-chart-note">Ещё 3 обобщённых продукта с меньшими суммами, одной строкой.</span></span></span></th>'
      + '<td class="ck-chart-number">40,00 EUR</td><td class="ck-chart-number">16,00 %</td>',
    )
    // Empty or absent values of the new fields are the same as no fields.
    expect(render(withOther({ children: [], childrenPrefix: 'В составе: ', childrenStatus: null }))).toBe(plain)
  })
  it('adds no sector, no label and no palette shift for child rows', () => {
    expect(drawingOf(expanded)).toBe(drawingOf(plain))
    expect(drawingOf(collapsed)).toBe(drawingOf(plain))
    expect(count(expanded, /<g class="ck-pie-slice /g)).toBe(4)
    // Children of an ordinary item do not move the colours of the items after it.
    const nested = render(base.map((item) => (item.key === 'g1' ? { ...item, children } : item)))
    expect(drawingOf(nested)).toBe(drawingOf(plain))
    expect(trs(nested)[4].body).toContain('ck-pie-swatch ck-chart-c2')
  })
  it('puts a toggle link with aria-expanded after the name and the note, the same element in both states', () => {
    expect(trs(collapsed)[2].body).toContain(
      'одной строкой.</span><a href="/stats?other=open" class="ck-pie-action" aria-expanded="false" aria-label="Показать состав «Прочего», EUR">Показать состав</a></span>',
    )
    expect(trs(expanded)[2].body).toContain('<a href="/stats" class="ck-pie-action" aria-expanded="true">Скрыть состав</a></span>')
    expect(count(collapsed, /aria-expanded=/g)).toBe(1)
    // The toggle only: the row keeps its sum and share, the drawing its link count.
    expect(trs(collapsed)[2].body).toContain('<td class="ck-chart-number">40,00 EUR</td><td class="ck-chart-number">16,00 %</td>')
    const spa = ({ to, ...props }: ChartLinkProps) => <a {...props} href={to} data-spa="true" />
    const linked = renderToStaticMarkup(<PieChart title="Траты, EUR" items={withOther({ action: { label: 'Показать состав', href: '/stats?other=open', expanded: false } })} linkComponent={spa} />)
    expect(linked).toContain('<a class="ck-pie-action" aria-expanded="false" href="/stats?other=open" data-spa="true">Показать состав</a>')
  })
  it('orders the rows: items before, the item, its children, the status row, items after', () => {
    const body = trs(expanded)
    expect(body.map((row) => row.attrs)).toEqual(['', '', '', ' class="ck-pie-child"', ' class="ck-pie-child"', ' class="ck-pie-child"', ' class="ck-pie-child-status"', ''])
    expect(body[2].body).toContain('Прочее')
    expect(body[7].body).toContain('Строки без товара')
  })
  it('renders a child as a row header with the hidden prefix, the swatch of its item, a link and a note', () => {
    const body = trs(expanded)
    expect(body[3].body).toBe(
      '<th scope="row"><span class="ck-pie-name"><span class="ck-pie-swatch ck-chart-other" aria-hidden="true"></span>'
      + '<span class="ck-pie-name-text"><span><span class="ck-chart-hidden">В составе «Прочего»: </span><a href="/stats?generic=3">Сыр</a></span>'
      + '<span class="ck-chart-note">4 строки · 3 чека</span></span></span></th>'
      + '<td class="ck-chart-number">25,00 EUR</td><td class="ck-chart-number">10,00 %</td>',
    )
    expect(body[4].body).not.toContain('ck-chart-note')
    // The remainder: no link, the hint under the name.
    expect(body[5].body).toContain('</span>Ещё 12 товаров с меньшими суммами, одной строкой</span><span class="ck-chart-note">Чтобы увидеть их, сузьте период.</span>')
    expect(body[5].body).not.toContain('<a ')
    expect(body[5].body).toContain('<td class="ck-chart-number">5,00 EUR</td><td class="ck-chart-number">2,00 %</td>')
    // Child links are keyboard stops; the drawing gets no link for them.
    expect(count(expanded, /tabindex="-1"/g)).toBe(2)
    expect(count(expanded, /<a href="\/stats\?generic=3"/g)).toBe(1)
  })
  it('spans the status row over every column and shows it without children too', () => {
    expect(trs(expanded)[6].body).toBe('<td colSpan="3"><div class="ck-pie-child-status-body"><p role="status">Доли состава посчитаны от другой суммы.</p></div></td>')
    expect(count(expanded, /<th scope="col"/g)).toBe(3)
    const loading = render(withOther({ childrenStatus: <p role="status">Загружаем состав…</p> }))
    expect(trs(loading).map((row) => row.attrs)).toEqual(['', '', '', ' class="ck-pie-child-status"', ''])
    expect(count(loading, /role="status"/g)).toBe(1)
  })
  it('gives children of an item that is not drawn its dashed swatch and takes 500 rows', () => {
    const refund: PieChartItem = { key: 'other', label: 'Прочее', value: -4, valueText: '-4,00 EUR', shareText: '—', tone: 'other', children: children.slice(0, 1) }
    expect(trs(render([base[0], refund]))[2].body).toContain('<span class="ck-pie-swatch ck-pie-swatch-none" aria-hidden="true"></span>')
    const many = Array.from({ length: 500 }, (_, index) => ({ key: `p${index}`, label: `Товар ${index + 1}`, valueText: '0,01 EUR', shareText: '0,01 %' }))
    const long = render(withOther({ children: many }))
    expect(count(long, /<tr class="ck-pie-child">/g)).toBe(500)
    expect(drawingOf(long)).toBe(drawingOf(plain))
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
