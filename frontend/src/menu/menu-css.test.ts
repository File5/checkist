import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = new URL('../', import.meta.url)
const raw = (path: string) => readFileSync(new URL(path, source), 'utf8')
const app = raw('App.css').replace(/\/\*[\s\S]*?\*\//g, '')
const tokens = raw('theme/tokens.css')
const html = raw('../index.html')
const actionBar = raw('components/ActionBar.css').replace(/\/\*[\s\S]*?\*\//g, '')

const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim(), body: match[2].trim() })))
const rule = (selector: string, text: string) => rules(text).filter((item) => item.selector === selector).map((item) => item.body).join(' ')
const px = (body: string, property: string) => Number(new RegExp(`(?:^|;\\s*)${property}:\\s*(-?[\\d.]+)(px|rem)`).exec(body)?.slice(1).reduce((n, unit) => String(Number(n) * (unit === 'rem' ? 16 : 1))))

const phone = '@media (max-width: 540px) {'
const query = '@media (max-width: 540px) and (min-width: 340px) and (min-height: 480px) {'
const bar = app.slice(app.indexOf(query) + query.length).split('\n}')[0]
/** Everything but the block of the bar. */
const rest = app.replace(bar, '')
const nav = rule('.brand-bar .main-navigation', bar)
const list = rule('.brand-bar .main-more[data-open] .main-more-list', bar)

