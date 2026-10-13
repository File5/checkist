import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import ResponsiveFilters, { ResponsiveFiltersView } from './ResponsiveFilters'
import { filtersButtonLabel } from './filters-label'

const form = <form className="screen-filters"><label>Магазин <select name="store" /></label><button type="submit">Показать</button></form>
const formHtml = renderToStaticMarkup(form)
const view = (narrow: boolean, open: boolean, count = 2, summary?: React.ReactNode) => renderToStaticMarkup(
  <ResponsiveFiltersView narrow={narrow} open={open} count={count} summary={summary} onOpen={() => {}} onClose={() => {}} sheetId="f1">{form}</ResponsiveFiltersView>,
)

describe('filters of a screen by the width of the window (Node server render)', () => {
  it('names the button by the number of active filters', () => {
    expect(filtersButtonLabel(0)).toBe('Фильтры')
    expect(filtersButtonLabel(3)).toBe('Фильтры (3)')
    expect(filtersButtonLabel(1, 'Период')).toBe('Период (1)')
  })

  it('draws the form of the screen unchanged and alone on a wide screen', () => {
    expect(view(false, false)).toBe(formHtml)
    // A server render sees the wide view (useNarrow), so the screens keep their server markup.
    expect(renderToStaticMarkup(<ResponsiveFilters count={2}>{form}</ResponsiveFilters>)).toBe(formHtml)
  })

  it('keeps the form behind «Фильтры (N)» on a phone while the sheet is closed', () => {
    const html = view(true, false)
    expect(html).toBe('<div class="ck-filters"><div class="ck-filters-bar"><button type="button" class="ck-filters-toggle" aria-haspopup="dialog" aria-expanded="false">Фильтры (2)</button></div></div>')
    expect(html).not.toContain('screen-filters')
  })

  it('opens the form in a sheet with «Готово», the button pointing at it', () => {
    const html = view(true, true)
    expect(html).toContain('aria-expanded="true" aria-controls="f1">Фильтры (2)</button>')
    expect(html).toContain('role="dialog" aria-modal="true"')
    expect(html).toContain('id="f1"')
    expect(html).toContain(`<div class="ck-filters-sheet">${formHtml}<button type="button" class="ck-button-secondary ck-filters-done">Готово</button></div>`)
  })

  it('keeps the chips of the active filters in sight beside the button', () => {
    expect(view(true, false, 1, <span className="chips">Пятёрочка</span>)).toContain('</button><div class="ck-filters-summary"><span class="chips">Пятёрочка</span></div>')
  })

  it('styles the phone view with tokens only and no width query of its own', () => {
    const css = readFileSync(new URL('./ResponsiveFilters.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
    expect(css).not.toMatch(/@media|#[0-9a-f]{3,8}\b|\b(?:rgb|hsl)a?\(|font-size|transition|animation/i)
    expect(css).toContain('min-height: 48px;')
  })
})
