import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, '')
const charts = strip(read('./Charts.css'))
const tokens = read('../../theme/tokens.css')
const spending = strip(read('../../features/stats/Spending.css'))

const rules = (css: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((match) => ({ selector: match[1].trim(), body: match[2].trim() }))
/** Rules of the `@media (<query>)` blocks. */
const media = (css: string, query: string) => [...css.matchAll(/@media \(([^)]+)\) \{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)]
  .filter((match) => match[1] === query).flatMap((match) => rules(match[2]))
const mediaBodies = [...charts.matchAll(/@media \([^)]+\) \{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)].map((match) => match[0])
/** Rules outside every media block. */
const base = rules(mediaBodies.reduce((css, block) => css.replace(block, ''), charts))
const body = (list: { selector: string; body: string }[], selector: string) => list.filter((item) => item.selector === selector).map((item) => item.body).join(' ')
const value = (text: string, property: string) => new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+);`).exec(text)?.[1].trim()

describe('touch stylesheet guards (text of the rules, not rendering)', () => {
  it('lets a finger scroll and zoom the page over the line plot: pan-y, never none', () => {
    const plot = body(base, '.ck-line-plot')
    const action = value(plot, 'touch-action') ?? ''
    expect(action.split(/\s+/)).toContain('pan-y')
    expect(action.split(/\s+/)).toContain('pinch-zoom')
    expect(action).not.toContain('none')
    for (const item of rules(charts)) expect(item.body, item.selector).not.toMatch(/touch-action:[^;]*\bnone\b/)
    expect(value(plot, 'user-select')).toBe('none')
    expect(value(plot, '-webkit-user-select')).toBe('none')
    expect(value(plot, '-webkit-touch-callout')).toBe('none')
  })
  it('shows the step buttons only where the pointer is a finger, as 44px targets', () => {
    expect(value(body(base, '.ck-line-steps'), 'display')).toBe('none')
    const coarse = media(charts, 'pointer: coarse')
    expect(value(body(coarse, '.ck-line-steps'), 'display')).toBe('grid')
    expect(value(body(base, '.ck-line-steps button'), 'min-height')).toBe('44px')
    // No rule makes a button smaller or hides the panel again on a narrow screen.
    const narrow = media(charts, 'max-width: 540px')
    expect(narrow.filter((item) => item.selector.includes('ck-line-steps')).map((item) => item.selector)).toEqual(['.ck-line-steps', '.ck-line-steps button:last-child'])
    for (const item of rules(charts).filter((entry) => entry.selector.includes('ck-line-steps'))) {
      expect(item.body, item.selector).not.toMatch(/(^|[;\s])(height|max-height|font-size|white-space)\s*:/)
    }
    expect(rules(charts).filter((item) => item.selector.includes('ck-line-steps') && /display:\s*none/.test(item.body)).map((item) => item.selector)).toEqual(['.ck-line-steps'])
  })
  it('gives a switched-off step button the disabled tokens whatever the order of the stylesheets', () => {
    const disabled = body(base, '.ck-line-steps button:disabled')
    expect(value(disabled, 'background')).toBe('var(--ck-disabled-bg)')
    expect(value(disabled, 'border-color')).toBe('var(--ck-disabled-border)')
    expect(value(disabled, 'color')).toBe('var(--ck-disabled-text)')
  })
  it('makes the links of the pie legend 44px under a finger, over a screen’s own link rule', () => {
    const coarse = media(charts, 'pointer: coarse')
    const link = body(coarse, '.ck-chart .ck-pie-legend tbody a')
    expect(value(link, 'min-height')).toBe('44px')
    expect(value(link, 'display')).toBe('inline-flex')
    // The screen rule it has to outweigh has two classes and an element; this one has an element more.
    expect(body(rules(spending), '.spending-currency .ck-pie-legend a')).toContain('padding-block: 6px')
    // Only under a finger: the mouse keeps the compact legend.
    expect(body(base, '.ck-chart .ck-pie-legend tbody a')).toBe('')
  })
  it('adds no motion and no colour of its own: tokens only', () => {
    const added = rules(charts).filter((item) => /ck-line-steps|ck-line-plot$|\.ck-chart \.ck-pie-legend tbody a/.test(item.selector))
    expect(added.length).toBeGreaterThanOrEqual(7)
    for (const item of added) {
      expect(item.body, item.selector).not.toMatch(/transition|animation|#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
      for (const [, name] of item.body.matchAll(/var\((--ck-[a-z0-9-]+)/g)) {
        if (name.startsWith('--ck-chart-')) expect(charts, name).toContain(`${name}:`)
        else expect(tokens, name).toContain(`${name}:`)
      }
    }
  })
})
