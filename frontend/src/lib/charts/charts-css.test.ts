import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const app = read('../../App.css')
const merges = read('../../features/merges/Merges.css')
const product = read('../../features/product/Product.css')
const receipts = read('../../features/stats/ReceiptsStats.css')
const spending = read('../../features/stats/Spending.css')
const charts = read('./Charts.css')
const pieSource = read('./PieChart.tsx')
const lineSource = read('./LineChart.tsx')

/** Flat rules only: enough for these stylesheets, where a media block holds whole rules. */
const rules = (css: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((match) => ({ selector: match[1].trim(), body: match[2].trim() }))
const rule = (css: string, selector: string) => rules(css).filter((item) => item.selector === selector).map((item) => item.body).join(' ')
/** Rules of every `@media (max-width: …)` block, the narrow-screen overrides. */
const narrow = (css: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/@media \(max-width: \d+px\) \{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)]
  .flatMap((match) => rules(match[1]))
const declares = (body: string, property: string) => new RegExp(`(^|[;\\s])${property}\\s*:`).test(body)

describe('stylesheet guards (text of the rules, not rendering)', () => {
  it('fits the line tooltip into the plot as a row: the tooltip gives way first, then the gap to the crosshair', () => {
    const track = rule(charts, '.ck-line-tooltip-track')
    expect(track).toContain('position: absolute')
    expect(track).toMatch(/(^|[;\s])left:\s*0\b/)
    expect(track).toMatch(/(^|[;\s])right:\s*0\b/)
    expect(track).toContain('display: flex')
    expect(rule(charts, '.ck-line-tooltip-track[data-side="left"]')).toBe('flex-direction: row-reverse;')
    const base = rule(charts, '.ck-line-tooltip')
    expect(base).toContain('max-width: min(260px, 70%)')
    // The tooltip is an item of the row: no position of its own, and a transform would not take part in the fitting.
    expect(base).not.toMatch(/(^|[;\s])(position|left|right|width|transform)\s*:/)
    const shrink = (body: string) => Number(/(^|[;\s])flex:\s*0\s+(\d+)\s+auto/.exec(body)?.[2])
    expect(shrink(rule(charts, '.ck-line-tooltip-gap'))).toBe(1)
    expect(shrink(base)).toBeGreaterThan(1000)
    expect(rule(charts, '.ck-line-tooltip[data-side="right"]')).toBe('margin-left: 12px;')
    expect(rule(charts, '.ck-line-tooltip[data-side="left"]')).toBe('margin-right: 12px;')
    expect(rules(charts).filter((item) => item.selector.includes('ck-line-tooltip') && item.body.includes('transform'))).toEqual([])
    // The gap takes its length from lineTooltipAnchor, and a value in the tooltip wraps only between whole words.
    expect(lineSource).toContain('<span className="ck-line-tooltip-gap" style={{ flexBasis:')
    expect(lineSource).toContain('<strong>{wholeWords(value)}</strong>')
  })
  it('never tears a value: numbers, whole words and interval names keep one line at every width', () => {
    expect(rule(charts, '.ck-chart-number')).toContain('white-space: nowrap')
    expect(rule(charts, '.ck-chart-whole')).toBe('white-space: nowrap;')
    const interval = rule(charts, '.ck-line-table tbody th')
    expect(interval).toContain('white-space: nowrap')
    expect(declares(interval, 'min-width')).toBe(true)
    // Only a column heading may wrap, and it wraps between words: `break-word` keeps a word in the least width.
    const wrapping = [charts, spending, receipts].flatMap(rules).filter((item) => /white-space:\s*normal/.test(item.body)).map((item) => item.selector)
    expect(wrapping).toEqual(['.ck-chart thead th.ck-chart-number', '.ck-pie-center-label', '.stats-table thead .stats-number'])
    expect(rule(charts, '.ck-chart thead th')).toContain('overflow-wrap: break-word')
    expect(narrow(charts).length).toBeGreaterThan(0)
    for (const item of [charts, spending, receipts].flatMap(narrow)) expect(item.body, item.selector).not.toMatch(/white-space/)
  })
  it('keeps the legend of the pie in three columns that scroll only inside a named, focusable frame', () => {
    expect(rule(charts, '.ck-pie-legend-scroll')).toContain('overflow-x: auto')
    expect(pieSource).toContain('<div className="ck-pie-legend-scroll" role="region" aria-label={`Таблица: ${title}`} tabIndex={0}>')
    expect(declares(rule(charts, '.ck-pie-legend tbody th'), 'min-width')).toBe(true)
    expect(pieSource.match(/<th scope="col"/g)).toHaveLength(3)
    expect(lineSource).toContain('<div className="ck-line-table-scroll" role="region"')
    const scrolling = rules(charts).filter((item) => /overflow-x:\s*auto/.test(item.body)).map((item) => item.selector)
    expect(scrolling).toEqual(['.ck-pie-legend-scroll', '.ck-line-table-scroll'])
  })
  it('keeps the sum in the middle of the pie whole and no wider than the hole of the ring', () => {
    const center = rule(charts, '.ck-pie-center')
    expect(center).toContain('white-space: nowrap')
    expect(center).toMatch(/(^|[;\s])width:\s*calc\(var\(--ck-pie-hole[^)]*\) - \d+px\)/)
    const value = rule(charts, '.ck-pie-center-value')
    expect(value).toContain('max-width: 100%')
    expect(value).toContain('overflow: hidden')
    // A sum that does not fit is taken out of the middle (it stays in the legend), and goes on being measured.
    const hidden = rule(charts, '.ck-pie-center-value[data-fits="false"]')
    expect(hidden).toContain('visibility: hidden')
    expect(hidden).not.toMatch(/display:\s*none/)
    expect(pieSource).toContain("'--ck-pie-hole'")
  })
  it('draws chart text at exactly 12px: both drawings follow the real width instead of stretching a fixed viewBox', () => {
    expect(rule(charts, '.ck-chart svg text')).toContain('font-size: 12px')
    for (const source of [pieSource, lineSource]) {
      expect(source).toContain('usePlotWidth<HTMLDivElement>(')
      expect(source).toMatch(/viewBox=\{`0 0 \$\{\w+\.width\} \$\{[^`]+\}`\}/)
    }
    expect(pieSource).toContain('<div ref={figureRef} className="ck-pie-figure"')
    expect(lineSource).toMatch(/ref=\{plotRef\}\s+className="ck-line-plot"/)
    // No other size for the text of a drawing, on any screen.
    const sized = rules(charts).filter((item) => /\bsvg\b|\btext\b/.test(item.selector) && declares(item.body, 'font-size')).map((item) => item.selector)
    expect(sized).toEqual(['.ck-chart svg text'])
  })
  it('keeps the toggle link of a pie legend row a 44px target over a screen’s own link rule, without motion', () => {
    const action = rule(charts, '.ck-chart .ck-pie-legend a.ck-pie-action')
    expect(action).toContain('min-height: 44px')
    expect(action).toContain('display: inline-flex')
    // The screen rule this one has to outweigh: two classes and an element.
    expect(rule(spending, '.spending-currency .ck-pie-legend a')).toContain('display: inline-block')
    const parts = rules(charts).filter((item) => /ck-pie-(child|action)|ck-chart-hidden/.test(item.selector))
    expect(parts.length).toBeGreaterThan(5)
    for (const item of parts) expect(item.body, item.selector).not.toMatch(/transition|animation|#[0-9a-f]{3,8}\b|rgba?\(/i)
    expect(rule(charts, '.ck-chart-hidden')).toContain('clip-path: inset(50%)')
  })
  it('resets the global 44px minimum height wherever a checkbox or radio is given a small box', () => {
    expect(rule(app, 'input, select')).toContain('min-height: 44px')
    const small = [charts, spending, receipts, product, merges].flatMap(rules)
      .filter((item) => /\binput$/.test(item.selector) && /(^|[;\s])height:\s*[12]\dpx/.test(item.body))
    expect(small.map((item) => item.selector)).toEqual([
      '.ck-line-legend-item input', '.spending-store-list input', '.stats-check input',
      '.product-page .product-chart-option input, .product-page .ck-line-legend-item input', '.ck-merge-choice input',
    ])
    for (const item of small) expect(item.body, item.selector).toMatch(/(^|[;\s])min-height:\s*0\b/)
  })
})
