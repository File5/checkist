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
