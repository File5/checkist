import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = new URL('../', import.meta.url)
const raw = (path: string) => readFileSync(new URL(path, source), 'utf8')
const read = (path: string) => raw(path).replace(/\/\*[\s\S]*?\*\//g, '')
const css = read('components/ActionBar.css')
const tokens = read('theme/tokens.css')
const main = raw('main.tsx')

const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim(), body: match[2].trim().replace(/\s+/g, ' ') })))
const media = [...css.matchAll(/@media\s*([^{]+?)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)]
const inside = media.flatMap((match) => rules(match[2]))
const rule = (selector: string) => inside.filter((item) => item.selector === selector).map((item) => item.body).join(' ')
const value = (body: string, property: string) => body.match(new RegExp(`(?:^|;\\s*)${property}\\s*:\\s*([^;]+);`))?.[1].trim()

const root = tokens.slice(tokens.indexOf('\n:root {'), tokens.indexOf('\n}', tokens.indexOf('\n:root {')))
const token = (name: string) => root.match(new RegExp(`^\\s*${name}:\\s*([^;]+);`, 'm'))?.[1]

describe('layout tokens (text of the file, not rendering)', () => {
  it('defines the names the other screens read, once and for both themes', () => {
    expect(token('--ck-bottom-nav-height')).toBe('0px')
    expect(token('--ck-safe-bottom')).toBe('env(safe-area-inset-bottom, 0px)')
    expect(token('--ck-bottom-occupied')).toBe('calc(var(--ck-bottom-nav-height) + var(--ck-safe-bottom))')
    expect(token('--ck-action-bar-room')).toMatch(/^\d+px$/)
    const light = tokens.slice(tokens.indexOf('\n:root[data-theme="light"] {'))
    expect(light).not.toMatch(/--ck-(bottom|safe|action-bar|z)-/)
  })

  it('stacks the layers: pinned cells, the action bar, the bottom navigation, the menu sheet, the skip link', () => {
    const layers = ['--ck-z-action-bar', '--ck-z-bottom-nav', '--ck-z-menu-sheet', '--ck-z-skip-link'].map((name) => Number(token(name)))
    expect(layers).toEqual([10, 20, 30, 40])
    expect(layers[0]).toBeGreaterThan(1)
  })

  it('leaves room for two stacked buttons of the bar', () => {
    // Two 44 px buttons, the 12 px gap of the action wrappers, the padding and the border of the bar.
    expect(Number.parseInt(token('--ck-action-bar-room') ?? '0', 10)).toBeGreaterThanOrEqual(44 + 12 + 44 + 10 + 10 + 1)
  })
})

describe('action bar guards (text of the rules, not rendering)', () => {
  it('acts only on a phone that is tall enough', () => {
    expect(media.map((match) => match[1])).toEqual(['(max-width: 540px) and (min-height: 480px)'])
    expect(rules(css.replace(media[0][0], ''))).toEqual([])
    expect(inside.map((item) => item.selector)).toEqual(['.ck-action-bar', 'html'])
  })

  it('sticks above the bottom navigation and the gesture strip, by tokens', () => {
    const bar = rule('.ck-action-bar')
    expect(value(bar, 'position')).toBe('sticky')
    expect(value(bar, 'bottom')).toBe('var(--ck-bottom-occupied)')
    expect(value(bar, 'z-index')).toBe('var(--ck-z-action-bar)')
    expect(bar).not.toContain('env(')
  })

  it('is opaque and drawn with tokens', () => {
    const bar = rule('.ck-action-bar')
    expect(value(bar, 'background')).toBe('var(--ck-surface)')
    expect(value(bar, 'border-top')).toBe('1px solid var(--ck-border)')
    expect(value(bar, 'box-shadow')).toBe('0 var(--ck-safe-bottom) 0 var(--ck-surface)')
    expect(bar).not.toMatch(/opacity|transparent|color-mix|backdrop-filter/)
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgb|hsl|hwb|lab|lch|oklab|oklch)a?\(/i)
  })

  it('reads only tokens that the theme defines', () => {
    const used = [...new Set([...css.matchAll(/var\((--[a-z0-9-]+)/g)].map((match) => match[1]))].sort()
    expect(used).toEqual(['--ck-action-bar-room', '--ck-border', '--ck-bottom-occupied', '--ck-safe-bottom', '--ck-surface', '--ck-z-action-bar'])
    for (const name of used) expect(token(name), name).toBeDefined()
  })

  it('keeps a focused field and a link target above the bar', () => {
    expect(rule('html')).toBe('scroll-padding-bottom: calc(var(--ck-action-bar-room) + var(--ck-bottom-occupied));')
  })

  it('holds the only scroll padding of the project', () => {
    const sheets = (readdirSync(source, { recursive: true }) as string[]).map((path) => path.replaceAll('\\', '/'))
      .filter((path) => path.endsWith('.css') && !/(^|[/-])preview\//.test(path))
    expect(sheets).toContain('App.css')
    expect(sheets.filter((path) => /scroll-padding/.test(read(path)))).toEqual(['components/ActionBar.css'])
  })

  it('has no state rule, text size, !important or motion', () => {
    expect(css).not.toMatch(/:(hover|active|focus|focus-visible|focus-within|disabled)\b/)
    expect(css).not.toMatch(/font-size|!important|transition|animation|@keyframes/)
  })

  it('is imported by main.tsx right after App.css', () => {
    const imports = [...main.matchAll(/^import '(\.[^']+\.css)'$/gm)].map((match) => match[1])
    expect(imports).toEqual(['./theme/tokens.css', './App.css', './components/ActionBar.css'])
  })
})
