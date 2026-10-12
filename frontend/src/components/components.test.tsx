import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import RequestState from './RequestState'
import Pagination from './Pagination'

describe('request state markup contract (Node, not browser interaction)', () => {
  it('draws a compact state without a card of its own, for use inside a panel', () => {
    expect(renderToStaticMarkup(<RequestState kind="empty" compact message="Трат пока нет." />))
      .toContain('<div class="request-state request-state-empty request-state-compact" aria-live="polite" aria-busy="false">')
    expect(renderToStaticMarkup(<RequestState kind="loading" />)).toContain('class="request-state request-state-loading"')
  })
  it('marks loading as busy and supplies a local message', () => {
    const html = renderToStaticMarkup(<RequestState kind="loading" />)
    expect(html).toContain('aria-live="polite"')
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('Загружаем данные…')
    expect(html).not.toContain('<button')
  })
  it('provides a safe default error, retry and a nonbusy state', () => {
    const html = renderToStaticMarkup(<RequestState kind="error" onRetry={() => {}} />)
    expect(html).toContain('Не удалось загрузить данные. Повторите попытку.')
    expect(html).toContain('aria-busy="false"')
    expect(html).toContain('type="button"')
    expect(html).toContain('Повторить</button>')
    expect(html).not.toContain('disabled')
  })
  it('supports an unavailable retry and an optional empty-state action', () => {
    expect(renderToStaticMarkup(<RequestState kind="error" onRetry={() => {}} retryDisabled />)).toContain('disabled')
    const empty = renderToStaticMarkup(<RequestState kind="empty" message="Нет результатов" action={<a href="/catalog">Сбросить фильтры</a>} />)
    expect(empty).toContain('Нет результатов')
    expect(empty).toContain('href="/catalog"')
    expect(empty).not.toContain('<button')
  })
  it('draws a titled empty state with its action in the slot of the card (mobile design 2026-10-12)', () => {
    const html = renderToStaticMarkup(<RequestState kind="empty" title="Ещё нет трат в октябре" message="Снимите чек или добавьте трату словами."
      action={<a className="action-link" href="/receipts/new">Добавить трату</a>} />)
    expect(html).toBe('<div class="request-state request-state-empty" aria-live="polite" aria-busy="false">'
      + '<p class="request-state-title"><strong>Ещё нет трат в октябре</strong></p><p>Снимите чек или добавьте трату словами.</p>'
      + '<div class="request-state-action"><a class="action-link" href="/receipts/new">Добавить трату</a></div></div>')
  })
  it('puts «Повторить» of an error first in the slot when the error has an action of its own', () => {
    const html = renderToStaticMarkup(<RequestState kind="error" title="Нет связи" onRetry={() => {}} action={<a href="/">На главную</a>} />)
    expect(html).toContain('<p class="request-state-title"><strong>Нет связи</strong></p>')
    expect(html).toContain('<div class="request-state-action"><button type="button" data-request-retry="true">Повторить</button><a href="/">На главную</a></div>')
    // Without an action the error keeps its former markup.
    expect(renderToStaticMarkup(<RequestState kind="error" onRetry={() => {}} />)).toBe('<div class="request-state request-state-error" aria-live="polite" aria-busy="false">'
      + '<p>Не удалось загрузить данные. Повторите попытку.</p><button type="button" data-request-retry="true">Повторить</button></div>')
  })
})

describe('pagination markup contract (Node, not keyboard runtime)', () => {
  const buildPageHref = (page: number) => ({ kind: 'category' as const, categoryId: 8, query: { q: 'молоко', generic: 2, page } })

  it('uses ordinary anchors, retains filters and marks exactly one current page', () => {
    const html = renderToStaticMarkup(<Pagination page={2} pages={3} buildPageHref={buildPageHref} label="Страницы товаров" />)
    expect(html).toContain('aria-label="Страницы товаров"')
    expect(html.match(/aria-current="page"/g)).toHaveLength(1)
    expect(html).toContain('aria-label="Страница 2" aria-current="page"')
    expect(html).toContain('generic=2&amp;page=3')
    expect(html).toContain('rel="prev"')
    expect(html).toContain('rel="next"')
    expect(html).not.toContain('<button')
  })
  it('omits unavailable directions and renders nothing for an empty list', () => {
    expect(renderToStaticMarkup(<Pagination page={1} pages={3} buildPageHref={buildPageHref} />)).not.toContain('rel="prev"')
    expect(renderToStaticMarkup(<Pagination page={3} pages={3} buildPageHref={buildPageHref} />)).not.toContain('rel="next"')
    expect(renderToStaticMarkup(<Pagination page={1} pages={0} buildPageHref={buildPageHref} />)).toBe('')
  })
})
