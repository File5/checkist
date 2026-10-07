import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./Login.css', import.meta.url), 'utf8')
const tokens = readFileSync(new URL('../../theme/tokens.css', import.meta.url), 'utf8')
const code = css.replace(/\/\*[\s\S]*?\*\//g, '')

/** Flat rules: a media block of this stylesheet holds whole rules. */
const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2].trim() }))
const rule = (selector: string, text = code) => rules(text).filter((item) => item.selector === selector).map((item) => item.body).join(' ')
const media = (query: string) => {
  const start = code.indexOf(`@media ${query} {`)
  if (start < 0) return ''
  const next = code.indexOf('@media', start + 1)
  return code.slice(start, next < 0 ? undefined : next)
}

describe('login stylesheet guards (text of the rules, not rendering)', () => {
  it('holds no colour of its own', () => {
    expect(code).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(code).not.toMatch(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i)
  })

  it('reads only tokens that the theme defines', () => {
    const used = new Set([...code.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]))
    expect(used.size).toBeGreaterThan(10)
    for (const name of used) expect(tokens, name).toContain(`${name}:`)
    expect(code).not.toMatch(/--[\w-]+\s*:/)
  })

  it('names every class with the screen prefix', () => {
    const classes = new Set([...code.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]))
    expect([...classes].filter((name) => name !== 'ck-login' && !name.startsWith('ck-login-'))).toEqual([])
  })

  it('puts the logo on the dark board with a gold frame in both themes', () => {
    const board = rule('.ck-login-board')
    expect(board).toContain('background: var(--ck-logo-bg);')
    expect(board).toContain('border: 2px solid var(--ck-accent);')
    expect(code).not.toMatch(/url\(/)
    expect(code).not.toContain('data-theme')
  })

  it('keeps the logo within a third of the screen height in one column', () => {
    expect(rule('.ck-login-board')).toMatch(/width: min\(100%, 33vh\); width: min\(100%, 33svh\); aspect-ratio: 1;/)
    expect(rule('.ck-login-layout')).toContain('grid-template-columns: minmax(0, 1fr);')
  })

  it('switches to two columns from 720 px', () => {
    const wide = media('(min-width: 720px)')
    expect(rule('.ck-login-layout', wide)).toMatch(/grid-template-columns: minmax\(0, 1\.2fr\) minmax\(280px, 1fr\);/)
    expect([...code.matchAll(/@media \(([^)]*)\)/g)].map((match) => match[1])).toEqual(['min-width: 720px', 'forced-colors: active'])
  })

  it('fills the main button with the brand red and keeps it at least 44 px high', () => {
    const submit = rule('.ck-login-submit')
    expect(submit).toContain('background: var(--ck-brand);')
    expect(submit).toContain('color: var(--ck-on-brand);')
    expect(Number(submit.match(/min-height: (\d+)px/)?.[1])).toBeGreaterThanOrEqual(44)
    expect(Number(rule('.ck-login-input').match(/min-height: (\d+)px/)?.[1])).toBeGreaterThanOrEqual(44)
    expect(rule('.ck-login-footer .ck-login-link')).toContain('min-height: 44px;')
    expect(rule('.ck-login-submit[aria-disabled="true"]')).toContain('background: var(--ck-disabled-bg);')
  })

  it('never writes text in the brand red', () => {
    for (const item of rules(code)) expect(item.body, item.selector).not.toMatch(/(^|[;\s])color: var\(--ck-brand/)
  })

  it('shows an error by a thicker frame as well as by colour', () => {
    expect(rule('.ck-login-input[aria-invalid="true"]')).toContain('border: 2px solid var(--ck-error-border);')
    expect(rule('.ck-login-message')).toContain('border-left-width: 4px;')
    expect(rule('.ck-login-message-error')).toContain('color: var(--ck-error-text);')
    expect(rule('.ck-login-message-warning')).toContain('color: var(--ck-warning-text);')
  })

  it('draws the focus ring from the theme token, away from the red fill', () => {
    const selector = '.ck-login .ck-login-title:focus-visible, .ck-login .ck-login-input:focus-visible, .ck-login .ck-login-submit:focus-visible, .ck-login .ck-login-link:focus-visible'
    expect(rule(selector, code.slice(0, code.indexOf('@media')))).toBe('outline: 3px solid var(--ck-focus); outline-offset: 3px;')
    expect(code).not.toMatch(/outline:\s*(none|0)\b/)
  })

  it('has no motion and keeps a forced-colors block', () => {
    expect(code).not.toMatch(/\b(animation|transition|@keyframes)\b/)
    const forced = media('(forced-colors: active)')
    expect(rule('.ck-login-rays', forced)).toBe('display: none;')
    expect(rule('.ck-login-submit', forced)).toContain('ButtonText')
    expect(forced).toContain('outline-color: Highlight;')
  })
})
