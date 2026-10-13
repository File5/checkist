import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = new URL('../../', import.meta.url)
const read = (path: string) => readFileSync(new URL(path, source), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const app = read('App.css')
const auth = read('features/auth/Auth.css')
const tokens = readFileSync(new URL('theme/tokens.css', source), 'utf8')

/** Flat rules: a media block of these stylesheets holds whole rules. */
const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim(), body: match[2].trim() })))
const rule = (selector: string, text = auth) => rules(text).filter((item) => item.selector === selector).map((item) => item.body).join(' ')
const declares = (body: string, property: string) => new RegExp(`(^|[;\\s])${property}\\s*:`).test(body)
const paints = (body: string) => declares(body, 'color') || declares(body, 'border-color') || declares(body, 'background')
const media = (query: string) => {
  const start = auth.indexOf(`@media ${query} {`)
  if (start < 0) return ''
  const next = auth.indexOf('@media', start + 1)
  return auth.slice(start, next < 0 ? undefined : next)
}
const base = auth.slice(0, auth.indexOf('@media'))

/** Specificity as [classes + attributes + pseudo-classes, elements]; whatever stands inside :where() weighs nothing. */
const weight = (selector: string): [number, number] => {
  let text = selector
  for (let start = text.indexOf(':where('); start >= 0; start = text.indexOf(':where(')) {
    let end = start + 7
    for (let depth = 1; depth > 0 && end < text.length; end += 1) depth += text[end] === '(' ? 1 : text[end] === ')' ? -1 : 0
    text = text.slice(0, start) + text.slice(end)
  }
  text = text.replace(/::[\w-]+/g, '').replace(/:not\(|\)/g, ' ')
  const classes = (text.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []).length
  const elements = (text.replace(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g, ' ').match(/[a-z][\w-]*/gi) ?? []).length
  return [classes, elements]
}
const heavier = (left: string, right: string) => {
  const [a, b] = [weight(left), weight(right)]
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])
}

