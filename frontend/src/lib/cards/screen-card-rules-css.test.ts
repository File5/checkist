import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const css = (path: string) => read(path).replace(/\/\*[\s\S]*?\*\//g, '')
const receipts = css('../../features/receipts/Receipts.css')
const recognition = css('../../features/recognition/Recognition.css')

/** Flat rules: a media block of these stylesheets holds whole rules. */
const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim().replace(/^@media[^{]*\{\s*/, ''), body: match[2].trim() })))
const rule = (text: string, selector: string) => rules(text).filter((item) => item.selector === selector).map((item) => item.body).join(' ')
const value = (body: string, property: string) => new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`).exec(body)?.[1].trim()
const outside = (text: string) => text.replace(/@media[^{]*\{(?:[^{}]*\{[^{}]*\})*\s*\}/g, '')

describe('screen rules that follow a row heading into its card (text of the rules, not rendering)', () => {
  it('keeps the gap above «Товар не сопоставлен» in the card of a receipt line equal to the one in the table', () => {
    const table = rule(receipts, '.receipt-lines-table th[scope="row"] > .receipt-warning')
    expect(table).toBe('display: block; margin-top: 8px;')
    expect(rule(outside(receipts), '.ck-card-title > .receipt-warning')).toBe(table)
    // The mark is a direct child of the heading in both views.
    expect(read('../../features/receipts/ReceiptContent.tsx')).toContain('<span className="receipt-warning">Товар не сопоставлен</span>')
  })

  it('keeps the other parts of a receipt line heading free of the table selector', () => {
    for (const selector of ['.receipt-note', '.receipt-printed-name', '.receipt-product-link', '.receipt-line-relation']) {
      expect(rule(outside(receipts), selector), selector).not.toBe('')
    }
  })

  it('puts the note of the confirm button 12px under its buttons on any width', () => {
    const gap = Number.parseInt(value(rule(recognition, '.ck-review'), 'gap') ?? '', 10)
    const before = Number.parseInt(value(rule(recognition, '.ck-rec-action-block'), 'gap') ?? '', 10)
    expect([gap, before]).toEqual([16, 12])
    const selector = '.ck-review > .ck-rec-action-block + .ck-rec-note'
    // Three classes outweigh `.ck-review p { margin: 0; }`; the rule stands outside the media blocks.
    expect(rule(outside(recognition), selector)).toBe(`margin-top: ${before - gap}px;`)
    expect(rule(recognition, '.ck-review p')).toBe('margin: 0;')
    expect(rules(recognition).filter((item) => item.selector === selector)).toHaveLength(1)
  })

  it('matches the markup of the form: the note is the next sibling of the button block, a child of the form', () => {
    const form = read('../../features/recognition/ReviewForm.tsx')
    expect(form).toMatch(/<div className="ck-rec-action-block ck-action-bar">\s*<div className="ck-rec-actions">[\s\S]*?<\/div>\s*<\/div>\s*<p id=\{dom\('confirm-note'\)\} className="ck-rec-note">/)
    expect(form).toMatch(/<section[^>]*className="ck-review"/)
  })
})