describe('bottom bar of the main menu on a phone (artifact design, text of the rules, not rendering)', () => {
  it('lives in one block of its own, after the phone block that the other guards pin', () => {
    expect(app.split(query)).toHaveLength(2)
    expect(app.indexOf(phone)).toBeGreaterThan(0)
    expect(app.indexOf(query)).toBeGreaterThan(app.indexOf(phone))
    // One threshold of the phone; the other two conditions leave a tiny or a low window with the row in the header.
    // A wide screen keeps the bar's items in the header row and the rest behind «Ещё» (a list under the button).
    expect([...app.matchAll(/@media ([^{]+)\{/g)].map((match) => match[1].trim())).toEqual([
      '(min-width: 541px)', '(max-width: 540px)', '(max-width: 540px) and (min-width: 340px) and (min-height: 480px)', '(forced-colors: active)',
    ])
    expect(nav).not.toBe('')
  })

  it('takes the header strip away: the logo and the theme switch are not drawn, the strip has no box', () => {
    expect(rule('.brand-bar', bar)).toBe('display: contents;')
    expect(rule('.brand-bar > .brand', bar)).toBe('display: none;')
    expect(rule('.brand-bar > .brand-actions', bar)).toBe('display: none;')
  })

  it('pins the same nav of the header to the bottom of the window, on the surface of the bar, five equal columns', () => {
    expect(nav).toContain('position: fixed;')
    expect(nav).toContain('inset: auto 0 0;')
    expect(nav).toContain('z-index: var(--ck-z-bottom-nav);')
    expect(nav).toContain('display: grid; grid-auto-columns: minmax(0, 1fr); grid-auto-flow: column;')
    expect(nav).toContain('border-top: 1px solid var(--ck-border);')
    expect(nav).toContain('background: var(--ck-nav-bg);')
    // The list behind «Ещё» is drawn outside of the bar: the scroller of the header row would cut it.
    expect(nav).toContain('overflow: visible;')
    expect(rest).not.toMatch(/position: fixed/)
    // The ring of the bar is the ring of the page: the bar is not dark any more.
    expect(rule('.brand-bar .main-navigation :focus-visible', bar)).toBe('outline-color: var(--ck-focus);')
  })

  it('tells the height of the bar to the pinned action bars through the contract of the layout tokens', () => {
    expect(rule(':root', bar)).toBe('--ck-bottom-nav-height: 4rem; --ck-top-bar-height: 4rem;')
    expect(rest).not.toContain('--ck-bottom-nav-height:')
    // The pinned header row: at least its height, so whatever sticks under it can count from the token.
    expect(rule('.intro', bar)).toContain('min-height: var(--ck-top-bar-height);')
    expect(nav).toContain('min-height: calc(var(--ck-bottom-nav-height) + var(--ck-safe-bottom));')
    expect(nav).toContain('padding-bottom: var(--ck-safe-bottom);')
    expect(rule('.page', bar)).toMatch(/^padding: 0 \S+ env\(safe-area-inset-right, 0px\)\) var\(--ck-bottom-occupied\) /)
    // The only scroll padding of the project is in ActionBar.css.
    expect(app).not.toContain('scroll-padding')
  })

  it('leaves a focus screen (a new spend) without the bar: nothing is occupied at the bottom, its save bar stands there', () => {
    expect(rule(':root.ck-focus-mode', bar)).toBe('--ck-bottom-nav-height: 0px;')
    expect(rule('.ck-focus-mode .brand-bar .main-navigation', bar)).toBe('display: none;')
    expect(raw('App.tsx')).toContain("document.documentElement.classList.toggle('ck-focus-mode', focus)")
  })

  it('orders the layers: the list over the bar, the skip link over everything', () => {
    expect(list).toContain('z-index: var(--ck-z-menu-sheet);')
    expect(rule('.skip-link', rest)).toContain('z-index: var(--ck-z-skip-link);')
    // «＋» opens the sheet of components/Sheet.css on its own layer above the menu; the header row lies under the bar.
    expect(rules(app).filter((item) => item.selector.includes('main-add-list')).map((item) => item.body).join(' ')).not.toContain('z-index')
    expect([...app.matchAll(/z-index: ([^;]+);/g)].map((match) => match[1]).sort()).toEqual(
      ['var(--ck-z-bottom-nav)', 'var(--ck-z-menu-sheet)', 'var(--ck-z-menu-sheet)', 'var(--ck-z-skip-link)', 'var(--ck-z-top-bar)'])
  })

  it('reads only tokens that the theme defines and writes no colour', () => {
    const defined = new Set([...tokens.matchAll(/^\s*(--ck-[a-z0-9-]+):/gm)].map((match) => match[1]))
    const used = [...new Set([...bar.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]))]
    expect(used).toEqual(expect.arrayContaining(['--ck-bottom-nav-height', '--ck-safe-bottom', '--ck-bottom-occupied', '--ck-z-bottom-nav', '--ck-z-menu-sheet', '--ck-nav-bg', '--ck-primary', '--ck-fab-shadow']))
    expect(used.filter((name) => !defined.has(name))).toEqual([])
    expect(bar).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i)
  })

  it('reaches under the cut-out of a phone only together with the side insets', () => {
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />')
    for (const selector of ['.intro', '.page', '.brand-bar .main-navigation', '.brand-bar .main-more[data-open] .main-more-list']) {
      expect(rule(selector, bar), selector).toContain('env(safe-area-inset-left, 0px)')
      expect(rule(selector, bar), selector).toContain('env(safe-area-inset-right, 0px)')
    }
    // The 16 px margins of the artifact, never less.
    expect(rule('.page', bar)).toBe('padding: 0 max(16px, env(safe-area-inset-right, 0px)) var(--ck-bottom-occupied) max(16px, env(safe-area-inset-left, 0px));')
    // Outside of the block (a phone on its side, a wide window) the whole body steps aside; the block takes it over.
    expect(rule('body', rest)).toContain('padding-inline: env(safe-area-inset-left, 0px) env(safe-area-inset-right, 0px);')
    expect(rule('body', bar)).toBe('padding-inline: 0;')
  })

  it('shows the list behind «Ещё» only while open, at once, as a sheet on top of the bar', () => {
    expect(rule('.brand-bar .main-more-list', bar)).toBe('display: none;')
    expect(list).toContain('display: flex;')
    expect(list).toContain('position: absolute;')
    expect(list).toContain('right: 0; bottom: 100%; left: 0;')
    expect(list).toContain('border-radius: var(--ck-radius) var(--ck-radius) 0 0;')
    expect(rule('.brand-bar .main-more-list a', bar)).toContain('min-height: 52px;')
    expect(rule('.brand-bar .main-more-theme', bar)).toContain('display: block;')
    expect(app).not.toMatch(/transition|animation|@keyframes/)
  })

  it('draws no «Ещё», no pictures and no theme row wherever the menu is a row: the links behind it stand in the row', () => {
    expect(rule('.main-more', rest)).toBe('display: contents;')
    expect(rule('.main-more-list', rest)).toBe('display: contents;')
    expect(rule('.main-more-toggle', rest)).toBe('display: none;')
    expect(rule('.main-navigation .ck-icon', rest)).toBe('display: none;')
    expect(rule('.main-more-theme', rest)).toBe('display: none;')
    expect(rule('.brand-bar .main-more-toggle', bar)).toContain('display: flex; flex-direction: column;')
    expect(rule('.brand-bar .main-navigation .ck-icon', bar)).toContain('display: block;')
  })

  it('marks the current section of the bar, and «Ещё» with it, by the colour of links and a heavier word', () => {
    const mark = 'background: none; color: var(--ck-link); font-weight: 800;'
    expect(rule('.brand-bar .main-navigation > a[aria-current]', bar)).toBe(mark)
    expect(rule('.brand-bar .main-more-toggle[data-current]', bar)).toBe(mark)
    expect(rule('.main-navigation a[aria-current]', rest)).toContain('font-weight: 600;')
    expect(rule('.brand-bar .main-more-list a[aria-current]', bar)).toContain('font-weight: 800;')
    // The dot of the header row gives way to the weight in the bar and in the list behind «Ещё».
    expect(rules(bar).filter((item) => item.selector.includes('::before')).map((item) => item.selector))
      .toEqual(['.brand-bar .main-navigation > a[aria-current]::before', '.brand-bar .main-more-list a[aria-current]::before'])
    const forced = app.slice(app.indexOf('@media (forced-colors: active)'))
    expect(rule('.main-more-toggle[data-current]', forced)).toContain('text-decoration: underline;')
  })

  it('raises a round «＋» of the main action over the bar, never over a button of a pinned action bar', () => {
    expect(rule('.main-add', rest)).toBe('display: none;')
    const toggle = rule('.brand-bar .main-add-toggle', bar)
    expect(toggle).toContain('background: var(--ck-primary); color: var(--ck-on-primary); box-shadow: var(--ck-fab-shadow);')
    expect(toggle).toContain('border-radius: 50%;')
    const side = px(toggle, 'width')
    expect(side).toBe(56)
    // Centred in the bar with a negative top margin: its top rises above the edge of the bar by this much, less than
    // the padding of a pinned action bar (ActionBar.css), so it covers no button of one.
    const height = px(rule(':root', bar), '--ck-bottom-nav-height')
    const lift = -px(toggle, 'margin')
    const above = lift - (height - (side - lift)) / 2
    const padding = Number(/padding-block: (\d+)px;/.exec(actionBar)?.[1])
    expect(above).toBeGreaterThan(0)
    expect(above).toBeLessThan(padding)
    expect(rule('.brand-bar .main-add', bar)).toContain('align-items: center;')
    // The actions of its sheet are big rows under the thumb.
    expect(rule('.main-add-action', rest)).toContain('min-height: 72px;')
  })

  it('writes the words of the bar at the 12 px step of the scale only, and makes the sections of a part chips', () => {
    expect([...new Set([...bar.matchAll(/font-size:\s*([^;]+);/g)].map((match) => match[1]))]).toEqual(['var(--ck-text-2xs)'])
    expect(rule('.section-navigation a[aria-current]', rest)).toContain('background: var(--ck-chip-selected-bg); color: var(--ck-chip-selected-text);')
    // Every rule of the bar about the menu is tied to the header: the menu of a section is a .main-navigation too.
    const loose = rules(bar).map((item) => item.selector).filter((selector) => /main-(navigation|more|group)/.test(selector) && !/^(\.ck-focus-mode )?\.brand-bar /.test(selector))
    expect(loose).toEqual([])
  })
})
