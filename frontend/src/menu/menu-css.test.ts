import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = new URL('../', import.meta.url)
const raw = (path: string) => readFileSync(new URL(path, source), 'utf8')
const app = raw('App.css').replace(/\/\*[\s\S]*?\*\//g, '')
const tokens = raw('theme/tokens.css')
const html = raw('../index.html')

const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim(), body: match[2].trim() })))
const rule = (selector: string, text: string) => rules(text).filter((item) => item.selector === selector).map((item) => item.body).join(' ')

const phone = '@media (max-width: 540px) {'
const query = '@media (max-width: 540px) and (min-width: 300px) and (min-height: 480px) {'
const bar = app.slice(app.indexOf(query) + query.length).split('\n}')[0]
/** Everything but the block of the bar. */
const rest = app.replace(bar, '')
const nav = rule('.brand-bar .main-navigation', bar)
const list = rule('.brand-bar .main-more[data-open] .main-more-list', bar)

describe('bottom bar of the main menu on a phone (text of the rules, not rendering)', () => {
  it('lives in one block of its own, after the phone block that the other guards pin', () => {
    expect(app.split(query)).toHaveLength(2)
    expect(app.indexOf(phone)).toBeGreaterThan(0)
    expect(app.indexOf(query)).toBeGreaterThan(app.indexOf(phone))
    // One threshold of the phone; the other two conditions leave a tiny or a low window with the row in the header.
    expect([...app.matchAll(/@media ([^{]+)\{/g)].map((match) => match[1].trim())).toEqual([
      '(max-width: 540px)', '(max-width: 540px) and (min-width: 300px) and (min-height: 480px)', '(forced-colors: active)',
    ])
    expect(nav).not.toBe('')
  })

  it('pins the same nav of the header to the bottom of the window, in the colours of the header', () => {
    expect(nav).toContain('position: fixed;')
    expect(nav).toContain('inset: auto 0 0;')
    expect(nav).toContain('z-index: var(--ck-z-bottom-nav);')
    expect(nav).toContain('background: var(--ck-header-bg);')
    expect(nav).toContain('color: var(--ck-header-text);')
    // The list behind «Ещё» is drawn outside of the bar: the scroller of the header row would cut it.
    expect(nav).toContain('overflow: visible;')
    expect(rest).not.toMatch(/position: fixed/)
  })

  it('tells the height of the bar to the pinned action bars through the contract of the layout tokens', () => {
    expect(rule(':root', bar)).toBe('--ck-bottom-nav-height: 3.5rem;')
    expect(rest).not.toContain('--ck-bottom-nav-height:')
    expect(nav).toContain('min-height: calc(var(--ck-bottom-nav-height) + var(--ck-safe-bottom));')
    expect(nav).toContain('padding-bottom: var(--ck-safe-bottom);')
    expect(rule('.page', bar)).toMatch(/^padding: 0 \S+ env\(safe-area-inset-right, 0px\)\) var\(--ck-bottom-occupied\) /)
    // The only scroll padding of the project is in ActionBar.css.
    expect(app).not.toContain('scroll-padding')
  })

  it('orders the layers: the list over the bar, the skip link over everything', () => {
    expect(list).toContain('z-index: var(--ck-z-menu-sheet);')
    expect(rule('.skip-link', rest)).toContain('z-index: var(--ck-z-skip-link);')
    expect([...app.matchAll(/z-index: ([^;]+);/g)].map((match) => match[1]).sort()).toEqual(
      ['var(--ck-z-bottom-nav)', 'var(--ck-z-menu-sheet)', 'var(--ck-z-skip-link)'])
  })

  it('reads only tokens that the theme defines and writes no colour', () => {
    const defined = new Set([...tokens.matchAll(/^\s*(--ck-[a-z0-9-]+):/gm)].map((match) => match[1]))
    const used = [...new Set([...bar.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]))]
    expect(used).toEqual(expect.arrayContaining(['--ck-bottom-nav-height', '--ck-safe-bottom', '--ck-bottom-occupied', '--ck-z-bottom-nav', '--ck-z-menu-sheet', '--ck-header-bg']))
    expect(used.filter((name) => !defined.has(name))).toEqual([])
    expect(bar).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i)
  })

  it('reaches under the cut-out of a phone only together with the side insets', () => {
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />')
    for (const selector of ['.brand-bar', '.page', '.brand-bar .main-navigation']) {
      expect(rule(selector, bar), selector).toContain('env(safe-area-inset-left, 0px)')
      expect(rule(selector, bar), selector).toContain('env(safe-area-inset-right, 0px)')
    }
    // Never less than the 20 px of the phone block above.
    expect(rule('.brand-bar', bar)).toBe('padding-inline: max(20px, env(safe-area-inset-left, 0px)) max(20px, env(safe-area-inset-right, 0px));')
    // Outside of the block (a phone on its side, a wide window) the whole body steps aside; the block takes it over.
    expect(rule('body', rest)).toContain('padding-inline: env(safe-area-inset-left, 0px) env(safe-area-inset-right, 0px);')
    expect(rule('body', bar)).toBe('padding-inline: 0;')
  })

  it('shows the list behind «Ещё» only while open, at once', () => {
    expect(rule('.brand-bar .main-more-list', bar)).toBe('display: none;')
    expect(list).toContain('display: flex;')
    expect(list).toContain('position: absolute;')
    expect(list).toContain('bottom: 100%;')
    expect(app).not.toMatch(/transition|animation|@keyframes/)
  })

  it('draws no «Ещё» wherever the menu is a row: the links behind it stand in the row', () => {
    expect(rule('.main-more', rest)).toBe('display: contents;')
    expect(rule('.main-more-list', rest)).toBe('display: contents;')
    expect(rule('.main-more-toggle', rest)).toBe('display: none;')
    expect(rule('.brand-bar .main-more-toggle', bar)).toContain('display: inline-flex;')
  })

  it('marks the current section of the bar, and «Ещё» with it, not by colour alone', () => {
    const mark = 'box-shadow: inset 0 3px 0 var(--ck-header-accent);'
    expect(rule('.brand-bar .main-navigation > a[aria-current]', bar)).toBe(mark)
    expect(rule('.brand-bar .main-more-toggle[data-current]', bar)).toContain(mark)
    expect(rule('.brand-bar .main-more-toggle[data-current]', bar)).toContain('font-weight: 600;')
    expect(rule('.main-navigation a[aria-current]', rest)).toContain('font-weight: 600;')
    // The star gives way to the line only for the links of the bar itself: the list behind «Ещё» keeps it.
    expect(rules(bar).filter((item) => item.selector.includes('::before')).map((item) => item.selector)).toEqual(['.brand-bar .main-navigation > a[aria-current]::before'])
    const forced = app.slice(app.indexOf('@media (forced-colors: active)'))
    expect(rule('.main-more-toggle[data-current]', forced)).toContain('text-decoration: underline;')
  })

  it('makes no text smaller and leaves the menu of a section inside the page alone', () => {
    expect(bar).not.toMatch(/font-size|font:/)
    expect(rules(app).filter((item) => /section-navigation/.test(item.selector)).map((item) => `${item.selector} { ${item.body} }`)).toEqual(['.section-navigation { margin-bottom: 20px; }'])
    // Every rule of the bar about the menu is tied to the header: the menu of a section is a .main-navigation too.
    const loose = rules(bar).map((item) => item.selector).filter((selector) => /main-(navigation|more)/.test(selector) && !selector.startsWith('.brand-bar '))
    expect(loose).toEqual([])
  })
})
