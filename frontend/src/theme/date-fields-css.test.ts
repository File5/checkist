import { readdirSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = new URL('../', import.meta.url)
const raw = (path: string) => readFileSync(new URL(path, source), 'utf8')
const read = (path: string) => raw(path).replace(/\/\*[\s\S]*?\*\//g, '')
const app = read('App.css')
/** Rules outside of any media block. */
const wide = app.slice(0, app.indexOf('@media'))

const files = (readdirSync(source, { recursive: true }) as string[]).map((path) => path.replaceAll('\\', '/'))
const preview = (path: string) => /(^|[/-])preview\//.test(path)

/** Fields that iOS Safari draws by its own look, wider than their box. */
const kinds = ['date', 'datetime-local', 'time', 'month', 'week']
const kind = kinds.join('|')
/** `type="date"`, `{ type: 'date' }` and the last argument of a local `input(field, label, 'date')`. */
const written = new RegExp(`type(?:=|:\\s*)["'](${kind})["']|,\\s*'(${kind})'\\)\\}`, 'g')

/** One rule by its whole selector; a selector with commas inside :where() is not split. */
const body = (selector: string, text: string) => {
  const start = text.indexOf(`\n${selector} {`)
  return start < 0 ? '' : text.slice(start + selector.length + 3, text.indexOf('}', start)).trim()
}

describe('fields of a date keep the width of their panel (text of the rules and the screens, not rendering)', () => {
  const selector = `:where(${kinds.map((name) => `input[type="${name}"]`).join(', ')})`

  it('knows every field of a date of the client', () => {
    // A new field of this kind, or a new kind, comes here first: the general rule below must reach it.
    const found = files.filter((path) => path.endsWith('.tsx') && !path.includes('.test.') && !preview(path))
      .flatMap((path) => [...raw(path).matchAll(written)].map((match) => `${path}: ${match[1] ?? match[2]}`))
    expect(found.sort()).toEqual([
      'features/product/ProductPage.tsx: date',
      'features/receipts/ReceiptFilters.tsx: date',
      'features/receipts/ReceiptFilters.tsx: date',
      'features/recognition/ReviewForm.tsx: date',
      'features/stats/receipts-filters.tsx: date',
      'features/stats/spending-filters.tsx: date',
    ])
    for (const item of found) expect(kinds).toContain(item.split(': ')[1])
  })

  it('takes the own look of iOS off every such field in one general rule', () => {
    const rule = body(selector, wide)
    expect(rule).toBe('-webkit-appearance: none; appearance: none; box-sizing: border-box; min-width: 0; max-width: 100%;')
    // The rule stands outside of any media block: the fault is of the browser, not of the width.
    expect(app.split(`${selector} {`)).toHaveLength(2)
  })

  it('weighs nothing, so the width, the frame and the padding of a screen stay', () => {
    // App.css follows the screen stylesheets in the build: only :where() leaves their rules of a field in force.
    expect(selector.startsWith(':where(') && selector.endsWith(')')).toBe(true)
    expect(selector.slice(7, -1)).not.toContain(')')
  })

  it('keeps the height of the field without the own look: an empty one would collapse on iOS', () => {
    expect(body('input, select', wide)).toBe('min-height: 44px; max-width: 100%;')
    expect(app.indexOf(`\n${selector} {`)).toBeGreaterThan(app.indexOf('\ninput, select {'))
  })

  it('puts the value at the left like the text of the other fields', () => {
    expect(body('input::-webkit-date-and-time-value', wide)).toBe('text-align: left;')
  })

  it('lets no screen bring the own look or a least width back', () => {
    const sheets = files.filter((path) => path.endsWith('.css') && path !== 'App.css' && !preview(path))
    expect(sheets).toContain('features/receipts/Receipts.css')
    expect(sheets.filter((path) => /(^|[\s;{-])appearance\s*:/.test(read(path)))).toEqual([])
    expect(sheets.filter((path) => new RegExp(`type="(${kind})"`).test(read(path)))).toEqual([])
  })
})
