import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getProductClassifications } from '../../api/product-classifications'
import type { Classification } from '../../api/product-classifications'
import type { Me } from '../../api/session'
import { detail, pageOf as productsOf, product } from '../../api/test-support'
import { applyMe } from '../../session'
import { resetSession } from '../../session/store'
import ProductList from '../catalog/ProductList'
import ProductsSection from '../catalog/ProductsSection'
import { pendingTargets } from '../merges/state'
import { groups } from '../merges/test-support'
import ProductPage from '../product/ProductPage'
import * as productRequests from '../product/useProductRequest'
import type { RequestState } from '../recognition/polling'
import { markFor, marksOf, pendingMarks } from './marks'
import { failed, pageOf, record, records, success } from './test-support'

type Load = (signal: AbortSignal) => Promise<unknown>
const mocked = vi.hoisted(() => ({ states: [] as RequestState<unknown>[], loads: [] as unknown[][] }))
vi.mock('../recognition/useRequest', () => ({ useRequest: (...parameters: unknown[]) => {
  mocked.loads.push(parameters)
  return {
    state: mocked.states.shift() ?? { kind: 'loading' },
    request: { pause: vi.fn(), resume: vi.fn(), setData: vi.fn(), refresh: vi.fn(), queueRefresh: vi.fn() },
  }
} }))
// «Я» as the server answers: without accounts everyone moderates, with them — only the holder of the right.
const me = (mode: Me['mode'], moderate_catalog: boolean): Me =>
  ({ mode, user: { id: 3, username: 'anna', is_staff: false }, permissions: { moderate_catalog }, csrf_token: 'token' })
const local = me('local_single', true)
const moderator = me('accounts', true)
const reader = me('accounts', false)
// The former markup is the markup of local_single: the real store of the session holds it in every test.
beforeEach(() => { mocked.states = []; mocked.loads = []; applyMe(local) })
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); resetSession() })

const noop = () => {}
const loading = { kind: 'loading' as const }
// The backend fixture: products 11 and 12 wait in «Кефир» (93), 13 in «Колбаса» (94) with a new category, 14 in «Молоко» (92).
const kefir = { ...product, id: 11, name: 'Demo Kefir mild 500g', generic: { id: 93, name: 'Кефир', base_unit: 'l' as const } }
const sausage = { ...product, id: 13, name: 'Demo Mettwurst fein', generic: { id: 94, name: 'Колбаса', base_unit: 'kg' as const } }
const plain = { ...product, id: 77, name: 'Demo Butter' }
const route = { kind: 'catalog' as const, query: { q: 'demo', page: 1 } }
const badge = 'Категория: требует подтверждения'
const refusals: [string, RequestState<unknown>][] = [
  ['is switched off', failed('permission_denied', 403)], ['does not answer', failed('network')], ['times out', failed('timeout')],
  ['fails', failed('server', 500)], ['answers in another format', failed('invalid_response')], ['is still loading', loading],
]
/** What one of the mark hooks asked `useRequest` for; the hooks run in a fixed order: duplicates, then categories. */
const sent = async (index: number) => {
  const urls: string[] = []
  vi.stubGlobal('fetch', vi.fn(async (input: string | URL) => { urls.push(String(input)); return new Response('{}', { status: 500 }) }))
  await (mocked.loads[index][0] as Load)(new AbortController().signal)
  return { urls, parameters: mocked.loads[index] }
}

describe('marks of pending records', () => {
  it('maps every pending record to its product and suggestion', () => {
    const marks = pendingMarks(records().results)
    expect([...marks.keys()]).toEqual([11, 12, 13, 14])
    expect(marks.get(13)).toEqual({ productId: 13, generic: { id: 94, name: 'Колбаса' }, category: record('classification-pending.json').suggested.category })
  })
  it('ignores decided records', () => {
    const decided = ['classification-confirmed.json', 'classification-confirmed-other.json', 'classification-rejected.json', 'classification-superseded.json'].map(record)
    expect(pendingMarks(decided).size).toBe(0)
  })
  it('gives a mark only while the product still has the suggested generic product', () => {
    const marks = pendingMarks(records().results)
    expect(markFor(marks, kefir)?.generic.name).toBe('Кефир')
    expect(markFor(marks, { ...kefir, generic: { ...kefir.generic, id: 92 } })).toBeUndefined()
    expect(markFor(marks, plain)).toBeUndefined()
    expect(markFor(undefined, kefir)).toBeUndefined()
  })
  it.each(refusals)('has no marks when the local API %s', (_name, state) => {
    expect(marksOf(state as RequestState<never>).size).toBe(0)
  })
})

