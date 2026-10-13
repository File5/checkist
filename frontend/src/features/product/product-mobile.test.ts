import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')
const page = read('./ProductPage.tsx')
const css = read('./Product.css').replace(/\/\*[\s\S]*?\*\//g, '')
const narrow = css.slice(css.indexOf('{', css.indexOf('@media (max-width: 540px)')) + 1)

describe('phone view of the product card (text of the files, not rendering)', () => {
  it('puts the whole filter form behind «Фильтры (N)», the pinned bar stays inside the form', () => {
    expect(page).toMatch(/<ResponsiveFilters count=\{\[query\.store, query\.country, query\.currency, query\.date_from, query\.date_to\][^\n]*title="Фильтры истории и сводки">\s*<form ref=\{formRef\}/)
    expect(page.indexOf('</ResponsiveFilters>')).toBeGreaterThan(page.indexOf('<div className="product-actions ck-action-bar">'))
  })
  it('gives «График цен» the full width of its card on a phone', () => {
    const bleed = /\.product-panel > \.product-chart-panel \{([^}]*)\}/.exec(narrow)?.[1] ?? ''
    expect(bleed).toContain('max-width: none;'); expect(bleed).toContain('margin-inline: -20px;')
    // The padding of the card on a phone is the one the panel lies over.
    expect(narrow).toContain('.product-panel { padding: 20px; }')
  })
})
