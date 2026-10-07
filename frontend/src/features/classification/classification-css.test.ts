import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./Classification.css', import.meta.url), 'utf8')

/** Flat rules only: enough for this stylesheet, where a media block holds whole rules. */
const rules = (text: string) => [...text.replace(/\/\*[\s\S]*?\*\//g, '').matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .map((match) => ({ selector: match[1].trim(), body: match[2].trim() }))
const rule = (selector: string) => rules(css).filter((item) => item.selector === selector).map((item) => item.body).join(' ')
const colored = (body: string) => /(^|[;\s])color\s*:/.test(body)

describe('classification stylesheet guards (text of the rules, not rendering)', () => {
  it('draws the current filter link as the accent pair of the theme, apart from the other links', () => {
    // Accent text on the accent background is a contrast pair in both themes (tokens.css).
    const current = rule('.ck-class-filter a[aria-current]')
    expect(current).toMatch(/(^|[;\s])color: var\(--ck-accent-text\);/)
    expect(current).toMatch(/(^|[;\s])background: var\(--ck-accent-bg\);/)
    const other = rule('.ck-class-filter a')
    expect(other).toMatch(/(^|[;\s])color: var\(--ck-link\);/)
    expect(other).toMatch(/(^|[;\s])background: var\(--ck-surface\);/)
  })
  it('takes every colour from the theme tokens', () => {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '')
    expect(text.match(/#[0-9a-f]{3,8}|(?:rgb|hsl)a?\(/gi)).toBeNull()
  })
  it('keeps the general link colour of the screen away from current links', () => {
    // `.ck-class a…` is as specific as `.ck-class-filter a[aria-current]` and comes later: it must leave current links alone.
    const general = rules(css).flatMap((item) => item.selector.split(',').map((selector) => ({ selector: selector.trim(), body: item.body })))
      .filter((item) => /^\.ck-class\s+a(?![\w-])/.test(item.selector) && colored(item.body))
    expect(general.map((item) => item.selector)).toEqual(['.ck-class a:not(.action-link):not([aria-current])'])
    expect(general[0].body).toMatch(/(^|[;\s])color: var\(--ck-link\);/)
  })
})