describe('catalog list marks', () => {
  it('marks a product with a pending record with a link to its records', () => {
    const html = renderToStaticMarkup(<ProductList products={[kefir, plain]} classifications={pendingMarks(records().results)} />)
    expect(html.match(/class="ck-class-badge"/g)).toHaveLength(1)
    expect(html).toContain(`Demo Kefir mild 500g</a></h3><p class="ck-class-badge"><a href="/catalog/classification?product=11">${badge}</a></p>`)
    expect(html).toContain('href="/catalog/products/77"')
  })
  it('keeps the link for a moderator of accounts: the markup is the one of local_single', () => {
    const render = () => renderToStaticMarkup(<ProductList products={[kefir, plain]} classifications={pendingMarks(records().results)} />)
    const former = render()
    applyMe(moderator)
    expect(render()).toBe(former)
    expect(former).toContain(`<a href="/catalog/classification?product=11">${badge}</a>`)
  })
  it.each([
    ['a user without the right', () => applyMe(reader)], ['a guest', () => applyMe(null)], ['an unknown session', resetSession],
  ])('shows the mark as text without a link to %s', (_name, enter) => {
    enter()
    const html = renderToStaticMarkup(<ProductList products={[kefir, plain]} classifications={pendingMarks(records().results)} />)
    expect(html).toContain(`Demo Kefir mild 500g</a></h3><p class="ck-class-badge"><span>${badge}</span></p>`)
    expect(html).not.toContain('/catalog/classification')
    expect(html).toContain('href="/catalog/products/11"'); expect(html).toContain('href="/catalog/products/77"')
  })
  it('shows both marks as text to a user without the right', () => {
    applyMe(reader)
    const both = { ...kefir, id: 5 }
    const classifications = pendingMarks(records().results.map((item): Classification => item.product.id === 11 ? { ...item, product: { ...item.product, id: 5 } } : item))
    const html = renderToStaticMarkup(<ProductList products={[both]} merges={pendingTargets(groups().results)} classifications={classifications} />)
    expect(html).toContain(`<p class="ck-merge-badge"><span>Дубли: требует подтверждения</span></p><p class="ck-class-badge"><span>${badge}</span></p>`)
    expect(html).not.toContain('/catalog/merges'); expect(html).not.toContain('/catalog/classification')
  })
  it('shows no mark when the catalog product has another generic product than the suggested one', () => {
    const moved = { ...kefir, generic: { id: 92, name: 'Молоко', base_unit: 'l' as const } }
    const html = renderToStaticMarkup(<ProductList products={[moved, sausage]} classifications={pendingMarks(records().results)} />)
    expect(html.match(/class="ck-class-badge"/g)).toHaveLength(1)
    expect(html).toContain('href="/catalog/classification?product=13"')
    expect(html).not.toContain('href="/catalog/classification?product=11"')
  })
  it('renders the same list without marks when none are given', () => {
    const bare = renderToStaticMarkup(<ProductList products={[kefir, plain]} />)
    expect(bare).not.toContain('ck-class-badge')
    expect(renderToStaticMarkup(<ProductList products={[kefir, plain]} classifications={new Map()} />)).toBe(bare)
  })
  it('keeps the mark of duplicates next to the mark of the category', () => {
    const both = { ...kefir, id: 5 }
    const classifications = pendingMarks(records().results.map((item): Classification => item.product.id === 11 ? { ...item, product: { ...item.product, id: 5 } } : item))
    const html = renderToStaticMarkup(<ProductList products={[both]} merges={pendingTargets(groups().results)} classifications={classifications} />)
    expect(html).toContain(`<p class="ck-merge-badge"><a href="/catalog/merges/2">Дубли: требует подтверждения</a></p><p class="ck-class-badge"><a href="/catalog/classification?product=5">${badge}</a></p>`)
  })
  it('loads the marks next to the products of the section with its own request', async () => {
    mocked.states = [loading, success(records())]
    const html = renderToStaticMarkup(<ProductsSection route={route} state={{ kind: 'ok', data: productsOf([kefir, sausage, plain]) }} onRetry={noop} />)
    expect(html.match(/class="ck-class-badge"/g)).toHaveLength(2)
    expect(html).toContain('Найдено товаров: 3')
    expect(mocked.loads).toHaveLength(2)
    const { urls, parameters } = await sent(1)
    expect(urls).toEqual(['/api/product-classifications/?status=pending&page_size=200'])
    // No polling predicate is passed: the marks are read once and never repeated.
    expect(parameters).toHaveLength(1)
  })
  it.each(refusals)('shows the catalog without marks and without messages when the local API %s', (_name, marks) => {
    const render = () => renderToStaticMarkup(<ProductsSection route={route} state={{ kind: 'ok', data: productsOf([kefir, plain]) }} onRetry={noop} />)
    mocked.states = [loading, marks]
    const html = render()
    mocked.states = [loading, success(pageOf([]))]
    expect(html).toBe(render())
    expect(html).toContain('href="/catalog/products/11"'); expect(html).toContain('Найдено товаров: 2')
    expect(html).not.toContain('ck-class-badge'); expect(html).not.toContain('Категория:')
    expect(html).not.toContain('Локальный API'); expect(html).not.toContain('Повторить'); expect(html).not.toContain('role="alert"')
  })
  it('keeps the marks of duplicates when only the request of categories fails, and the other way round', () => {
    const kept = { ...product, id: 5, name: 'Steinhof.PizzaSpezial' }
    const render = () => renderToStaticMarkup(<ProductsSection route={route} state={{ kind: 'ok', data: productsOf([kept, kefir]) }} onRetry={noop} />)
    mocked.states = [success(groups()), failed('permission_denied', 403)]
    let html = render()
    expect(html).toContain('ck-merge-badge'); expect(html).not.toContain('ck-class-badge')
    mocked.states = [failed('network'), success(records())]
    html = render()
    expect(html).not.toContain('ck-merge-badge'); expect(html).toContain('ck-class-badge')
  })
  it.each([
    ['loading', { kind: 'loading' as const }, 'Загружаем товары…'],
    ['failed', { kind: 'error' as const, reason: 'network' as const }, 'Не удалось связаться с сервером'],
    ['empty', { kind: 'ok' as const, data: productsOf<typeof product>([]) }, 'Сбросить фильтры'],
  ])('keeps the %s state of the catalog independent of successful marks', (_name, state, text) => {
    mocked.states = [loading, success(records())]
    const html = renderToStaticMarkup(<ProductsSection route={route} state={state} onRetry={noop} />)
    expect(html).toContain(text); expect(html).not.toContain('ck-class-badge')
  })
})

