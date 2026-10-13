import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, '')
const spending = css('./Spending.css')
const receipts = css('./ReceiptsStats.css')
const bar = css('./StatsBar.css')
const compare = read('./receipts-compare.tsx')

interface Rule { selector: string; body: string }
/** Flat rules: a media block of these stylesheets holds whole rules. */
const rules = (text: string): Rule[] => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim(), body: match[2].trim() })))
const rule = (text: string, selector: string) => rules(text).filter((item) => item.selector === selector).map((item) => item.body).join(' ')
/** Rules of every `@media (max-width: …)` block, the narrow-screen overrides. */
const narrow = (text: string): Rule[] => [...text.matchAll(/@media \(max-width: \d+px\) \{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)].flatMap((match) => rules(match[1]))
const declares = (body: string, property: string) => new RegExp(`(^|[;\\s])${property}\\s*:`).test(body)

describe('statistics stylesheet guards (text of the rules, not rendering)', () => {
  it('never tears a value: numbers and totals keep one line, in a table and outside it', () => {
    expect(rule(receipts, '.stats-number')).toContain('white-space: nowrap')
    expect(rule(spending, '.spending-total')).toContain('white-space: nowrap')
    expect(rule(spending, '.spending-figure')).toContain('white-space: nowrap')
    // Only a column heading may wrap, and it wraps between words: `break-word` keeps a word in the least width.
    const wrapping = [spending, receipts].flatMap(rules).filter((item) => /white-space:\s*normal/.test(item.body)).map((item) => item.selector)
    expect(wrapping).toEqual(['.stats-table thead .stats-number'])
    expect(rule(receipts, '.stats-table thead th')).toContain('overflow-wrap: break-word')
  })
  it('does not take the single line back on a narrow screen', () => {
    for (const item of [spending, receipts].flatMap(narrow)) expect(item.body, item.selector).not.toMatch(/white-space/)
  })
  it('lays the date fields out by the room they need, not by a fixed number of columns', () => {
    expect(rule(receipts, '.stats-field-grid')).toContain('grid-template-columns: repeat(auto-fit, minmax(min(100%, 160px), 1fr))')
    const overridden = [spending, receipts].flatMap(narrow)
      .filter((item) => item.selector === '.stats-field-grid' && declares(item.body, 'grid-template-columns'))
    expect(overridden).toEqual([])
  })
  it('draws the panels as cards of the artifact: surface, radius 20, the card shadow of the theme, no frame', () => {
    for (const [sheet, selector] of [[spending, '.spending-panel'], [receipts, '.stats-panel']] as const) {
      const body = rule(sheet, selector)
      expect(body, selector).toContain('border-radius: var(--ck-radius)')
      expect(body, selector).toContain('background: var(--ck-surface)')
      expect(body, selector).toContain('box-shadow: var(--ck-card-shadow)')
      expect(declares(body, 'border'), selector).toBe(false)
    }
  })
  it('sets every text size from the scale of the theme', () => {
    for (const text of [spending, receipts, bar]) {
      for (const [, size] of text.matchAll(/font-size:\s*([^;]+);/g)) expect(size).toMatch(/^var\(--ck-text-(xs|sm|base|lg|xl|hero)\)$/)
    }
  })
  it('gives the text column of a table a least width, so whole values do not squeeze it to letters', () => {
    for (const selector of ['.stats-effects-table tbody th', '.stats-effects-table tfoot th', '.stats-products-table tbody th']) {
      expect(declares(rule(receipts, selector), 'min-width'), selector).toBe(true)
    }
    // The table itself has no fixed width: it is as wide as its columns and scrolls only when the frame is narrower.
    expect(declares(rule(receipts, '.stats-products-table'), 'min-width')).toBe(false)
    expect(compare).toContain('<table className="stats-table stats-effects-table">')
    expect(compare).toContain('<table className="stats-table stats-products-table">')
  })
  it('keeps the product name in sight on a phone while the numbers scroll inside the frame', () => {
    const phone = narrow(receipts)
    const sticky = phone.filter((item) => /position:\s*sticky/.test(item.body))
    expect(sticky.map((item) => item.selector)).toEqual(['.stats-products-table tbody th', '.stats-products-table thead th:first-child'])
    for (const item of sticky) {
      expect(item.body, item.selector).toMatch(/(^|[;\s])left:\s*0\b/)
      // Opaque, from the theme: the numbers pass under the name.
      expect(item.body, item.selector).toMatch(/background:\s*var\(--ck-[\w-]+\)/)
    }
    // Sticky only where the table scrolls: outside a narrow screen the rule is absent.
    expect(receipts.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, '')).not.toContain('sticky')
  })
  it('leaves the share column out of the terms table only on a phone', () => {
    const hidden = (list: Rule[]) => list.filter((item) => /display:\s*none/.test(item.body)).map((item) => item.selector)
    expect(hidden(narrow(receipts))).toEqual(['.stats-effects-table .stats-effect-share'])
    expect(hidden(rules(receipts))).toEqual(['.stats-effects-table .stats-effect-share'])
    expect(rule(receipts, '.stats-number-note')).toContain('display: block')
  })
  it('scrolls sideways only inside a named, focusable frame', () => {
    const scrolling = [spending, receipts].flatMap(rules).filter((item) => /overflow-x:\s*auto/.test(item.body)).map((item) => item.selector)
    expect(scrolling).toEqual(['.stats-table-scroll'])
    const frames = compare.match(/<div className="stats-table-scroll"[^>]*>/g) ?? []
    expect(frames).toHaveLength(2)
    for (const frame of frames) expect(frame).toBe('<div className="stats-table-scroll" role="region" aria-labelledby={id} tabIndex={0}>')
  })
  it('takes every colour from the theme tokens', () => {
    for (const text of [spending, receipts, bar]) expect(text).not.toMatch(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/)
  })
  it('keeps the top of a tab low and whole: one phone threshold, words never cut (feature/stats-compact)', () => {
    for (const [, width] of bar.matchAll(/@media \(max-width: (\d+)px\)/g)) expect(width).toBe('540')
    expect(bar).not.toMatch(/text-overflow|-webkit-line-clamp/)
    expect(rule(bar, '.stats-segment')).toContain('white-space: nowrap')
    expect(rule(bar, '.stats-segment')).toContain('flex: 1 1 auto')
    expect(rule(bar, '.stats-period-open')).toContain('min-height: 40px')
    // The period button wraps its words rather than cutting them: no single line is forced on it.
    expect(rule(bar, '.stats-period-open')).not.toContain('nowrap')
  })
})
