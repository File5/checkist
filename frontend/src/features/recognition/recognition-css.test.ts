import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const css = readFileSync(new URL('./Recognition.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')

/** Flat rules: a media block of this stylesheet holds whole rules. */
const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim().replace(/^@media[^{]*\{\s*/, ''), body: match[2].trim() })))
const all = rules(css)
const rule = (selector: string) => all.filter((item) => item.selector === selector).map((item) => item.body).join(' ')
const value = (body: string, property: string) => new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim()
const narrow = /@media \(max-width: 540px\) \{([\s\S]*?\})\s*\}/.exec(css)?.[1] ?? ''

describe('recognition stylesheet guards (text of the rules, not rendering)', () => {
  it('never splits a word and its number, on any width', () => {
    expect(value(rule('.ck-rec-pair'), 'white-space')).toBe('nowrap')
    expect(narrow).not.toBe('')
    expect(narrow).not.toMatch(/white-space/)
    expect(all.filter((item) => value(item.body, 'white-space') === 'normal')).toEqual([])
  })

  it('keeps free text wrapping: the file name and long names are not pinned to one line', () => {
    expect(value(rule('.ck-rec'), 'overflow-wrap')).toBe('anywhere')
    // Only the pair and the visually hidden legend are single-line.
    expect(all.filter((item) => value(item.body, 'white-space') === 'nowrap').map((item) => item.selector)).toEqual(['.ck-rec-pair', '.ck-review-hidden'])
  })

  it('lets every box of the form shrink to a narrow screen', () => {
    for (const selector of ['.ck-rec', '.ck-rec-panel', '.ck-rec-card', '.ck-rec-list > li', '.ck-review', '.ck-review-body', '.ck-review-group', '.ck-review-field', '.ck-review-store']) {
      expect(value(rule(selector), 'min-width'), selector).toBe('0')
    }
    const field = rule('.ck-rec input')
    expect(value(field, 'width')).toBe('100%'); expect(value(field, 'min-width')).toBe('0')
    expect(rule('.ck-rec select')).toBe(field)
    // A column is never wider than its grid: one column on a phone, several on a desktop.
    for (const selector of ['.ck-review-grid', '.ck-rec-facts']) {
      expect(value(rule(selector), 'grid-template-columns'), selector).toMatch(/^repeat\(auto-fit, minmax\(min\(100%, \d+px\), 1fr\)\)$/)
    }
  })

  it('limits the width of the correction form on the wide page and of nothing else', () => {
    expect(value(rule('.ck-review'), 'max-width')).toMatch(/^\d+px$/)
    const limited = all.filter((item) => value(item.body, 'max-width') !== undefined && value(item.body, 'max-width') !== '100%')
    expect(limited.map((item) => item.selector)).toEqual(['.ck-review'])
  })

  it('takes every size of the text from the scale of the theme and never changes it on a phone', () => {
    const sizes = all.flatMap((item) => value(item.body, 'font-size') ?? [])
    expect(sizes.length).toBeGreaterThan(0)
    for (const size of sizes) expect(size).toMatch(/^var\(--ck-text-(xs|sm|base|lg|xl)\)$/)
    expect(narrow).not.toMatch(/font-size/)
  })

  it('draws the blocks as cards of the artifact, the jobs as rows of their card, states as pills', () => {
    expect(rule('.ck-rec-panel')).toContain('background: var(--ck-surface); box-shadow: var(--ck-card-shadow);')
    expect(rule('.ck-rec-card')).toContain('border-top: 1px solid var(--ck-divider);')
    expect(rule('.ck-rec-status')).toContain('border-radius: var(--ck-radius-pill);')
    // «Отменить» is a quiet danger: an outline in the error colours while it can be pressed.
    expect(rule('.ck-rec-cancel:not(:disabled)')).toBe('border: 1.5px solid var(--ck-error-border); background: var(--ck-surface); color: var(--ck-error-text);')
  })

  it('takes every colour from the theme tokens', () => {
    expect(css.match(/#[0-9a-f]{3,8}\b|(?:rgb|hsl)a?\(/gi)).toBeNull()
  })
})
