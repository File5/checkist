import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LineChart } from './index'
import type { LineChartSeries } from './index'
import LineValueCards from './LineValueCards'
import { cleanPoints, periodStarts } from './line'

const eur = (value: number) => `${value.toFixed(2).replace('.', ',')}\u00a0EUR/шт`
const point = (month: string, value: number) => ({ x: `2026-${month}-01`, value, valueText: eur(value) })
const longStore = 'ID 51 · Гипермаркет у дома на проспекте Победы · Санкт-Петербург · RU'
const series: LineChartSeries[] = [
  { key: 'lidl', label: 'Lidl, Lindau', points: [point('01', 1.05), point('02', 1.05), point('04', 1.09)] },
  { key: 'aldi', label: 'Aldi, Lindau', note: 'похожий товар', points: [point('03', 0.99)] },
  { key: 'void', label: 'Без наблюдений', points: [] },
  { key: 'long', label: longStore, points: [point('04', 0), point('02', 189490), { x: 'не дата', value: 1, valueText: 'мусор' }] },
]
const title = 'Цена за штуку, EUR'
const formatX = (x: string) => `${x.slice(5, 7)}.${x.slice(0, 4)}`
const props = { title, series, interval: 'month' as const, formatX, formatValue: (value: number) => value.toFixed(2).replace('.', ',') }

