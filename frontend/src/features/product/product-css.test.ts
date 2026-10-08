import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const product = read('./Product.css')
const app = read('../../App.css')

/** Flat rules: a media block of this stylesheet holds whole rules. */
const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim(), body: match[2].trim() })))
const rule = (selector: string, text: string) => rules(text).filter((item) => item.selector === selector).map((item) => item.body).join(' ')
const value = (body: string, property: string) => new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim()

/** Text of the narrow-screen block; the rest of the stylesheet is everything before it. */
const narrowStart = product.indexOf('@media (max-width: 540px)')
const base = product.slice(0, narrowStart)
const narrow = product.slice(product.indexOf('{', narrowStart) + 1)

/** Classes whose content is one value: a price, a count, a percent, a quantity, «Чек №N». */
const values = ['.product-number', '.product-table .product-number', '.product-value', '.product-table a']

describe('product stylesheet guards (text of the rules, not rendering)', () => {
  it('has one narrow-screen block, at the end of the stylesheet', () => {
    expect(narrowStart).toBeGreaterThan(0)
    expect(product.match(/@media/g)).toHaveLength(1)
  })

  it('never breaks a value inside', () => {
    for (const selector of values) expect(value(rule(selector, base), 'white-space'), selector).toBe('nowrap')
  })

  it('leaves dates to the weightless rule of the shell and does not undo it', () => {
    expect(rule(':where(time)', app)).toBe('white-space: nowrap;')
    expect(rules(product).filter((item) => /(^|[\s>+~])time(?![\w-])/.test(item.selector))).toEqual([])
  })

  it('does not give the values back to wrapping on a narrow screen', () => {
    expect(rules(narrow).filter((item) => /white-space|overflow-wrap|word-break/.test(item.body))).toEqual([])
  })

  it('lets only words wrap inside a numeric cell: the note under a value and the column headings', () => {
    const wrapping = rules(base).filter((item) => value(item.body, 'white-space') === 'normal').map((item) => item.selector)
    expect(wrapping.sort()).toEqual(['.product-cell-text', '.product-table thead .product-number'])
    const note = rule('.product-cell-text', base)
    expect(value(note, 'display')).toBe('block')
    expect(value(note, 'max-width')).toMatch(/^\d+(\.\d+)?rem$/)
    // Words stay whole: `anywhere` of the page would let the column squeeze them to single letters.
    expect(value(note, 'overflow-wrap')).toBe('break-word')
    expect(value(rule('.product-table thead .product-number', base), 'overflow-wrap')).toBe('normal')
  })

  it('keeps the store column readable: a minimal width and wrapping by words', () => {
    const wide = rule('.product-table tbody th', base)
    expect(Number.parseInt(value(wide, 'min-width') ?? '', 10)).toBeGreaterThanOrEqual(160)
    expect(Number.parseInt(value(wide, 'min-width') ?? '', 10)).toBeLessThanOrEqual(220)
    expect(value(wide, 'overflow-wrap')).toBe('break-word')
    expect(Number.parseInt(value(rule('.product-table tbody th', narrow), 'min-width') ?? '', 10)).toBeGreaterThanOrEqual(160)
  })

  it('does not force the table wider than its columns', () => {
    const table = rule('.product-table', base)
    expect(value(table, 'width')).toBe('100%')
    expect(value(table, 'min-width')).toBeUndefined()
    expect(value(rule('.product-table', narrow), 'min-width')).toBeUndefined()
  })

  it('scrolls the table inside its own frame only', () => {
    const scroll = rule('.product-table-scroll', base)
    expect(value(scroll, 'overflow-x')).toBe('auto')
    expect(value(scroll, 'max-width')).toBe('100%')
    expect(rules(product).filter((item) => /overflow(-x)?\s*:/.test(item.body)).map((item) => item.selector)).toEqual(['.product-table-scroll'])
  })

  it('pins the first column to the left edge over an opaque token background', () => {
    const pinned = rule('.product-table tr > :first-child', base)
    expect(value(pinned, 'position')).toBe('sticky')
    expect(value(pinned, 'left')).toBe('0')
    // A collapsed border does not travel with a sticky cell.
    expect(value(rule('.product-table', base), 'border-collapse')).toBe('separate')
    expect(value(rule('.product-table tbody tr > :first-child', base), 'background')).toMatch(/^var\(--ck-[\w-]+\)$/)
    expect(value(rule('.product-table thead th', base), 'background')).toMatch(/^var\(--ck-[\w-]+\)$/)
    expect(rules(narrow).filter((item) => /position\s*:|background\s*:/.test(item.body))).toEqual([])
  })

  it('takes every colour from the theme tokens', () => {
    expect(product).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  })
})
