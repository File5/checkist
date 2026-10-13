import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = new URL('../', import.meta.url)
const raw = (path: string) => readFileSync(new URL(path, source), 'utf8')
const strip = (text: string) => text.replace(/\/\*[\s\S]*?\*\//g, '')
const app = strip(raw('App.css'))
const tokens = strip(raw('theme/tokens.css'))

const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim(), body: match[2].trim() })))
const rule = (selector: string, text: string) => rules(text).filter((item) => item.selector === selector).map((item) => item.body).join(' ')

const phone = '@media (max-width: 540px) {'
const barQuery = '@media (max-width: 540px) and (min-width: 340px) and (min-height: 480px) {'
const block = (query: string) => app.slice(app.indexOf(query) + query.length).split('\n}')[0]
const narrow = block(phone)
const bar = block(barQuery)
const wide = app.slice(0, app.indexOf('@media'))
/** The utilities after the two theme blocks of tokens.css. */
const utilities = tokens.slice(tokens.indexOf('.ck-figures'))

describe('utilities of the mobile design in tokens.css (text of the rules, not rendering)', () => {
  it('draws figures by the figures font, in columns, never broken', () => {
    expect(rule('.ck-figures', utilities)).toBe('font-family: var(--ck-font-figures); font-weight: 700; font-variant-numeric: tabular-nums; white-space: nowrap;')
  })

  it('draws the hero sum by the display figures at the hero size, no wider than the window allows', () => {
    const hero = rule('.ck-hero-figure', utilities)
    expect(hero).toContain('font-family: var(--ck-font-display-figures);')
    expect(hero).toContain('font-size: min(var(--ck-text-hero), 10vw);')
    expect(hero).toContain('font-weight: 800;')
    expect(hero).toContain('white-space: nowrap;')
  })

  it('puts the dotted leader before the last child of the row, in the muted colour', () => {
    expect(rule('.ck-leader', utilities)).toContain('display: flex;')
    expect(rule('.ck-leader > :last-child', utilities)).toBe('order: 2; flex: none; white-space: nowrap;')
    const dots = rule('.ck-leader::before', utilities)
    expect(dots).toContain('order: 1;')
    expect(dots).toContain('var(--ck-text-muted)')
  })

  it('tears the bottom of a tape card by a mask only where masks work: elsewhere it is a plain card', () => {
    const supports = '@supports (mask-repeat: repeat-x) or (-webkit-mask-repeat: repeat-x) {'
    expect(tokens.split(supports)).toHaveLength(2)
    const start = tokens.indexOf(supports)
    const tape = tokens.slice(start, tokens.indexOf('\n}\n', start) + 2)
    expect(tape).toContain('-webkit-mask: conic-gradient(')
    expect(tape).toMatch(/\n\s*mask: conic-gradient\(/)
    expect(tape).toContain('var(--ck-tape-tooth)')
    // Outside of @supports no rule names the tape: without masks nothing changes.
    expect(tokens.slice(0, tokens.indexOf(supports))).not.toContain('.ck-tape')
    // A mask has no colour of its own: it works on every background of both themes.
    expect(tape).not.toMatch(/var\(--ck-(bg|surface)/)
  })

  it('writes no colour value in the utilities', () => {
    expect(utilities).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i)
  })
})

describe('text sizes go through the scale (mobile design 2026-10-12, text of the rules)', () => {
  const files = (readdirSync(source, { recursive: true }) as string[]).map((path) => path.replaceAll('\\', '/'))
  const scale = /^(?:var\(--ck-text-(?:xs|sm|base|lg|xl|hero)\)|max\(var\(--ck-text-base\), 1em\)|min\(var\(--ck-text-hero\), 10vw\))$/

  it('sizes every text of the new shared parts by a token of the scale', () => {
    for (const path of ['components/Sheet.css', 'components/ChipScroller.css', 'components/ResponsiveFilters.css', 'theme/tokens.css']) {
      for (const [, size] of strip(raw(path)).matchAll(/font-size:\s*([^;]+);/g)) expect(size.trim(), path).toMatch(scale)
    }
  })

  it('sizes the new rules of the phone block by the scale too', () => {
    expect(rule('.intro h1', narrow)).toContain('font-size: var(--ck-text-xl);')
    const sizes = rules(narrow).flatMap((item) => [...item.body.matchAll(/font-size:\s*([^;]+);/g)].map((match) => [item.selector, match[1].trim()]))
    // The older sizes of the block stay as they were; every new one is a token of the scale.
    expect(sizes.filter(([, size]) => !scale.test(size)).map(([selector, size]) => `${selector}: ${size}`))
      .toEqual(['.brand: 1.3rem', '.intro-text: 1.05rem', '.service-state: 0.85rem'])
  })

  it('moves only in the sheet, the month, the network bar and the skeleton: no other stylesheet of the client has an animation', () => {
    const moving = files.filter((path) => path.endsWith('.css') && !/(^|[/-])preview\//.test(path) && /@keyframes/.test(strip(raw(path))))
    // The plan allows two motions: the sheet and the change of a month on «Главная»; loading in parts (2026-10-13) adds
    // the running segment of the network bar and the pulse of a skeleton. All of them only under reduced motion.
    expect(moving.sort()).toEqual(['components/NetworkBar.css', 'components/Sheet.css', 'components/Skeleton.css', 'features/dashboard/Dashboard.css'])
  })
})

describe('controls and the top bar of a phone (text of the rules, not rendering)', () => {
  it('makes the fields of a page 48 px tall and never smaller than 16 px, weightless before a screen class', () => {
    const field = 'main :where(input:not([type="checkbox"]):not([type="radio"]):not([type="range"]):not([type="file"]))'
    expect(rule(field, narrow)).toBe('min-height: 48px; font-size: max(var(--ck-text-base), 1em);')
    expect(rule('main :where(select)', narrow)).toBe(rule(field, narrow))
    expect(rule('main :where(textarea)', narrow)).toBe(rule(field, narrow))
    expect(rule('main :where(button)', narrow)).toBe('min-height: 48px;')
  })

  it('keeps the general focus ring for a text area too', () => {
    expect(rule('textarea:focus-visible', app)).toBe('outline: 3px solid var(--ck-focus); outline-offset: 4px;')
  })

  it('gives buttons a secondary look and a quiet danger look: an outline in the error colours, never a fill', () => {
    expect(rule('.ck-button-secondary', wide)).toBe('border-color: var(--ck-link); background: var(--ck-surface); color: var(--ck-link);')
    const danger = 'border-color: var(--ck-error-border); background: var(--ck-surface); color: var(--ck-error-text);'
    expect(rule('.ck-button-danger', wide)).toBe(danger)
    expect(rule('.expense-danger', wide)).toBe(danger)
    expect(rule('.expense-danger:where(:hover:not(:disabled))', wide)).toBe('border-color: var(--ck-error-text); background: var(--ck-error-bg); color: var(--ck-error-text);')
  })

  it('shows «назад» only on a phone, as a 44 px target', () => {
    expect(rule('.ck-back', wide)).toBe('display: none;')
    expect(rule('.ck-back', narrow)).toContain('display: inline-flex;')
    expect(rule('.ck-back', narrow)).toContain('width: 44px; height: 44px;')
    expect(rule('.intro .eyebrow', narrow)).toBe('display: none;')
  })

  it('draws «назад», «✕» and the steps of a month as one round control of 44 px with a thin frame', () => {
    const round = rule('.ck-round', wide)
    expect(round).toContain('width: 44px; height: 44px;')
    expect(round).toContain('border: 1px solid var(--ck-border); border-radius: 50%; background: var(--ck-surface); color: var(--ck-text);')
    expect(rule('.ck-close', wide)).toBe('margin-left: auto;')
    // The slots of a page have no box: their parts stand in the row (components/PageHeader.tsx).
    expect(rule('.intro-slot', wide)).toBe('display: contents;')
  })

  it('pins the heading row to the top on a phone tall enough, in the colour of the page, from the safe areas', () => {
    const intro = rule('.intro', bar)
    expect(intro).toContain('position: sticky; top: 0; z-index: var(--ck-z-top-bar);')
    expect(intro).toContain('background: var(--ck-bg);')
    expect(intro).toContain('env(safe-area-inset-top, 0px)')
    expect(intro).toContain('env(safe-area-inset-left, 0px)')
    expect(intro).toContain('env(safe-area-inset-right, 0px)')
    expect(app.replace(bar, '')).not.toMatch(/position: sticky/)
  })

  it('keeps the bottom bar 64 px tall (the artifact: a picture over a word, the raised «＋»)', () => {
    expect(rule(':root', bar)).toBe('--ck-bottom-nav-height: 4rem; --ck-top-bar-height: 4rem;')
  })

  it('draws the action slot of an empty or failed state as a row that a phone stretches', () => {
    expect(rule('.request-state-action', wide)).toContain('display: flex;')
    expect(rule('.request-state-action > :where(button)', narrow)).toBe('flex: 1 1 100%;')
  })
})
