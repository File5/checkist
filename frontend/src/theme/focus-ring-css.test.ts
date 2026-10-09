import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = new URL('../', import.meta.url)
const raw = (path: string) => readFileSync(new URL(path, source), 'utf8')
const read = (path: string) => raw(path).replace(/\/\*[\s\S]*?\*\//g, '')
const app = read('App.css')

const files = (readdirSync(source, { recursive: true }) as string[]).map((path) => path.replaceAll('\\', '/'))
const preview = (path: string) => /(^|[/-])preview\//.test(path)
const sheets = files.filter((path) => path.endsWith('.css') && !preview(path))

/** Flat rules: a media block of these stylesheets holds whole rules. */
const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim(), body: match[2].trim() })))
const rule = (selector: string, text: string) => rules(text).filter((item) => item.selector === selector).map((item) => item.body).join(' ')

/** Specificity as [classes + attributes + pseudo-classes, elements]; none of these selectors uses :where() or an id. */
const weight = (selector: string): [number, number] => {
  const text = selector.replace(/::[\w-]+/g, '')
  const high = text.match(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g) ?? []
  const low = text.replace(/\.[\w-]+|\[[^\]]*\]|:[\w-]+/g, ' ').match(/[a-z][\w-]*/gi) ?? []
  return [high.length, low.length]
}
const heavier = (one: string, other: string) => {
  const [a, b] = [weight(one), weight(other)]
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])
}

const general = ['button:focus-visible', 'a:focus-visible', 'input:focus-visible', 'select:focus-visible', '[tabindex]:focus-visible']
const heading = 'h1[tabindex="-1"]:focus-visible'
const removes = (body: string) => /(^|[;\s])outline(-width|-style)?\s*:\s*(none|0)\b/.test(body)

describe('focus ring of the heading of the page (text of the rules and the shell, not rendering)', () => {
  it('is not drawn: the heading is focused by script only', () => {
    expect(rule(heading, app)).toBe('outline: none;')
    // Heavier than the general ring and written after it; the header and the sign-in do not reach an h1 with a ring.
    expect(heavier(heading, '[tabindex]:focus-visible')).toBe(true)
    expect(app.indexOf(`${heading} {`)).toBeGreaterThan(app.indexOf('[tabindex]:focus-visible {'))
  })

  it('belongs to the two headings of the shell, which no person reaches with Tab', () => {
    const screens = files.filter((path) => path.endsWith('.tsx') && !path.includes('.test.') && !preview(path))
    const found = screens.flatMap((path) => [...raw(path).matchAll(/<h1\b[^>]*>/g)].map((match) => `${path}: ${match[0]}`))
    // The page, and the sign-in drawn in place of it. The focus itself stays: `heading.current?.focus()`.
    expect(found).toEqual(Array(2).fill('App.tsx: <h1 id="page-heading" ref={heading} tabIndex={-1}>'))
    expect(raw('App.tsx')).toContain('heading.current?.focus()')
  })

  it('gets a ring from no stylesheet of a screen', () => {
    const own = sheets.flatMap((path) => rules(read(path)).filter((item) => /(^|[\s>+~])h1(?![\w-])[^,]*:focus/.test(item.selector) && !removes(item.body))
      .map((item) => `${path}: ${item.selector}`))
    expect(own).toEqual([])
  })
})

describe('focus ring of what a person reaches with Tab (text of the rules, not rendering)', () => {
  it('stays as it was in the general rule', () => {
    for (const selector of general) expect(rule(selector, app), selector).toBe('outline: 3px solid var(--ck-focus); outline-offset: 4px;')
  })

  it('is taken off by the heading of the page alone, in every stylesheet of the client', () => {
    // Links, buttons, fields, radios, the scroll region of a table (tabindex="0"), the plot of a chart, and the
    // script-only targets other than the heading (a result, a status, the card of a receipt line) keep their ring.
    const off = sheets.flatMap((path) => rules(read(path)).filter((item) => /:focus/.test(item.selector) && removes(item.body))
      .map((item) => `${path}: ${item.selector}`))
    expect(off).toEqual([`App.css: ${heading}`])
  })

  it('reaches only an h1 with tabindex="-1": no heading of a block, no legend, no status', () => {
    const limited = rules(app).filter((item) => /\[tabindex="-1"\]/.test(item.selector)).map((item) => item.selector)
    expect(limited).toEqual([heading])
  })
})
