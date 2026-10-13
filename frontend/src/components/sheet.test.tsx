import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import Sheet from './Sheet'
import { sheetKeyAction, shouldReturnFocus, SHEET_FOCUSABLE } from './sheet-keys'

const css = readFileSync(new URL('./Sheet.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const tokens = readFileSync(new URL('../theme/tokens.css', import.meta.url), 'utf8')

describe('markup of the sheet (Node server render, not browser behaviour)', () => {
  const open = renderToStaticMarkup(<Sheet open onClose={() => {}} title="Фильтры" id="filters-sheet"><p>Форма</p></Sheet>)

  it('renders nothing while closed', () => {
    expect(renderToStaticMarkup(<Sheet open={false} onClose={() => {}} title="Фильтры"><p>Форма</p></Sheet>)).toBe('')
  })

  it('is a modal dialog named by its visible heading', () => {
    expect(open).toMatch(/<div class="ck-sheet" role="dialog" aria-modal="true" aria-labelledby="([^"]+)" id="filters-sheet" tabindex="-1">/)
    const labelledBy = /aria-labelledby="([^"]+)"/.exec(open)?.[1]
    expect(open).toContain(`<h2 class="ck-sheet-title" id="${labelledBy}">Фильтры</h2>`)
  })

  it('has a backdrop and a handle that are pictures only, a close button and the content', () => {
    expect(open).toMatch(/^<div class="ck-sheet-layer"><div class="ck-sheet-backdrop" aria-hidden="true"><\/div>/)
    expect(open).toContain('<div class="ck-sheet-handle" aria-hidden="true"></div>')
    expect(open).toContain('<button type="button" class="ck-sheet-close" aria-label="Закрыть">')
    expect(open).toContain('<div class="ck-sheet-body"><p>Форма</p></div>')
    expect(renderToStaticMarkup(<Sheet open onClose={() => {}} title="Т" closeLabel="Готово"><i /></Sheet>)).toContain('aria-label="Готово"')
  })
})

describe('keys of an open sheet (the trap without a browser)', () => {
  it('closes on Esc wherever the focus is', () => {
    expect(sheetKeyAction('Escape', false, 1, 3)).toEqual({ kind: 'close' })
    expect(sheetKeyAction('Escape', true, -1, 0)).toEqual({ kind: 'close' })
  })

  it('goes round from the last control to the first and back', () => {
    expect(sheetKeyAction('Tab', false, 2, 3)).toEqual({ kind: 'focus', index: 0 })
    expect(sheetKeyAction('Tab', true, 0, 3)).toEqual({ kind: 'focus', index: 2 })
  })

  it('leaves Tab between two controls inside to the browser, and other keys alone', () => {
    expect(sheetKeyAction('Tab', false, 0, 3)).toBeNull()
    expect(sheetKeyAction('Tab', true, 2, 3)).toBeNull()
    expect(sheetKeyAction('Enter', false, 0, 3)).toBeNull()
    expect(sheetKeyAction('ArrowDown', false, 0, 3)).toBeNull()
  })

  it('brings a focus that stands outside back in, and keeps it when nothing inside is reachable', () => {
    expect(sheetKeyAction('Tab', false, -1, 3)).toEqual({ kind: 'focus', index: 0 })
    expect(sheetKeyAction('Tab', true, -1, 3)).toEqual({ kind: 'focus', index: 2 })
    expect(sheetKeyAction('Tab', false, -1, 0)).toEqual({ kind: 'focus', index: -1 })
  })

  it('returns the focus to the opener unless it was put elsewhere on purpose', () => {
    expect(shouldReturnFocus('inside', true)).toBe(true)
    expect(shouldReturnFocus('lost', true)).toBe(true)
    expect(shouldReturnFocus('elsewhere', true)).toBe(false)
    expect(shouldReturnFocus('inside', false)).toBe(false)
  })

  it('counts only what Tab reaches', () => {
    expect(SHEET_FOCUSABLE).toContain('button:not([disabled])')
    expect(SHEET_FOCUSABLE).toContain('[tabindex]:not([tabindex="-1"])')
    expect(SHEET_FOCUSABLE).toContain('input:not([disabled]):not([type="hidden"])')
  })
})

describe('Sheet.css (text of the rules, not rendering)', () => {
  it('moves only for a person who has not asked for less motion', () => {
    const motion = '@media (prefers-reduced-motion: no-preference) {'
    expect(css.split(motion)).toHaveLength(2)
    const outside = css.slice(0, css.indexOf(motion))
    expect(outside).not.toMatch(/animation|transition|@keyframes/)
    expect(css.slice(css.indexOf(motion))).toContain('@keyframes ck-sheet-in')
  })

  it('lies on its own layer, keeps the gesture strip and the side insets free', () => {
    expect(css).toContain('z-index: var(--ck-z-sheet);')
    expect(css).toContain('calc(16px + var(--ck-safe-bottom))')
    expect(css).toContain('env(safe-area-inset-left, 0px)')
    expect(css).toContain('env(safe-area-inset-right, 0px)')
    expect(css).toContain('html.ck-sheet-open { overflow: hidden; }')
  })

  it('writes no colour and reads only tokens that the theme defines; text sizes come from the scale', () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(/i)
    const defined = new Set([...tokens.matchAll(/^\s*(--ck-[a-z0-9-]+):/gm)].map((match) => match[1]))
    const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]))]
    expect(used.filter((name) => !defined.has(name))).toEqual([])
    for (const [, size] of css.matchAll(/font-size:\s*([^;]+);/g)) expect(size).toMatch(/^var\(--ck-text-(xs|sm|base|lg|xl|hero)\)$/)
  })
})