describe('auth stylesheet guards (text of the rules, not rendering)', () => {
  it('holds no colour of its own', () => {
    expect(auth).not.toMatch(/#[0-9a-f]{3,8}\b/i)
    expect(auth).not.toMatch(/\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/i)
  })

  it('reads only tokens that the theme defines and defines none', () => {
    const used = new Set([...auth.matchAll(/var\((--[\w-]+)/g)].map((match) => match[1]))
    expect(used.size).toBeGreaterThan(15)
    for (const name of used) expect(tokens, name).toContain(`${name}:`)
    expect(auth).not.toMatch(/--[\w-]+\s*:/)
    expect(auth).not.toContain('data-theme')
  })

  it('names every class with the prefix of the sign-in or of the forms', () => {
    const classes = new Set([...auth.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((match) => match[1]))
    expect([...classes].filter((name) => !/^ck-(auth|login)(-|$)/.test(name))).toEqual([])
  })

  it('never writes text in the brand red', () => {
    for (const item of rules(auth)) expect(item.body, item.selector).not.toMatch(/(^|[;\s])color: var\(--ck-brand/)
  })

  it('paints the card, the fields and the messages from the tokens', () => {
    // A card of the artifact: the surface with the shadow of the theme, no frame.
    expect(rule('.ck-auth-panel')).toContain('border-radius: var(--ck-radius); background: var(--ck-surface); box-shadow: var(--ck-card-shadow);')
    expect(rule('.ck-auth-field input')).toContain('color: var(--ck-text); background: var(--ck-surface); border: 1px solid var(--ck-border-field);')
    expect(rule('.ck-auth-field select')).toBe(rule('.ck-auth-field input'))
    for (const part of ['border: 1px solid var(--ck-warning-border);', 'background: var(--ck-warning-bg);', 'color: var(--ck-warning-text);']) expect(rule('.ck-auth-notice')).toContain(part)
    expect(rule('.ck-auth-done')).toContain('color: var(--ck-success-text);')
    expect(rule('.ck-auth-rules', base)).toContain('color: var(--ck-text-muted);')
  })

  it('shows a refusal by a thicker frame and a bar as well as by colour', () => {
    expect(rule('.ck-auth-field input[aria-invalid="true"]', base)).toBe('border-color: var(--ck-error-border); border-width: 2px;')
    expect(rule('.ck-auth-error', base)).toContain('border-left: 4px solid var(--ck-error-border); color: var(--ck-error-text);')
  })

  it('keeps the surface, the frame and the text of the outline and the danger buttons while hovered and pressed', () => {
    expect(rule('.ck-auth-secondary')).toBe('min-height: 48px; border: 1.5px solid var(--ck-link); background: var(--ck-surface); color: var(--ck-link); font-weight: 700;')
    expect(rule('.ck-auth-secondary:hover')).toBe('background: var(--ck-surface-raised); border-color: var(--ck-link-hover); color: var(--ck-link-hover);')
    expect(rule('.ck-auth-secondary:active')).toBe('background: var(--ck-accent-bg); border-color: var(--ck-link-hover); color: var(--ck-link-hover);')
    // A danger is quiet: an outline in the error colours, never a fill.
    expect(rule('.ck-auth-danger')).toBe('min-height: 48px; border: 1.5px solid var(--ck-error-border); background: var(--ck-surface); color: var(--ck-error-text); font-weight: 700;')
    for (const state of [':hover', ':active']) expect(rule(`.ck-auth-danger${state}`)).toBe('background: var(--ck-error-bg); border-color: var(--ck-error-text); color: var(--ck-error-text);')
    const order = rules(auth).map((item) => item.selector)
    expect(order.indexOf('.ck-auth-secondary:hover')).toBeLessThan(order.indexOf('.ck-auth-secondary:active'))
  })

  it('keeps a button with a request in flight grey under the pointer and the press, the outline one too', () => {
    const disabled = 'background: var(--ck-disabled-bg); border-color: var(--ck-disabled-border); color: var(--ck-disabled-text); cursor: default;'
    const selectors = ['.ck-auth button[aria-disabled="true"]', '.ck-auth button[aria-disabled="true"]:hover', '.ck-auth button[aria-disabled="true"]:active']
    for (const selector of selectors) {
      expect(rule(selector, base), selector).toBe(disabled)
      for (const kind of ['primary', 'secondary', 'danger']) for (const state of ['', ':hover', ':active']) {
        expect(heavier(selector, `.ck-auth-${kind}${state}`), `${selector} > ${kind}${state}`).toBe(true)
      }
    }
  })

  it('outweighs every shared button rule of the shell wherever it paints a button', () => {
    // App.css goes after this file in the build: an equal weight there would win.
    const shell = rules(app).filter((item) => /^button(?![\w-])/.test(item.selector) && paints(item.body)).map((item) => item.selector)
    expect(shell).toEqual(['button', 'button:where(:hover:not(:disabled))', 'button:where(:active:not(:disabled))', 'button:disabled'])
    // `button:disabled` never matches here: the forms lock a button by aria-disabled (auth-markup.test.tsx).
    const live = shell.filter((selector) => selector !== 'button:disabled')
    expect(live.map(weight)).toEqual([[0, 1], [0, 1], [0, 1]])
    const mine = rules(base).filter((item) => /link|segment|primary|secondary|danger|button/.test(item.selector) && paints(item.body)).map((item) => item.selector)
    expect(mine).toEqual([
      '.ck-auth-link', '.ck-auth-link:hover', '.ck-auth-link:active',
      '.ck-auth-segments', '.ck-auth-segment', '.ck-auth-segment:hover', '.ck-auth-segment:active',
      '.ck-auth-segment[aria-pressed="true"]', '.ck-auth-segment[aria-pressed="true"]:hover', '.ck-auth-segment[aria-pressed="true"]:active',
      '.ck-auth-primary', '.ck-auth-primary:hover', '.ck-auth-primary:active',
      '.ck-auth-secondary', '.ck-auth-secondary:hover', '.ck-auth-secondary:active',
      '.ck-auth-danger', '.ck-auth-danger:hover', '.ck-auth-danger:active',
      '.ck-auth button[aria-disabled="true"]', '.ck-auth button[aria-disabled="true"]:hover', '.ck-auth button[aria-disabled="true"]:active',
    ])
    for (const selector of mine) for (const other of live) expect(heavier(selector, other), `${selector} > ${other}`).toBe(true)
  })

  it('fills the main action with the primary tokens: red under white in the light theme, gold under dark in the dark one', () => {
    const primary = rule('.ck-auth-primary')
    expect(primary).toContain('background: var(--ck-primary); color: var(--ck-on-primary);')
    expect(primary).toContain('width: 100%;')
    for (const state of [':hover', ':active']) expect(rule(`.ck-auth-primary${state}`)).toBe('background: var(--ck-primary-hover); color: var(--ck-on-primary);')
    expect(Number(primary.match(/min-height: (\d+)px/)?.[1])).toBeGreaterThanOrEqual(56)
    expect(Number(rule('.ck-auth-field input', base).match(/min-height: (\d+)px/)?.[1])).toBeGreaterThanOrEqual(48)
    // Every size of the text comes from the scale of the theme.
    for (const size of auth.match(/font-size: [^;]+/g) ?? []) expect(size).toMatch(/var\(--ck-text-/)
  })

  it('draws the focus ring from the theme token, heavier than the ring of the shell', () => {
    const mine = ['.ck-auth button:focus-visible', '.ck-auth input:focus-visible']
    for (const selector of mine) expect(rule(selector, base), selector).toBe('outline: 3px solid var(--ck-focus); outline-offset: 3px;')
    expect(heavier(mine[0], 'button:focus-visible')).toBe(true)
    expect(heavier(mine[1], 'input:focus-visible')).toBe(true)
    // The heading «Вход» is focused by script only: the shell takes its ring off (theme/focus-ring-css.test.ts).
    expect(rules(auth).filter((item) => /(^|[\s>+~])h1(?![\w-])[^,]*:focus/.test(item.selector))).toEqual([])
    expect(auth).not.toMatch(/outline:\s*(none|0)\b/)
  })

  it('puts the logo on the dark board with a gold frame in both themes', () => {
    const board = rule('.ck-login-board', base)
    expect(board).toContain('background: var(--ck-logo-bg);')
    expect(board).toContain('border: 2px solid var(--ck-accent);')
    expect(auth).not.toMatch(/url\(/)
  })

  it('stacks the logo over the card of the form in one column, the logo an icon of at most 152 px', () => {
    expect(rule('.ck-login-layout', base)).toContain('grid-template-columns: minmax(0, 1fr);')
    expect(rule('.ck-login-board', base)).toMatch(/width: min\(100%, 152px, 22vh\); width: min\(100%, 152px, 22svh\); aspect-ratio: 1;/)
    expect(rule('.ck-login-panel', base)).toContain('background: var(--ck-surface); box-shadow: var(--ck-card-shadow);')
    // Nothing may push the page sideways on a phone.
    expect(rule('.ck-login-panel')).toContain('width: 100%; max-width: 420px; min-width: 0;')
    expect(rule('.ck-login', base)).toContain('overflow-wrap: anywhere;')
    for (const item of rules(base)) expect(item.body, item.selector).not.toMatch(/(^|[;\s])(min-)?width: (?!min\()\d{3,}px/)
  })

  it('switches to two columns from 720 px: the logo on the left, the form on the right', () => {
    const wide = media('(min-width: 720px)')
    expect(rule('.ck-login-layout', wide)).toMatch(/grid-template-columns: minmax\(0, 1\.2fr\) minmax\(320px, 1fr\);/)
    expect([...auth.matchAll(/@media \(([^)]*)\)/g)].map((match) => match[1])).toEqual(['min-width: 720px', 'forced-colors: active'])
  })

  it('draws the form of the sign-in inside its card, without a card of its own', () => {
    expect(rule('.ck-login .ck-auth-panel')).toBe('gap: 16px; padding: 0; background: none; border-radius: 0; box-shadow: none;')
    // Heavier than the narrow-screen padding of the card, which stands later in the file.
    expect(heavier('.ck-login .ck-auth-panel', '.ck-auth-panel')).toBe(true)
  })

  it('has no motion and keeps a forced-colors block', () => {
    expect(auth).not.toMatch(/\b(animation|transition|@keyframes)\b/)
    const forced = media('(forced-colors: active)')
    expect(rule('.ck-login-rays', forced)).toBe('display: none;')
    expect(forced).toContain('outline-color: Highlight;')
  })
})
