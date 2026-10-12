import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const sheets = { trends: read('./Trends.css'), columns: read('../../lib/charts/Columns.css') }
const rules = (css: string) => [...css.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((match) => ({ selector: match[1].trim(), body: match[2].trim() }))
const rule = (css: string, selector: string) => rules(css).filter((item) => item.selector === selector).map((item) => item.body).join(' ')

describe('«Динамика» stylesheets (text of the rules, not rendering)', () => {
  it.each(Object.entries(sheets))('%s: colours are theme tokens only, no font-size of the screen changed elsewhere', (_, css) => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(css).not.toMatch(/\brgba?\(|\bhsla?\(/)
    expect(css).not.toContain('@media')
  })
  it('gives every category its own colour, the same number as on «Главная»', () => {
    for (let tone = 1; tone <= 6; tone += 1) {
      expect(rule(sheets.columns, `.ck-columns-tone-${tone}`)).toBe(`--ck-col: var(--ck-cat-${tone});`)
      expect(rule(sheets.trends, `.trends-cat-${tone}`)).toBe(`--trends-cat: var(--ck-cat-${tone});`)
    }
  })
  it('never tears a value and keeps changes in warning and success tokens', () => {
    for (const selector of ['.trends-big', '.trends-value', '.trends-badge', '.trends-number', '.trends-cell-month']) {
      expect(rule(sheets.trends, selector)).toContain('white-space: nowrap')
    }
    expect(rule(sheets.trends, '.trends-badge-up')).toContain('var(--ck-warning-text)')
    expect(rule(sheets.trends, '.trends-badge-down')).toContain('var(--ck-success-text)')
    expect(rule(sheets.trends, '.trends-cell-over')).toContain('var(--ck-warning-bg)')
  })
  it('lets the page scroll under a finger on the columns and gives a column the whole slot as its target', () => {
    expect(rule(sheets.columns, '.ck-columns-plot')).toContain('touch-action: pan-y pinch-zoom')
    expect(rule(sheets.columns, '.ck-columns-hit')).toContain('pointer-events: auto')
  })
})