describe('product card marks', () => {
  const card = (state: unknown, productId: number) => {
    vi.spyOn(productRequests, 'useProductRequest')
      .mockReturnValueOnce({ state, retry: noop } as ReturnType<typeof productRequests.useProductRequest>).mockReturnValue({ state: loading, retry: noop })
    return renderToStaticMarkup(<ProductPage productId={productId} query={{ page: 1 }} />)
  }
  const section = (html: string) => html.match(/<section[^>]*aria-labelledby="product-heading"[^>]*>[\s\S]*?<\/section>/)?.[0] ?? ''
  const own = (productId: number) => pageOf(records().results.filter((item) => item.product.id === productId))
  const sausageCard = { kind: 'ok', data: { ...detail, ...sausage } }
  const notice = 'Категория предложена автоматически'

  it('announces the suggested category with a link to the records of the product', async () => {
    mocked.states = [loading, success(own(13))]
    const html = section(card(sausageCard, 13))
    expect(html).toContain('<p>Категория предложена автоматически: „Колбаса“ (Продукты питания → Мясные продукты) — требует подтверждения. '
      + 'Товар уже участвует в сравнении цен по этому обобщённому продукту.</p>')
    expect(html).toContain('<a class="action-link" href="/catalog/classification?product=13">Открыть в списке категорий</a>')
    expect(html.match(/Категория предложена/g)).toHaveLength(1)
    expect(html).toContain('<dt>Бренд</dt>'); expect(html).toContain('Назад в категорию')
    const { urls, parameters } = await sent(1)
    expect(urls).toEqual(['/api/product-classifications/?product=13&status=pending'])
    expect(parameters).toHaveLength(1)
  })
  it('keeps the notice and its link for a moderator of accounts', () => {
    const render = () => { mocked.states = [loading, success(own(13))]; return section(card(sausageCard, 13)) }
    const former = render()
    applyMe(moderator)
    expect(render()).toBe(former)
    expect(former).toContain('href="/catalog/classification?product=13">Открыть в списке категорий</a>')
  })
  it('announces the suggested category to a user without the right as text without a link', () => {
    applyMe(reader)
    mocked.states = [loading, success(own(13))]
    const html = section(card(sausageCard, 13))
    expect(html).toContain('<p>Категория предложена автоматически: „Колбаса“ (Продукты питания → Мясные продукты) — требует подтверждения. '
      + 'Товар уже участвует в сравнении цен по этому обобщённому продукту.</p></div>')
    expect(html).not.toContain('/catalog/classification'); expect(html).not.toContain('Открыть в списке категорий')
    expect(html).toContain('<dt>Бренд</dt>'); expect(html).toContain('Назад в категорию')
  })
  it('names a missing category and an empty name in words', () => {
    const damaged = own(13).results.map((item): Classification => ({ ...item, suggested: { ...item.suggested, category: null, generic: { ...item.suggested.generic, name: ' ' } } }))
    mocked.states = [loading, success(pageOf(damaged))]
    expect(section(card(sausageCard, 13))).toContain('„Не указано“ (Категория не указана) — требует подтверждения.')
  })
  it('shows no notice when the card has another generic product than the suggested one', () => {
    mocked.states = [loading, success(own(13))]
    const html = card({ kind: 'ok', data: { ...detail, ...sausage, generic: { id: 5, name: 'Молоко', base_unit: 'l' } } }, 13)
    expect(html).not.toContain(notice); expect(section(html)).toContain('<dt>Бренд</dt>')
  })
  it('shows no notice on a product without a pending record', () => {
    mocked.states = [loading, success(pageOf([]))]
    expect(card({ kind: 'ok', data: detail }, 9)).not.toContain(notice)
    mocked.states = [loading, success(pageOf([record('classification-confirmed.json'), record('classification-rejected.json')]))]
    expect(card({ kind: 'ok', data: { ...detail, ...kefir } }, 11)).not.toContain(notice)
  })
  it.each(refusals)('shows the card without the notice and without messages when the local API %s', (_name, marks) => {
    mocked.states = [loading, marks]
    const html = card(sausageCard, 13)
    mocked.states = [loading, success(pageOf([]))]
    expect(html).toBe(card(sausageCard, 13))
    expect(section(html)).toContain('<dt>Бренд</dt>'); expect(section(html)).toContain('Назад в категорию')
    expect(html).not.toContain(notice); expect(html).not.toContain('Локальный API'); expect(html).not.toContain('Повторить')
    expect(html).toContain('Загружаем историю покупок…')
  })
  it.each([
    ['is loading', loading, 'Загружаем карточку товара…'], ['is not found', { kind: 'error', reason: 'not_found', status: 404 }, 'Товар не найден'],
    ['fails', { kind: 'error', reason: 'network' }, 'Повторить'],
  ])('adds nothing while the card itself %s', (_name, state, text) => {
    mocked.states = [loading, success(own(13))]
    const html = card(state, 13)
    expect(html).toContain(text); expect(html).not.toContain(notice)
  })
  it('keeps the notice of duplicates next to the notice of the category', () => {
    const moved = own(13).results.map((item): Classification => ({ ...item, product: { ...item.product, id: 5 } }))
    mocked.states = [success(groups()), success(pageOf(moved))]
    const html = section(card({ kind: 'ok', data: { ...detail, ...sausage, id: 5 } }, 5))
    expect(html).toContain('Предварительно объединено 3\u00a0написания'); expect(html).toContain('href="/catalog/classification?product=5"')
  })
})

describe('request of the marks through the real adapter', () => {
  it('turns the answer of a switched-off local API into a plain failure the marks ignore', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ error: { code: 'permission_denied', message: 'Доступ запрещён.' } }, { status: 403 })))
    const result = await getProductClassifications({ status: 'pending', page_size: 200 })
    expect(result).toEqual({ kind: 'error', reason: 'permission_denied', status: 403 })
    expect(marksOf({ kind: 'error', error: result as never }).size).toBe(0)
  })
})
