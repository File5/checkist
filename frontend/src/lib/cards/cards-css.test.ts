import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = read('./Cards.css').replace(/\/\*[\s\S]*?\*\//g, '')
const tokens = read('../../theme/tokens.css')
const source = read('./RecordCards.tsx')

const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim(), body: match[2].trim() })))
const rule = (selector: string) => rules(css).filter((item) => item.selector === selector).map((item) => item.body).join(' ')
const declares = (body: string, property: string) => new RegExp(`(^|[;\\s])${property}\\s*:`).test(body)

describe('card stylesheet guards (text of the rules, not rendering)', () => {
  it('is imported by the component', () => {
    expect(source).toContain("import './Cards.css'")
  })

  it('takes colours from the theme tokens only', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl|hwb|lab|lch|oklab|oklch)a?\(/i)
    const defined = new Set([...tokens.matchAll(/^\s*(--ck-[a-z0-9-]+):/gm)].map((match) => match[1]))
    const used = [...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1])
    expect(used.length).toBeGreaterThan(0)
    expect([...new Set(used.filter((name) => !defined.has(name)))]).toEqual([])
  })

  it('has no width media query, text size, reordering, !important or motion', () => {
    expect(css).not.toContain('@media')
    for (const item of rules(css)) {
      for (const property of ['font-size', 'font', 'order', 'transition', 'animation']) expect(declares(item.body, property), `${item.selector} ${property}`).toBe(false)
    }
    expect(css).not.toContain('!important')
    expect(css).not.toContain('@keyframes')
  })

  it('names only the classes of the contract and sets no state rule', () => {
    const classes = [...new Set([...css.matchAll(/\.(ck-[a-z-]+)/g)].map((match) => match[1]))].sort()
    expect(classes).toEqual(['ck-card', 'ck-card-fact', 'ck-card-facts', 'ck-card-footer', 'ck-card-title', 'ck-cards', 'ck-cards-caption', 'ck-cards-list'])
    for (const name of classes) expect(source, name).toContain(`className="${name}"`)
    expect(rules(css).filter((item) => /:(hover|active|focus|focus-visible|focus-within)\b/.test(item.selector)).map((item) => item.selector)).toEqual([])
  })

  it('keeps a value in one piece, right-aligned, with tabular digits', () => {
    const value = rule('.ck-card-fact[data-kind="value"] dd')
    expect(value).toContain('white-space: nowrap;')
    expect(value).toContain('font-variant-numeric: tabular-nums;')
    expect(value).toContain('text-align: right;')
    // On a line of its own the value still stands at the right edge.
    expect(value).toContain('margin-left: auto;')
    // Nothing takes the nowrap back.
    expect(rules(css).filter((item) => /white-space\s*:\s*(?!nowrap|\s)/.test(item.body)).map((item) => item.selector)).toEqual([])
  })

  it('lets a value that does not fit beside its label go under it as a whole', () => {
    const fact = rule('.ck-card-fact')
    expect(fact).toContain('display: flex;')
    expect(fact).toContain('flex-wrap: wrap;')
    expect(fact).toContain('justify-content: space-between;')
  })

  it('wraps free text by words and gives a block the whole width under its label', () => {
    expect(rule('.ck-card-fact[data-kind="text"] dd')).toBe('overflow-wrap: break-word;')
    expect(rule('.ck-card-fact[data-kind="text"] dd')).not.toContain('nowrap')
    expect(rule('.ck-card-fact[data-kind="block"]')).toContain('display: grid;')
    expect(rule('.ck-card-title')).toContain('overflow-wrap: break-word;')
  })

  it('highlights the card a link points at and the total card', () => {
    expect(rule('.ck-card:target')).toBe('background: var(--ck-accent-bg);')
    const order = rules(css).map((item) => item.selector)
    expect(order.indexOf('.ck-card')).toBeLessThan(order.indexOf('.ck-card:target'))
    expect(rule('.ck-card[data-tone="total"] .ck-card-fact dd')).toBe('font-weight: 700;')
  })

  it('resets the list and lets every level shrink inside the page', () => {
    const list = rule('.ck-cards-list')
    expect(list).toContain('list-style: none;')
    expect(list).toContain('padding: 0;')
    for (const selector of ['.ck-cards', '.ck-cards-list', '.ck-card', '.ck-card-facts', '.ck-card-fact', '.ck-card-fact dd']) {
      expect(rule(selector), selector).toContain('min-width: 0;')
    }
    for (const item of rules(css)) expect(declares(item.body, 'overflow') || declares(item.body, 'overflow-x'), item.selector).toBe(false)
  })
})

