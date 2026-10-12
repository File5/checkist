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
    const dark = names(block(':root'))
    const light = names(block(':root[data-theme="light"]'))
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
  it.each(['.dash-total', '.dash-value', '.dash-limit-value', '.dash-recent-amount', '.limits-current', '.dash-month-title', '.dash-action', '.dash-chip', '.limits-input-currency'])(
    'keeps the value %s on one line', (selector) => {
      expect(body(selector)).toContain('white-space: nowrap')
    })
  it('keeps touch targets at 44 px and the overspend in its own colours', () => {
    expect(body('.dash-month-step')).toContain('width: 44px; height: 44px;')
    expect(body('.dash-link')).toContain('min-height: 44px')
    expect(body('.dash-chip')).toContain('min-height: 44px')
    expect(body('.dash-action')).toContain('min-height: 64px')
    expect(body('.dash-over')).toContain('color: var(--ck-over-text)')
    expect(body('.dash-bar-over .dash-bar-fill')).toContain('background: var(--ck-over-bar)')
    expect(body('.dash-bar')).toContain('background: var(--ck-track)')
    expect(body('.dash-action-shot')).toContain('color: var(--ck-on-accent)')
  })
  it('uses the single phone breakpoint of the project', () => {
    expect([...css.matchAll(/@media[^{]+/g)].map((match) => match[0].trim())).toEqual(['@media (max-width: 540px)'])
  })
})
