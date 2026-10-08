import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const app = read('../../App.css')
const merges = read('../../features/merges/Merges.css')
const product = read('../../features/product/Product.css')
const receipts = read('../../features/stats/ReceiptsStats.css')
const spending = read('../../features/stats/Spending.css')
const charts = read('./Charts.css')

/** Flat rules only: enough for these stylesheets, where a media block holds whole rules. */
const rules = (css: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((match) => ({ selector: match[1].trim(), body: match[2].trim() }))
const rule = (css: string, selector: string) => rules(css).filter((item) => item.selector === selector).map((item) => item.body).join(' ')

describe('stylesheet guards (text of the rules, not rendering)', () => {
  it('anchors the line tooltip by the edge of its side and offsets it by a margin, not a transform', () => {
    const base = rule(charts, '.ck-line-tooltip')
    expect(base).toContain('position: absolute')
    expect(base).toContain('max-width: min(260px, 70%)')
    // `left`/`right` come inline from lineTooltipAnchor; a transform would not widen the shrink-to-fit room.
    expect(base).not.toMatch(/(^|[;\s])(left|right|width|transform)\s*:/)
    expect(rule(charts, '.ck-line-tooltip[data-side="right"]')).toBe('margin-left: 12px;')
    expect(rule(charts, '.ck-line-tooltip[data-side="left"]')).toBe('margin-right: 12px;')
    expect(rules(charts).filter((item) => item.selector.includes('ck-line-tooltip') && item.body.includes('transform'))).toEqual([])
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