/** Whatever stands inside :where() weighs nothing. */
const weightless = (selector: string) => /^:where\(.*\)$/.test(selector) && !selector.slice(7, -1).includes(':where(')

describe('card stylesheet guards: the heading, links and text facts', () => {
  it('highlights the main line of the heading and leaves what follows it plain', () => {
    expect(rule('.ck-card-title')).toContain('font-weight: 600;')
    const plain = ':where(.ck-card-title > :not(:first-child))'
    expect(rule(plain)).toBe('font-weight: 400;')
    // Weighs nothing: `.receipt-printed-name` and `.stats-effect-title` keep the weight of their own class.
    expect(weightless(plain)).toBe(true)
    // No other rule of the contract touches the weight inside the heading.
    const weights = rules(css).filter((item) => declares(item.body, 'font-weight')).map((item) => item.selector)
    expect(weights).toEqual(['.ck-card-title', plain, '.ck-card[data-tone="total"] .ck-card-fact dd'])
  })

  it('relies on the screen classes that mark the main line of a heading that starts with a note', () => {
    const screen = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, '')
    const own = (text: string, selector: string) => rules(text).filter((item) => item.selector === selector).map((item) => item.body).join(' ')
    expect(own(screen('../../features/receipts/Receipts.css'), '.receipt-printed-name')).toContain('font-weight: 650;')
    expect(own(screen('../../features/stats/ReceiptsStats.css'), '.stats-effect-title')).toBe('font-weight: 600;')
  })

  it('paints a link of the heading and of a fact as a link, not as the text around it', () => {
    // App.css says `a { color: inherit; }`: a class in the selector outweighs it wherever the file stands in the build.
    for (const selector of ['.ck-card-title a', '.ck-card-fact a']) {
      expect(rule(selector), selector).toBe('color: var(--ck-link); text-underline-offset: 3px;')
    }
    // The footer holds buttons and action links with the colours of their own classes.
    expect(rules(css).filter((item) => item.selector.includes('.ck-card-footer') && declares(item.body, 'color')).map((item) => item.selector)).toEqual([])
  })

  it('gives a link of the heading and of a value the touch target of the table links, without outweighing a screen class', () => {
    const targets = [':where(.ck-card-title > a)', ':where(.ck-card-fact[data-kind="value"] dd a)']
    for (const selector of targets) {
      expect(rule(selector), selector).toBe('display: inline-block; min-height: 44px; padding-block: 10px;')
      expect(weightless(selector), selector).toBe(true)
    }
    // Only a direct child of the heading and a link of an unbreakable value: a link inside running text stays inline.
    expect(rules(css).filter((item) => declares(item.body, 'min-height')).map((item) => item.selector)).toEqual(targets)
  })

  it('puts a text fact at the right edge like a value and still wraps it by words', () => {
    const inline = rule('.ck-card-fact:not([data-kind="block"]) dd')
    expect(inline).toBe('margin-left: auto; text-align: right;')
    const text = [rule('.ck-card-fact[data-kind="text"] dd'), inline, rule('.ck-card-fact dd')].join(' ')
    expect(text).toContain('overflow-wrap: break-word;')
    expect(text).toContain('min-width: 0;')
    expect(declares(text, 'white-space')).toBe(false)
    // A block keeps the whole width under its label, aligned as the text of the page.
    const block = [rule('.ck-card-fact[data-kind="block"]'), rule('.ck-card-fact[data-kind="block"] dd')].join(' ')
    expect(declares(block, 'text-align') || declares(block, 'margin-left')).toBe(false)
  })
})
