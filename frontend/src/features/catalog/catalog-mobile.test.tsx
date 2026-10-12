import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Product } from '../../api/types'
import { category, product } from '../../api/test-support'
import { CategoryChips } from './CategoryLinks'
import { ProductRows } from './ProductList'

const css = readFileSync(new URL('./Catalog.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
const narrow = css.slice(css.indexOf('{', css.indexOf('@media (max-width: 540px)')) + 1)
const rules = (text: string) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
  .flatMap((match) => match[1].split(',').map((selector) => ({ selector: selector.trim(), body: match[2].trim() })))
const rule = (selector: string, text: string) => rules(text).filter((item) => item.selector === selector).map((item) => item.body).join(' ')

describe('phone view of the catalog (SSR markup and the text of the rules)', () => {
  it('draws the categories of the first level as one row of chips with their counts in figures', () => {
    const child = { ...category, id: 3, name: 'Сыры', parent_id: 2, depth: 2, path: [...category.path, { id: 3, name: 'Сыры' }], products_total: 12 }
    const html = renderToStaticMarkup(<CategoryChips categories={[category, child]} label="Категории" />)
    expect(html).toMatch(/^<div class="ck-chip-scroller" role="region" aria-label="Категории" tabindex="0"><ul class="ck-chip-scroller-list">/)
    expect(html).toContain('<a class="ck-chip" href="/catalog/categories/2">Молочные продукты<span class="ck-catalog-chip-count ck-figures">1</span></a>')
    // Deeper levels are chips of the category page, not of this row.
    expect(html).not.toContain('Сыры')
  })

  it('draws a product as a row: the name links the row, the last price stands at the right', () => {
    const html = renderToStaticMarkup(<ProductRows products={[product]} />)
    expect(html).toContain('<h3><a class="ck-catalog-row-link" href="/catalog/products/9">Молоко 850 мл</a></h3>')
    expect(html).toMatch(/<p class="ck-catalog-note">Пример · 850\sмл · Молоко<\/p>/u)
    expect(html).toMatch(/<div class="ck-catalog-row-prices"><p><span class="ck-catalog-price">[^<]*EUR<\/span><span class="ck-catalog-note">DE · <time dateTime="2026-10-04">/)
    const empty: Product = { ...product, brand: null, package: null, prices: [] }
    const bare = renderToStaticMarkup(<ProductRows products={[empty]} />)
    expect(bare).toContain('<p class="ck-catalog-note">Молоко</p>'); expect(bare).toContain('Покупок нет')
  })

  it('pins the search on a phone, prints the price in the figures font and keeps rows at least 56 px high', () => {
    const sticky = rule('.ck-catalog-search.ck-catalog-panel', narrow)
    expect(sticky).toContain('position: sticky;'); expect(sticky).toContain('top: 0;'); expect(sticky).toContain('z-index: var(--ck-z-action-bar);')
    expect(rule('.ck-catalog-price', css)).toContain('font-family: var(--ck-font-figures);')
    expect(rule('.ck-catalog-row', css)).toContain('min-height: 56px;')
    // The help of the search is hidden from sight only: no display or visibility.
    expect(rule('.ck-catalog-search > .ck-catalog-search-field:first-child > .ck-catalog-note', narrow)).not.toMatch(/display|visibility/)
  })
})
