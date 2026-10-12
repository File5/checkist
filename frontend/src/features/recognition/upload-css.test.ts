import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (name: string) => readFileSync(new URL(name, import.meta.url), 'utf8')
const css = read('./Upload.css').replace(/\/\*[\s\S]*?\*\//g, '')
const page = read('./UploadPage.tsx')

const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim(), body: match[2].trim() })))
const media = [...css.matchAll(/@media\s*([^{]+?)\s*\{((?:[^{}]*\{[^{}]*\})*)\s*\}/g)].map((match) => ({ query: match[1], rules: rules(match[2]) }))
const outside = rules(css.replace(/@media[^{]+\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, ''))
const everywhere = [...outside, ...media.flatMap((block) => block.rules)]
const rule = (selector: string, list = outside) => list.filter((item) => item.selector === selector).map((item) => item.body).join(' ')
const value = (body: string, property: string) => new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+);`).exec(body)?.[1].trim()

describe('upload stylesheet guards (text of the rules, not rendering)', () => {
  it('shows «Снять чек» and «Из галереи» only to a coarse pointer', () => {
    for (const selector of ['.ck-rec .ck-upload-camera', '.ck-rec .ck-upload-gallery']) {
      expect(value(rule(selector), 'display')).toBe('none')
      const shown = media.filter((block) => block.rules.some((item) => item.selector === selector))
      expect(shown.map((block) => block.query)).toEqual(['(pointer: coarse)'])
      expect(value(rule(selector, shown[0].rules), 'display')).toBe('block')
      // Nothing else of the sheet touches the button.
      expect(everywhere.filter((item) => item.selector.includes(selector.slice(8)))).toHaveLength(2)
    }
    // Besides the pointer, only the phone block: it never shows or hides anything.
    expect(media.map((block) => block.query)).toEqual(['(pointer: coarse)', '(max-width: 540px)'])
    expect(media[1].rules.filter((item) => /display|visibility/.test(item.body))).toEqual([])
    expect(page).toMatch(/className="ck-upload-camera"[^\n]*>\{uploadLabels\.camera\}<\/button>/)
    expect(page).toMatch(/className="ck-upload-gallery ck-upload-secondary"[^\n]*>\{uploadLabels\.gallery\}<\/button>/)
  })

  it('on a phone gives the preview the width of the form and makes the picking buttons large', () => {
    const phone = media[1].rules
    expect(value(rule('.ck-rec-image.ck-upload-preview img', phone), 'height')).toBe('auto')
    const big = rule('.ck-rec .ck-upload-pick button', phone)
    expect(value(big, 'width')).toBe('100%'); expect(Number.parseInt(value(big, 'min-height') ?? '0', 10)).toBeGreaterThanOrEqual(44)
  })

  it('takes every colour from the theme tokens', () => {
    expect(css.match(/#[0-9a-f]{3,8}\b|(?:rgb|hsl|hwb|lab|lch|oklab|oklch|color)a?\(/gi)).toBeNull()
    const coloured = everywhere.flatMap((item) => ['color', 'background', 'border-color', 'accent-color', 'border']
      .map((property) => value(item.body, property)).filter((found) => found !== undefined && found !== '0'))
    expect(coloured.length).toBeGreaterThan(0)
    for (const found of coloured) expect(found).toMatch(/var\(--ck-[a-z-]+\)$/)
  })

  it('keeps a value on one line and lets the file name wrap', () => {
    expect(value(rule('.ck-upload-value'), 'white-space')).toBe('nowrap')
    expect(everywhere.filter((item) => value(item.body, 'white-space') !== undefined).map((item) => item.selector)).toEqual(['.ck-upload-value'])
    expect(value(rule('.ck-upload-file'), 'overflow-wrap')).toBe('anywhere')
    expect(value(rule('.ck-upload-file'), 'min-width')).toBe('0')
  })

  it('hides the two file fields without removing them from the page', () => {
    const hidden = rule('.ck-rec .ck-upload-input')
    expect(value(hidden, 'position')).toBe('absolute'); expect(value(hidden, 'opacity')).toBe('0'); expect(value(hidden, 'pointer-events')).toBe('none')
    // display: none would make a phone ignore the press of the button.
    expect(hidden).not.toMatch(/display|visibility/)
  })

  it('adds no font size, motion or fixed width, and gives the outline button its own states', () => {
    expect(css).not.toMatch(/font-size|transition|animation|min-width:\s*[1-9]/)
    for (const state of [':hover:not(:disabled)', ':disabled']) expect(rule(`.ck-rec .ck-upload-secondary${state}`)).not.toBe('')
    expect(value(rule('.ck-upload-progress progress'), 'width')).toBe('100%')
  })

  it('is loaded by the screen itself, and the screen leaves the pinned bar to the shared class', () => {
    expect(page).toContain("import './Upload.css'")
    expect(css).not.toMatch(/ck-action-bar|position:\s*(sticky|fixed)/)
  })
})
