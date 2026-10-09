import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, source), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const app = read('App.css')
const receipts = read('features/receipts/Receipts.css')

/** Flat rules: a media block of these stylesheets holds whole rules. */
const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim(), body: match[2].trim() })))
const rule = (selector: string, text: string) => rules(text).filter((item) => item.selector === selector).map((item) => item.body).join(' ')
const declares = (body: string, property: string) => new RegExp(`(^|[;\\s])${property}\\s*:`).test(body)

/** Classes, attributes and pseudo-classes of a selector; whatever stands inside :where() weighs nothing. */
const weight = (selector: string) => {
  let text = selector
  for (let start = text.indexOf(':where('); start >= 0; start = text.indexOf(':where(')) {
    let end = start + 7
    for (let depth = 1; depth > 0 && end < text.length; end += 1) depth += text[end] === '(' ? 1 : text[end] === ')' ? -1 : 0
    text = text.slice(0, start) + text.slice(end)
  }
  return (text.replace(/::[\w-]+/g, '').replace(/:not\(|\)/g, ' ').match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length
}

/** Screen stylesheets: the build puts every one of them BEFORE App.css (main.tsx imports App first). */
const screens = (readdirSync(new URL('.', source), { recursive: true }) as string[])
  .map((path) => path.replaceAll('\\', '/'))
  .filter((path) => path.endsWith('.css') && path !== 'App.css' && path !== 'theme/tokens.css' && !path.includes('/preview/'))

describe('filled action link guards (text of the rules, not rendering)', () => {
  it('weighs every .action-link rule of the shell no more than the class itself', () => {
    // An equal weight would win over `.action-link.<modifier>` of a screen by the order of the build.
    const shell = rules(app).filter((item) => /^\.action-link(?![\w-])/.test(item.selector))
    expect(shell.map((item) => item.selector)).toEqual(['.action-link', '.action-link:where(:hover)'])
    for (const item of shell) expect(weight(item.selector), item.selector).toBe(1)
    expect(rule('.action-link:where(:hover)', app)).toBe('border-color: var(--ck-link-hover); color: var(--ck-link-hover);')
  })

  it('keeps the text of the filled link over the brand fill while hovered and pressed', () => {
    expect(rule('.action-link.receipt-primary', receipts)).toBe('background: var(--ck-brand); border-color: var(--ck-brand); color: var(--ck-on-brand);')
    expect(rule('.action-link.receipt-primary:hover', receipts))
      .toBe('background: var(--ck-brand-hover); border-color: var(--ck-brand-hover); color: var(--ck-on-brand);')
    expect(rule('.action-link.receipt-primary:active', receipts))
      .toBe('background: var(--ck-brand-active); border-color: var(--ck-brand-active); color: var(--ck-on-brand);')
    const order = rules(receipts).map((item) => item.selector)
    expect(order.indexOf('.action-link.receipt-primary:hover')).toBeLessThan(order.indexOf('.action-link.receipt-primary:active'))
  })

  it('outweighs the hover of the shell in every modifier of .action-link that sets a colour', () => {
    const hover = weight('.action-link:where(:hover)')
    const modifiers = screens.flatMap((path) => rules(read(path)).map((item) => ({ ...item, path })))
      .filter((item) => /^\.action-link\.[\w-]+/.test(item.selector) && (declares(item.body, 'color') || declares(item.body, 'border-color')))
    expect(modifiers.map((item) => `${item.path} ${item.selector}`)).toEqual([
      'features/receipts/Receipts.css .action-link.receipt-primary',
      'features/receipts/Receipts.css .action-link.receipt-primary:hover',
      'features/receipts/Receipts.css .action-link.receipt-primary:active',
    ])
    for (const item of modifiers) expect(weight(item.selector), item.selector).toBeGreaterThan(hover)
  })

  it('keeps the shared state rules of the shell that set a colour as weak as their base rule', () => {
    // Hover, press and focus of the shell must not repaint the text or the border of a screen element that is as specific.
    const states = rules(app).filter((item) => /:(hover|active|focus-visible)/.test(item.selector) && (declares(item.body, 'color') || declares(item.body, 'border-color')))
    expect(states.map((item) => item.selector)).toEqual([
      'button:where(:hover:not(:disabled))', 'button:where(:active:not(:disabled))', '.action-link:where(:hover)',
    ])
    expect(states.map((item) => weight(item.selector))).toEqual([0, 0, 1])
  })
})

/** Rules that stand inside `@media (max-width: …)` blocks, with the width of their block. */
const media = /@media\s*\(max-width:\s*(\d+)px\)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g
const narrow = [...receipts.matchAll(media)].flatMap((match) => rules(match[2]).map((item) => ({ ...item, width: Number(match[1]) })))
const outside = receipts.replace(media, '')
const value = (body: string, property: string) => new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim()

describe('whole values and the lines table (text of the rules, not rendering)', () => {
  it('never wraps a number, a sum or a total', () => {
    for (const selector of ['.receipt-number', '.receipt-total']) expect(value(rule(selector, outside), 'white-space'), selector).toBe('nowrap')
  })

  it('does not give the wrap back on a narrow screen', () => {
    expect(outside).not.toContain('@media')
    expect(narrow.map((item) => item.width)).toContain(540)
    const touched = narrow.filter((item) => ['white-space', 'overflow-wrap', 'word-break'].some((property) => declares(item.body, property)))
    expect(touched.map((item) => `${item.width} ${item.selector}`)).toEqual([])
  })

  it('does not make any text of the screen smaller on a narrow screen', () => {
    expect(narrow.filter((item) => declares(item.body, 'font-size') || declares(item.body, 'font')).map((item) => item.selector)).toEqual([])
  })

  it('keeps the name column of the lines table wide enough to wrap by words', () => {
    const name = rule('.receipt-lines-table th[scope="row"]', outside)
    const width = /^(\d+)px$/.exec(value(name, 'min-width') ?? '')
    expect(width, name).not.toBeNull()
    expect(Number(width![1])).toBeGreaterThanOrEqual(160)
    expect(Number(width![1])).toBeLessThanOrEqual(220)
    expect(declares(name, 'white-space')).toBe(false)
    // The headings of the number columns stay whole too; the heading of the name column wraps with its column.
    expect(value(rule('.receipt-lines-table thead th + th', outside), 'white-space')).toBe('nowrap')
  })

  it('takes the width of the table from its columns, not from a fixed number', () => {
    const table = rule('.receipt-lines-table', receipts)
    expect(value(table, 'width')).toBe('100%')
    expect(declares(table, 'min-width')).toBe(false)
    const resized = narrow.filter((item) => item.selector.startsWith('.receipt-lines-table') && (declares(item.body, 'min-width') || declares(item.body, 'width')))
    expect(resized.map((item) => item.selector)).toEqual([])
  })

  it('scrolls the table inside its own frame only', () => {
    const frame = rule('.receipt-table-scroll', outside)
    expect(value(frame, 'overflow-x')).toBe('auto')
    expect(value(frame, 'max-width')).toBe('100%')
    expect(value(rule('.receipt-panel', outside), 'min-width')).toBe('0')
  })

  it('pins the name column on the left with a token background wherever the table can scroll', () => {
    const pinned = narrow.filter((item) => item.selector.startsWith('.receipt-lines-table'))
    const sticky = pinned.filter((item) => value(item.body, 'position') === 'sticky')
    expect(sticky.map((item) => item.selector)).toEqual(['.receipt-lines-table th:first-child'])
    expect(value(sticky[0].body, 'left')).toBe('0')
    // Wider than the phone breakpoint: a tablet scrolls the table as well.
    expect(sticky[0].width).toBeGreaterThan(540)
    const backgrounds = pinned.filter((item) => declares(item.body, 'background'))
    expect(backgrounds.map((item) => item.selector)).toEqual([
      '.receipt-lines-table thead th:first-child', '.receipt-lines-table th[scope="row"]', '.receipt-lines-table tr:target > th[scope="row"]',
    ])
    for (const item of backgrounds) {
      expect(item.width, item.selector).toBe(sticky[0].width)
      expect(value(item.body, 'background'), item.selector).toMatch(/^var\(--ck-[\w-]+\)$/)
    }
    // Collapsed borders would stay behind while the pinned cell moves.
    expect(value(rule('.receipt-lines-table', outside), 'border-collapse')).toBe('separate')
    expect(value(rule('.receipt-lines-table', outside), 'border-spacing')).toBe('0')
  })

  it('lets the facts of a list card take as many columns as fit', () => {
    expect(value(rule('.receipt-list-content .receipt-facts', outside), 'grid-template-columns')).toBe('repeat(auto-fit, minmax(min(100%, 180px), 1fr))')
    // The narrow rule of the plain .receipt-facts weighs less and does not bring the fixed columns back.
    expect(narrow.filter((item) => item.selector.includes('.receipt-list-content')).map((item) => item.selector)).toEqual([])
  })

  it('writes no colour of its own', () => {
    expect(receipts).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i)
  })
})
