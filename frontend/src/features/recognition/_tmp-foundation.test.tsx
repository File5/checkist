/* mobile-foundation: temporary, integrator removes (with _tmp-foundation.tsx, .css and -state.ts) */
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import { ChipScroller, ResponsiveFilters, Sheet } from './_tmp-foundation'

describe('temporary copies of the foundation pieces (SSR)', () => {
  it('leaves the filters of a wide screen exactly as they were', () => {
    expect(renderToStaticMarkup(<ResponsiveFilters count={2}><label htmlFor="x">Статус</label><select id="x" /></ResponsiveFilters>))
      .toBe('<label for="x">Статус</label><select id="x"></select>')
  })
  it('draws a closed sheet with its title and a close button, its content in the document', () => {
    const html = renderToStaticMarkup(<Sheet open={false} onClose={vi.fn()} title="Фильтры"><p>Поля</p></Sheet>)
    expect(html).toMatch(/^<dialog class="ck-sheet" aria-labelledby="([^"]+)"><div class="ck-sheet-head"><h2 id="\1">Фильтры<\/h2><button type="button" class="ck-sheet-close">Закрыть<\/button><\/div><div class="ck-sheet-body"><p>Поля<\/p><\/div><\/dialog>$/)
  })
  it('draws a named, focusable row of chips', () => {
    expect(renderToStaticMarkup(<ChipScroller label="Категории"><li>А</li></ChipScroller>))
      .toBe('<div class="ck-chip-scroller" role="region" aria-label="Категории" tabindex="0"><ul class="ck-chip-scroller-list"><li>А</li></ul></div>')
  })
})