/** The table as the wide screen draws it (no `window` in Node: the hook answers «wide»). */
function tableOf(input: readonly LineChartSeries[] = series, format = formatX) {
  const html = renderToStaticMarkup(<LineChart {...props} series={input} formatX={format} />)
  const table = html.slice(html.indexOf('<details'))
  return {
    html,
    table,
    columns: [...table.matchAll(/<th scope="col"[^>]*>([^<]+)<\/th>/g)].map((match) => match[1]),
    rows: [...table.matchAll(/<tr><th scope="row">(.*?)<\/th>(.*?)<\/tr>/g)].map((row) => ({
      title: row[1], cells: [...row[2].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map((cell) => cell[1]),
    })),
  }
}

/** The cards on the data the chart hands them: the series that have points, and every interval of theirs. */
function cardsOf(input: readonly LineChartSeries[] = series, format = formatX) {
  const columns = input.map((item) => ({ item, points: cleanPoints(item.points) })).filter((entry) => entry.points.length > 0)
  const html = renderToStaticMarkup(
    <LineValueCards label={`Таблица значений: ${title}`} caption={title} xs={periodStarts(columns)} columns={columns} formatX={format} />,
  )
  return {
    html,
    cards: [...html.matchAll(/<li class="ck-card"><div class="ck-card-title">(.*?)<\/div><dl class="ck-card-facts">(.*?)<\/dl><\/li>/g)].map((card) => ({
      title: card[1],
      facts: [...card[2].matchAll(/<div class="ck-card-fact" data-kind="(\w+)"><dt>([^<]*)<\/dt><dd>(.*?)<\/dd><\/div>/g)]
        .map((fact) => ({ kind: fact[1], label: fact[2], value: fact[3] })),
    })),
  }
}

describe('cards of the table of values against the table on the same data (SSR in Node, not browser acceptance)', () => {
  it('labels the facts with the headings of the columns, in the order of the columns', () => {
    const table = tableOf()
    const { cards } = cardsOf()
    expect(table.columns).toEqual(['Интервал', 'Lidl, Lindau', 'Aldi, Lindau', longStore])
    expect(cards).toHaveLength(4)
    // The first column is the heading of the card, every series is a fact; a series without points has no column.
    for (const card of cards) expect(card.facts.map((fact) => fact.label)).toEqual(table.columns.slice(1))
  })

  it('shows the same interval and the same values as the row of the table', () => {
    const table = tableOf()
    const { cards } = cardsOf()
    expect(table.rows).toHaveLength(4)
    expect(cards.map((card) => card.title.replace(/<\/?time[^>]*>/g, ''))).toEqual(table.rows.map((row) => row.title))
    expect(cards.map((card) => card.facts.map((fact) => fact.value))).toEqual(table.rows.map((row) => row.cells))
    expect(cards.map((card) => card.facts.map((fact) => fact.value))).toEqual([
      ['1,05\u00a0EUR/шт', '—', '—'],
      ['1,05\u00a0EUR/шт', '—', '189490,00\u00a0EUR/шт'],
      ['—', '0,99\u00a0EUR/шт', '—'],
      ['1,09\u00a0EUR/шт', '—', '0,00\u00a0EUR/шт'],
    ])
  })

  it('keeps the dash of the table where a series has no data, and a zero value as a number', () => {
    const { cards, html } = cardsOf()
    // Nothing is dropped: every card has a fact per column, as every row has a cell per column.
    for (const card of cards) {
      expect(card.facts).toHaveLength(3)
      for (const fact of card.facts) {
        expect(fact.kind).toBe('value')
        expect(fact.value).not.toBe('')
      }
    }
    expect(cards[3].facts[2]).toEqual({ kind: 'value', label: longStore, value: '0,00\u00a0EUR/шт' })
    expect(html.match(/<dd>—<\/dd>/g)).toHaveLength(tableOf().table.match(/<td class="ck-chart-number">—<\/td>/g)!.length)
    for (const absent of ['Без наблюдений', 'мусор', 'не дата', 'похожий товар', 'undefined', 'null']) expect(html).not.toContain(absent)
  })

  it('keeps the name of an interval whole inside <time> with its period start', () => {
    const { cards, html } = cardsOf()
    expect(cards.map((card) => card.title)).toEqual(['01', '02', '03', '04'].map((month) => `<time dateTime="2026-${month}-01">${month}.2026</time>`))
    const week = (x: string) => `неделя с ${x.slice(8, 10)}.${x.slice(5, 7)}.${x.slice(0, 4)}`
    const weekly = cardsOf(series, week)
    expect(weekly.cards[1].title).toBe('<time dateTime="2026-02-01">неделя с 01.02.2026</time>')
    expect(weekly.cards.map((card) => card.title.replace(/<\/?time[^>]*>/g, ''))).toEqual(tableOf(series, week).rows.map((row) => row.title))
    // No date outside <time>.
    for (const markup of [html, weekly.html]) expect(markup.replace(/<time[^>]*>[^<]*<\/time>/g, '').replace(/<[^>]+>/g, '')).not.toMatch(/\d{2}\.\d{4}/)
  })

  it('names the list as the frame of the table and keeps the caption above it', () => {
    const { table } = tableOf()
    const { html } = cardsOf()
    expect(table).toContain(`role="region" aria-label="Таблица значений: ${title}" tabindex="0"`)
    expect(table).toContain(`<caption>${title}</caption>`)
    expect(html.startsWith(`<div class="ck-cards"><p class="ck-cards-caption">${title}</p><ul class="ck-cards-list" aria-label="Таблица значений: ${title}">`)).toBe(true)
    for (const absent of ['<table', 'role="region"', 'tabindex', ' id=', 'data-tone', 'ck-card-footer']) expect(html).not.toContain(absent)
  })

  it('has no links or buttons, as the table has none', () => {
    expect(tableOf().table).not.toMatch(/<a |<button|<input/)
    expect(cardsOf().html).not.toMatch(/<a |<button|<input/)
  })

  it('draws a single series as one fact per card', () => {
    const { cards } = cardsOf([series[1]])
    expect(cards).toEqual([{ title: '<time dateTime="2026-03-01">03.2026</time>', facts: [{ kind: 'value', label: 'Aldi, Lindau', value: '0,99\u00a0EUR/шт' }] }])
    expect(tableOf([series[1]]).rows).toEqual([{ title: '03.2026', cells: ['0,99\u00a0EUR/шт'] }])
  })
})

describe('the view is chosen only inside the opened details of a chart with data (text of the sources and SSR)', () => {
  const source = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
  const chart = source('./LineChart.tsx')

  it('leaves the empty chart to the former message', () => {
    const html = renderToStaticMarkup(<LineChart {...props} series={[series[2]]} />)
    expect(html).toBe('<p class="ck-chart ck-chart-empty">Нет данных для графика.</p>')
  })

  it('keeps the table on a wide screen, with the summary and the details as they were', () => {
    const { html } = tableOf()
    expect(html).toContain('<details class="ck-line-table"><summary>Таблица значений</summary><div class="ck-line-table-scroll" role="region"')
    expect(html.endsWith('</table></div></details></div>')).toBe(true)
    expect(html).not.toContain('ck-card')
  })

  it('draws the cards instead of the scrolling frame, after the same summary', () => {
    const choice = chart.indexOf('{narrow ? <LineValueCards label={tableLabel} caption={title} xs={allXs} columns={described} formatX={formatX} /> : (')
    expect(choice).toBeGreaterThan(-1)
    expect(chart.match(/\buseNarrow\(/g)).toHaveLength(1)
    expect(chart.match(/<LineValueCards /g)).toHaveLength(1)
    expect(chart.match(/<summary>/g)).toHaveLength(1)
    const details = chart.indexOf('<details className="ck-line-table">')
    expect(chart.indexOf('<summary>Таблица значений</summary>')).toBeGreaterThan(details)
    expect(chart.indexOf('<summary>Таблица значений</summary>')).toBeLessThan(choice)
    for (const inside of ['<div className="ck-line-table-scroll" role="region" aria-label={tableLabel} tabIndex={0}>', '<table>', '<caption>{title}</caption>']) {
      expect(chart.indexOf(inside)).toBeGreaterThan(choice)
    }
    expect(chart.indexOf('</details>')).toBeGreaterThan(chart.indexOf(')}', chart.indexOf('</table>')))
    // The hook is called before the early return of an empty chart.
    expect(chart.indexOf('useNarrow()')).toBeLessThan(chart.indexOf('if (described.length === 0)'))
  })

  it('gives both views one name, one caption and the same columns', () => {
    expect(chart.split('`Таблица значений: ${title}`')).toHaveLength(2)
    expect(chart).toContain('const tableLabel = `Таблица значений: ${title}`')
    // The headings of the table and the labels of the facts are the labels of the same `described` entries.
    expect(chart).toContain('{described.map((entry) => <th key={entry.item.key} scope="col" className="ck-chart-number">{entry.item.label}</th>)}')
    const cards = source('./LineValueCards.tsx')
    expect(cards).toContain('label: entry.item.label')
    expect(cards).toContain("entry.points.find((point) => point.x === x)?.valueText ?? '—'")
    expect(chart).toContain("{entry.points.find((point) => point.x === x)?.valueText ?? '—'}")
    // The cards bring no styles of their own.
    expect(cards).not.toMatch(/\.css'|style=|className=/)
  })
})
