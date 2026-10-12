import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = read('./Dashboard.css').replace(/\/\*[\s\S]*?\*\//g, '')
const tokens = read('../../theme/tokens.css')
const block = (selector: string) => {
  const start = tokens.indexOf(`\n${selector} {`)
  return tokens.slice(start, tokens.indexOf('\n}', start))
}
const names = (text: string) => new Set([...text.matchAll(/^\s*(--ck-[a-z0-9-]+):/gm)].map((match) => match[1]))
const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim(), body: match[2] })))
const body = (selector: string) => rules.filter((rule) => rule.selector === selector).map((rule) => rule.body).join(' ')

describe('«Главная» and «Лимиты» styles (text of the rules, not rendering)', () => {
  it('reads only theme tokens, each defined for the dark theme and, for colours, again for the light one', () => {
    const dark = new Set(names(block(':root')))
    // Sizes, fonts and the tooth of the tape are the same in both themes: only colours come again for the light one.
    const light = new Set([...names(block(':root[data-theme="light"]')), ...[...dark].filter((name) => /^--ck-(text-(xs|sm|base|lg|xl|hero)|font-|tape-)/.test(name))])
    const used = [...new Set([...css.matchAll(/var\((--ck-[a-z0-9-]+)/g)].map((match) => match[1]))]
    expect(used.filter((name) => !dark.has(name))).toEqual([])
    expect(used.filter((name) => !light.has(name) && !name.startsWith('--ck-radius'))).toEqual([])
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\brgba?\(|\bhsla?\(/i)
  })
  it('has the family-budget tokens in both themes', () => {
    const contract = [...Array.from({ length: 6 }, (_, index) => [`--ck-cat-${index + 1}`, `--ck-cat-${index + 1}-tint`]).flat(),
      '--ck-over-text', '--ck-over-bar', '--ck-track', '--ck-on-accent']
    for (const selector of [':root', ':root[data-theme="light"]']) {
      const defined = names(block(selector))
      expect(contract.filter((name) => !defined.has(name)), selector).toEqual([])
    }
  })
  it('gives each of the six category colours its class, and a neutral one', () => {
    for (let tone = 1; tone <= 6; tone += 1) {
      expect(body(`.dash-cat-${tone}`)).toBe(` --dash-cat: var(--ck-cat-${tone}); --dash-cat-tint: var(--ck-cat-${tone}-tint); `)
    }
    expect(body('.dash-cat-0')).toContain('--dash-cat: var(--ck-text-muted)')
  })
  it.each(['.dash-total', '.dash-value', '.dash-limit-value', '.dash-recent-amount', '.limits-current', '.dash-month-title', '.dash-action', '.dash-chip', '.limits-input-currency', '.dash-sub-count', '.dash-sub-hint'])(
    'keeps the value %s on one line', (selector) => {
      expect(body(selector)).toContain('white-space: nowrap')
    })
  it('keeps touch targets at 44 px and the overspend in its own colours', () => {
    expect(body('.dash-month-step')).toContain('width: 48px; height: 48px;')
    expect(body('.dash-link')).toContain('min-height: 44px')
    expect(body('.dash-chip')).toContain('min-height: 44px')
    expect(body('.dash-sub-toggle')).toContain('min-height: 44px')
    expect(body('.dash-action')).toContain('min-height: 52px')
    expect(body('.dash-empty-action')).toContain('min-height: 52px')
    expect(body('.limits-save')).toContain('min-height: 52px')
    expect(body('.dash-over')).toContain('color: var(--ck-over-text)')
    expect(body('.dash-bar-over .dash-bar-fill')).toContain('background: var(--ck-over-bar)')
    expect(body('.dash-bar')).toContain('background: var(--ck-track)')
    expect(body('.dash-action-shot')).toContain('color: var(--ck-on-accent)')
  })
  it('draws letters on a category tint in the main text colour, the category colour as a ring', () => {
    for (const selector of ['.dash-avatar', '.dash-badge']) {
      expect(body(selector), selector).toContain('color: var(--ck-text);')
      expect(body(selector), selector).toContain('box-shadow: inset 0 0 0 2px var(--dash-cat);')
      expect(body(selector), selector).not.toMatch(/(^|[;\s])color: var\(--dash-cat\)/)
    }
  })
  it('wraps the value of a limit under its name instead of breaking the name mid-word', () => {
    expect(body('.dash-limit-head')).toContain('flex-wrap: wrap;')
    expect(body('.dash-limit-value')).toContain('margin-left: auto;')
    expect(body('.dash-limit-value')).toContain('white-space: nowrap')
    expect(body('.dash-limit-name')).toContain('overflow-wrap: normal;')
  })
  it('uses the single phone breakpoint of the project and moves only without reduced motion', () => {
    expect([...css.matchAll(/@media[^{]+/g)].map((match) => match[0].trim())).toEqual(['@media (prefers-reduced-motion: no-preference)', '@media (max-width: 540px)'])
    const motion = css.slice(css.indexOf('@media (prefers-reduced-motion'), css.indexOf('@media (max-width'))
    expect(css.replace(motion, '')).not.toMatch(/animation|@keyframes|transition/)
    expect(motion).toContain('.dash-slide-forward { animation: dash-slide-forward 200ms ease-out; }')
    expect(motion).toContain('.dash-slide-back { animation: dash-slide-back 200ms ease-out; }')
  })
  it('sizes text only by the tokens of the type scale, a field never under 16 px', () => {
    const sizes = [...css.matchAll(/font-size:\s*([^;]+);/g)].map((match) => match[1].trim())
    expect(sizes.filter((size) => !/^var\(--ck-text-(xs|sm|base|lg|xl|hero)\)$/.test(size))).toEqual([])
    expect(body('.limits-input input')).toContain('font-size: var(--ck-text-lg)')
    expect(body('.limits-add-row input')).toContain('font-size: var(--ck-text-base)')
  })
  it('keeps the focus ring of a recent spend inside its tape, above the teeth', () => {
    expect(body('.dash-recent-tape')).toContain('padding-bottom: 8px;')
    expect(body('.dash-recent-item:focus-visible')).toBe(' outline-offset: -3px; ')
  })
})
