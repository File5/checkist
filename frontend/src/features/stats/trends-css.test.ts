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
  it('never tears a value and keeps changes in the over and success tokens', () => {
    for (const selector of ['.trends-big', '.trends-value', '.trends-badge', '.trends-number', '.trends-cell-month']) {
      expect(rule(sheets.trends, selector)).toContain('white-space: nowrap')
    }
    // More spent or dearer is the over tone of «Главная», less — the success tone; the arrow and the words say it too.
    for (const kind of ['badge', 'change']) {
      expect(rule(sheets.trends, `.trends-${kind}-up`)).toBe('color: var(--ck-over-text);')
      expect(rule(sheets.trends, `.trends-${kind}-down`)).toBe('color: var(--ck-success-text);')
    }
    expect(rule(sheets.trends, '.trends-cell-over .trends-cell-bar span')).toBe('background: var(--ck-over-bar);')
    expect(rule(sheets.trends, '.trends-cell-over .trends-cell-percent, .trends-cell-word')).toContain('color: var(--ck-over-text)')
  })
  it('sets every text size from the scale of the theme', () => {
    for (const [, size] of sheets.trends.matchAll(/font-size:\s*([^;]+);/g)) expect(size).toMatch(/^var\(--ck-text-(xs|sm|base|lg|xl|hero)\)$/)
  })
  it('keeps the hidden words of a change inside the frame of the wide table', () => {
    expect(rule(sheets.trends, '.trends-table-scroll')).toContain('position: relative')
    expect(rule(sheets.trends, '.trends-table-scroll')).toContain('overflow-x: auto')
  })
  it('lets the page scroll under a finger on the columns and gives a column the whole slot as its target', () => {
    expect(rule(sheets.columns, '.ck-columns-plot')).toContain('touch-action: pan-y pinch-zoom')
    expect(rule(sheets.columns, '.ck-columns-hit')).toContain('pointer-events: auto')
  })
})
