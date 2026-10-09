import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const catalog = read('./Catalog.css')
const app = read('../../App.css')

/** Flat rules: a media block of this stylesheet holds whole rules. */
const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim(), body: match[2].trim() })))
const rule = (selector: string, text: string) => rules(text).filter((item) => item.selector === selector).map((item) => item.body).join(' ')
const value = (body: string, property: string) => new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim()

/** Text of the narrow-screen block; the rest of the stylesheet is everything before it. */
const narrowStart = catalog.indexOf('@media (max-width: 540px)')
const base = catalog.slice(0, narrowStart)
const narrow = catalog.slice(catalog.indexOf('{', narrowStart) + 1)

/** Classes whose content is one value: a price, a quantity, a counter with its word. */
const values = ['.ck-catalog-price', '.ck-catalog-value', '.ck-catalog-count']

describe('catalog stylesheet guards (text of the rules, not rendering)', () => {
  it('has one narrow-screen block, at the end of the stylesheet', () => {
    expect(narrowStart).toBeGreaterThan(0)
    expect(catalog.match(/@media/g)).toHaveLength(1)
  })

  it('never breaks a value inside', () => {
    for (const selector of values) expect(value(rule(selector, base), 'white-space'), selector).toBe('nowrap')
  })

  it('leaves dates to the weightless rule of the shell and does not undo it', () => {
    expect(rule(':where(time)', app)).toBe('white-space: nowrap;')
    expect(rules(catalog).filter((item) => /(^|[\s>+~])time(?![\w-])/.test(item.selector))).toEqual([])
  })

  it('does not give the values back to wrapping, on a narrow screen or anywhere else', () => {
    expect(rules(narrow).filter((item) => /white-space|overflow-wrap|word-break/.test(item.body))).toEqual([])
    expect(rules(catalog).filter((item) => value(item.body, 'white-space') === 'normal')).toEqual([])
  })

  it('gives the price column of a product card at least the width of its unbreakable content', () => {
    expect(value(rule('.ck-catalog-product', base), 'grid-template-columns')).toBe('minmax(0, 1.6fr) minmax(min-content, 1fr)')
  })

  it('keeps a metadata label whole words: the column is not narrower than its longest word', () => {
    expect(value(rule('.ck-catalog-metadata > div', base), 'grid-template-columns')).toMatch(/^minmax\(min-content, 1fr\) /)
    expect(value(rule('.ck-catalog-metadata dt', base), 'overflow-wrap')).toBe('normal')
  })

  it('keeps free text wrapping, so that a long name never scrolls the page', () => {
    expect(value(rule('.ck-catalog', base), 'overflow-wrap')).toBe('anywhere')
    expect(rules(catalog).filter((item) => /overflow(-x)?\s*:/.test(item.body))).toEqual([])
  })

  it('takes every colour from the theme tokens', () => {
    expect(catalog).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
  })
})
