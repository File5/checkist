import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = new URL('../', import.meta.url)
const raw = (path: string) => readFileSync(new URL(path, source), 'utf8')
const read = (path: string) => raw(path).replace(/\/\*[\s\S]*?\*\//g, '')
const app = read('App.css')
const tokens = raw('theme/tokens.css')

/** Flat rules: a media block of these stylesheets holds whole rules. */
const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim(), body: match[2].trim() })))
const rule = (selector: string, text: string) => rules(text).filter((item) => item.selector === selector).map((item) => item.body).join(' ')

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

const files = (readdirSync(source, { recursive: true }) as string[]).map((path) => path.replaceAll('\\', '/'))
/** A colour written as a value; color-mix() over tokens is not one. */
const colour = /#[0-9a-f]{3,8}\b|\b(?:rgb|hsl|hwb|lab|lch|oklab|oklch)a?\(/i

describe('colours live in the theme tokens only (text of the files, not rendering)', () => {
  it('writes no colour in a stylesheet other than tokens.css', () => {
    // Static snapshots in preview/ keep the former green design and are not a part of the client.
    const sheets = files.filter((path) => path.endsWith('.css') && path !== 'theme/tokens.css' && !/(^|[/-])preview\//.test(path))
    expect(sheets).toContain('App.css')
    const own = sheets.filter((path) => colour.test(read(path)))
    // features/auth/Auth.css came from main in the former palette; its move to the tokens is a task of its own.
    expect(own.filter((path) => path !== 'features/auth/Auth.css')).toEqual([])
  })

  it('reads only tokens that the theme defines', () => {
    const defined = new Set([...tokens.matchAll(/^\s*(--ck-[a-z0-9-]+):/gm)].map((match) => match[1]))
    const used = [...app.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1])
    expect(used.length).toBeGreaterThan(0)
    expect([...new Set(used.filter((name) => !defined.has(name)))]).toEqual([])
  })
})

describe('account link of the header (text of the rules, not rendering)', () => {
  it('takes its text from the header tokens and sets no state of its own', () => {
    const own = rules(app).filter((item) => /\.account-link(?![\w-])/.test(item.selector))
    expect(own.map((item) => item.selector)).toEqual(['.account-link', '.brand-bar .account-link'])
    expect(rule('.account-link', app)).toBe('max-width: 100%; font-weight: 600; overflow-wrap: anywhere;')
    expect(rule('.brand-bar .account-link', app)).toBe('color: var(--ck-header-text);')
    expect(rule('.brand-bar', app)).toContain('color: var(--ck-header-text);')
  })

  it('yields to the hover, the current page and the focus ring of the header links', () => {
    // The link is an `a` of the header navigation: these rules reach it and must weigh more than its own colour.
    const base = weight('.brand-bar .account-link')
    expect(rule('.brand-bar .main-navigation a:hover', app)).toBe('background: var(--ck-header-hover-bg); text-decoration: underline;')
    expect(rule('.brand-bar .main-navigation a[aria-current]', app)).toBe('color: var(--ck-header-accent); background: var(--ck-header-hover-bg);')
    expect(rule('.brand-bar :focus-visible', app)).toBe('outline-color: var(--ck-header-focus);')
    expect(weight('.brand-bar .main-navigation a[aria-current]')).toBeGreaterThan(base)
    expect(weight('.brand-bar .main-navigation a:hover')).toBeGreaterThan(base)
  })
})

describe('state rules of the shell (text of the rules, not rendering)', () => {
  const state = /:(hover|active|focus|focus-visible|focus-within|disabled|checked|visited)(?![\w-])|\[aria-(disabled|invalid|pressed|expanded|busy)/

  it('keeps every general state rule as weak as its base rule', () => {
    // App.css follows the screen stylesheets in the build: a general state rule that weighs as much as a class of a
    // screen wins over it. A new one goes through :where() and into this list; the header and the skip link are the
    // shell's own parts, and the disabled button must win over the fill that a class of a screen sets.
    const found = rules(app).filter((item) => state.test(item.selector)).map((item) => `${item.selector} = ${weight(item.selector)}`)
    expect(found).toEqual([
      'button:focus-visible = 1', 'a:focus-visible = 1', 'input:focus-visible = 1', 'select:focus-visible = 1', '[tabindex]:focus-visible = 2',
      '.skip-link:focus = 2', '.skip-link:focus-visible = 2', '.brand-bar :focus-visible = 2',
      '.brand-actions a:hover = 2', '.brand-bar .main-navigation a:hover = 3',
      'button:where(:hover:not(:disabled)) = 0', 'button:where(:active:not(:disabled)) = 0', 'button:disabled = 1',
      '.action-link:where(:hover) = 1', '.rec-issues summary:focus-visible = 2',
    ])
  })

  it('sets only the outline in the general focus rule', () => {
    expect(rule('button:focus-visible', app)).toBe('outline: 3px solid var(--ck-focus); outline-offset: 4px;')
  })
})

describe('name of the product in the page and the theme file', () => {
  it('is written in Russian', () => {
    const html = raw('../index.html')
    expect(html).not.toContain('Checkist')
    expect(html).toMatch(/<meta name="description" content="Чекист — [^"]+" \/>/)
    expect(html).toContain('<title>Чекист</title>')
  })

  it('does not promise a look of dangerous actions that no button has', () => {
    const comment = tokens.slice(0, tokens.indexOf('СПРАВОЧНИК ТОКЕНОВ'))
    expect(comment).not.toMatch(/Опасное действие[^.]*тройка\s+ошибки/)
    expect(comment).toContain('решение за человеком')
  })
})
