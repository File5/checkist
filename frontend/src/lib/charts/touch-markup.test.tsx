import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LineChart, PieChart } from './index'
import type { LineChartSeries, PieChartItem } from './index'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const lineSource = read('./LineChart.tsx')
const pieSource = read('./PieChart.tsx')

describe('LineChart step buttons (server markup and source text, not gestures)', () => {
  const point = (month: string, value: number) => ({ x: `2026-${month}-01`, value, valueText: `${value} EUR` })
  const series: LineChartSeries[] = [
    { key: 'lidl', label: 'Lidl', points: [point('01', 1.05), point('02', 1.09)] },
    { key: 'aldi', label: 'Aldi', points: [point('02', 0.99)] },
  ]
  const props = { title: 'Цена за штуку, EUR', series, interval: 'month' as const, formatX: (x: string) => x, formatValue: String }
  const html = renderToStaticMarkup(<LineChart {...props} />)
  const panel = /<div class="ck-line-steps"[^>]*>(.*?)<\/div>/.exec(html)

  it('puts three named buttons right under the plot, before the notes and the live line', () => {
    expect(panel?.[0]).toBe(
      '<div class="ck-line-steps">'
      + '<button type="button" disabled="">Предыдущий интервал</button>'
      + '<button type="button" disabled="">Следующий интервал</button>'
      + '<button type="button" disabled="">Снять выделение</button></div>',
    )
    const at = (text: string) => html.indexOf(text)
    expect(at('class="ck-line-steps"')).toBeGreaterThan(at('</svg>'))
    expect(at('class="ck-line-steps"')).toBeLessThan(at('Клавиши на графике'))
    expect(at('class="ck-line-steps"')).toBeLessThan(at('class="ck-line-live"'))
    expect(html.match(/<button /g)).toHaveLength(3)
    // The buttons are named by the group of the chart; a group of their own would be counted as one more chart.
    expect(html.match(/role="group"/g)).toHaveLength(1)
    expect(html.indexOf('<div class="ck-chart ck-line" role="group" aria-label="Цена за штуку, EUR">')).toBe(0)
  })
  it('keeps every button off without a selection, also while all series are hidden', () => {
    const hidden = renderToStaticMarkup(<LineChart {...props} defaultHiddenKeys={['lidl', 'aldi']} />)
    expect(hidden).toContain('Все серии скрыты.')
    expect(hidden.match(/<button type="button" disabled="">/g)).toHaveLength(3)
  })
  it('draws no panel without data', () => {
    const empty = renderToStaticMarkup(<LineChart {...props} series={[]} />)
    expect(empty).toBe('<p class="ck-chart ck-chart-empty">Нет данных для графика.</p>')
  })
  it('leaves the keyboard hint, the live line and the table of values as they were', () => {
    expect(html).toContain('Клавиши на графике: ← и → — соседний интервал, Home и End — первый и последний, Esc — снять выделение.')
    expect(html).toContain('<p class="ck-line-live" aria-live="polite" aria-atomic="true">Интервал не выбран.</p>')
    expect(html).toContain('<details class="ck-line-table"><summary>Таблица значений</summary>')
  })
  it('takes the availability of the buttons and the gesture from the pure functions', () => {
    expect(lineSource).toContain('const steps = stepAvailability(activeX, layout.xs)')
    for (const name of ['previous', 'next', 'clear']) expect(lineSource).toContain(`disabled={!steps.${name}}`)
    expect(lineSource).toContain('advanceTouchGesture(gesture.current, step)')
    expect(lineSource).toContain('pointerToPlotX(event.clientX, event.currentTarget.getBoundingClientRect(), layout.width)')
    expect(lineSource).toContain("dispatch({ type: 'touch-commit', x: intervalAt(event) })")
    expect(lineSource).toContain('setPointerCapture(event.pointerId)')
    for (const handler of ['onPointerMove', 'onPointerDown', 'onPointerUp', 'onPointerCancel']) expect(lineSource).toContain(`${handler}={onPointer}`)
    // No press-and-hold and no timers at all.
    expect(lineSource).not.toMatch(/setTimeout|setInterval|contextmenu/i)
  })
})

describe('PieChart under a finger (server markup and source text, not gestures)', () => {
  const items: PieChartItem[] = [
    { key: 'c2', label: 'Молочные продукты', value: 412.3, valueText: '412,30 EUR', shareText: '84,63 %', href: '/stats?category=2' },
    { key: 'other', label: 'Прочее', value: 74.9, valueText: '74,90 EUR', shareText: '15,37 %', tone: 'other' },
  ]
  const html = renderToStaticMarkup(<PieChart title="Траты, EUR" items={items} centerLabel="Всего" centerValue="487,20 EUR" />)

  it('keeps the sector a link for the mouse, with the same address in the legend for a finger and the keyboard', () => {
    expect(html).toContain('<a href="/stats?category=2" class="ck-pie-link" tabindex="-1"><path')
    expect(html).toContain('<a href="/stats?category=2">Молочные продукты</a>')
    expect(html).not.toContain('data-state=')
  })
  it('stops only a finger from following the sector link and pins by a lifted finger', () => {
    expect(pieSource).toContain("onClickCapture: (event: MouseEvent) => { if (lastPointerType.current === 'touch') event.preventDefault() }")
    expect(pieSource).toContain("if (event.pointerType !== 'touch') dispatch({ type: 'enter', key })")
    expect(pieSource).toContain("dispatch({ type: 'pin', key })")
    expect(pieSource).toContain("event.target.closest('a, button')")
    expect(pieSource).toContain('{...sectorHandlers(slice.key)}')
  })
})
