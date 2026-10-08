import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Me } from '../../api/session'
import { detail, pageOf, product } from '../../api/test-support'
import type { NavigationSnapshot } from '../../navigation'
import App from '../../App'
import { applyMe } from '../../session'
import { resetSession } from '../../session/store'
import ProductList from '../catalog/ProductList'
import ProductsSection from '../catalog/ProductsSection'
import ProductPage from '../product/ProductPage'
import * as productRequests from '../product/useProductRequest'
import type { RequestState } from '../recognition/polling'
import { errorText } from './labels'
import { pendingTargets } from './state'
import { failed, groups, success } from './test-support'

const mocked = vi.hoisted(() => ({ states: [] as RequestState<unknown>[], snapshot: undefined as NavigationSnapshot | undefined }))
vi.mock('../recognition/useRequest', () => ({ useRequest: () => ({
  state: mocked.states.shift() ?? { kind: 'loading' },
  request: { pause: vi.fn(), resume: vi.fn(), setData: vi.fn(), refresh: vi.fn(), queueRefresh: vi.fn() },
}) }))
vi.mock('../../navigation', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../navigation')>(),
  useNavigation: () => mocked.snapshot,
}))
// «Я» as the server answers: without accounts everyone moderates, with them — only the holder of the right.
const me = (mode: Me['mode'], moderate_catalog: boolean): Me =>
  ({ mode, user: { id: 3, username: 'anna', is_staff: false }, permissions: { moderate_catalog }, csrf_token: 'token' })
const local = me('local_single', true)
const moderator = me('accounts', true)
const reader = me('accounts', false)
// The former markup is the markup of local_single: the real store of the session holds it in every test.
beforeEach(() => { mocked.states = []; mocked.snapshot = undefined; applyMe(local) })
afterEach(() => { vi.restoreAllMocks(); resetSession() })

const noop = () => {}
const loading = { kind: 'loading' as const }
// In the backend fixture the pending group 2 keeps product 5 and absorbs 26 and 43; group 1 is confirmed: 2 kept, 14 and 36 deleted.
const kept = { ...product, id: 5, name: 'Steinhof.PizzaSpezial' }
const other = { ...product, id: 77, name: 'Pizza Hot Dog' }
const route = { kind: 'catalog' as const, query: { q: 'pizza', page: 1 } }

describe('catalog list marks', () => {
  it('marks the kept product of a pending group with a link to the group', () => {
    const html = renderToStaticMarkup(<ProductList products={[kept, other]} merges={pendingTargets(groups().results)} />)
    expect(html.match(/class="ck-merge-badge"/g)).toHaveLength(1)
    expect(html).toContain('Steinhof.PizzaSpezial</a></h3><p class="ck-merge-badge"><a href="/catalog/merges/2">Дубли: требует подтверждения</a></p>')
    expect(html).toContain('href="/catalog/products/77"')
  })
  it('keeps the link for a moderator of accounts: the markup is the one of local_single', () => {
    const render = () => renderToStaticMarkup(<ProductList products={[kept, other]} merges={pendingTargets(groups().results)} />)
    const former = render()
    applyMe(moderator)
    expect(render()).toBe(former)
    expect(former).toContain('<a href="/catalog/merges/2">Дубли: требует подтверждения</a>')
  })
  it.each([
    ['a user without the right', () => applyMe(reader)], ['a guest', () => applyMe(null)], ['an unknown session', resetSession],
  ])('shows the mark as text without a link to %s', (_name, enter) => {
    enter()
    const html = renderToStaticMarkup(<ProductList products={[kept, other]} merges={pendingTargets(groups().results)} />)
    expect(html).toContain('Steinhof.PizzaSpezial</a></h3><p class="ck-merge-badge"><span>Дубли: требует подтверждения</span></p>')
    expect(html).not.toContain('/catalog/merges')
    expect(html).toContain('href="/catalog/products/5"'); expect(html).toContain('href="/catalog/products/77"')
  })
  it('shows the mark of the section as text to a user without the right', () => {
    applyMe(reader)
    mocked.states = [success(groups())]
    const html = renderToStaticMarkup(<ProductsSection route={route} state={{ kind: 'ok', data: pageOf([kept, other]) }} onRetry={noop} />)
    expect(html).toContain('<p class="ck-merge-badge"><span>Дубли: требует подтверждения</span></p>')
    expect(html).not.toContain('/catalog/merges'); expect(html).toContain('Найдено товаров: 2')
  })
  it('renders the same list without marks when none are given', () => {
    const plain = renderToStaticMarkup(<ProductList products={[kept, other]} />)
    expect(plain).not.toContain('ck-merge-badge')
    expect(renderToStaticMarkup(<ProductList products={[kept, other]} merges={new Map()} />)).toBe(plain)
  })
  it('loads marks next to the products of the section', () => {
    mocked.states = [success(groups())]
    const html = renderToStaticMarkup(<ProductsSection route={route} state={{ kind: 'ok', data: pageOf([kept, other]) }} onRetry={noop} />)
    expect(html).toContain('href="/catalog/merges/2">Дубли: требует подтверждения</a>')
    expect(html).toContain('Найдено товаров: 2')
  })
  it.each([
    ['is switched off', failed('permission_denied', 403)], ['does not answer', failed('network')],
    ['fails', failed('server', 500)], ['is still loading', loading],
  ])('shows the catalog without marks when the local API %s', (_name, marks) => {
    mocked.states = [marks]
    const html = renderToStaticMarkup(<ProductsSection route={route} state={{ kind: 'ok', data: pageOf([kept, other]) }} onRetry={noop} />)
    expect(html).toContain('href="/catalog/products/5"'); expect(html).toContain('href="/catalog/products/77"')
    expect(html).toContain('Найдено товаров: 2')
    expect(html).not.toContain('ck-merge-badge')
    expect(html).not.toContain('Локальный API'); expect(html).not.toContain('Повторить')
  })
  it('keeps the product error of the catalog independent of successful marks', () => {
    mocked.states = [success(groups())]
    const html = renderToStaticMarkup(<ProductsSection route={route} state={{ kind: 'error', reason: 'network' }} onRetry={noop} />)
    expect(html).toContain('Не удалось связаться с сервером'); expect(html).not.toContain('ck-merge-badge')
  })
})

describe('product card marks', () => {
  const card = (state: unknown, productId: number) => {
    vi.spyOn(productRequests, 'useProductRequest')
      .mockReturnValueOnce({ state, retry: noop } as ReturnType<typeof productRequests.useProductRequest>).mockReturnValue({ state: loading, retry: noop })
    return renderToStaticMarkup(<ProductPage productId={productId} query={{ page: 1 }} />)
  }
  const section = (html: string) => html.match(/<section[^>]*aria-labelledby="product-heading"[^>]*>[\s\S]*?<\/section>/)?.[0] ?? ''

  it('announces the preliminary merge on the kept product with a link to the group', () => {
    mocked.states = [success(groups())]
    const html = section(card({ kind: 'ok', data: { ...detail, id: 5, name: 'Steinhof.PizzaSpezial' } }, 5))
    expect(html).toContain('Предварительно объединено 3 написания — требует подтверждения')
    expect(html).toContain('href="/catalog/merges/2">Открыть группу дублей №2</a>')
    expect(html).toContain('<dt>Бренд</dt>')
  })
  it('keeps the notice and its link for a moderator of accounts', () => {
    const render = () => { mocked.states = [success(groups())]; return section(card({ kind: 'ok', data: { ...detail, id: 5 } }, 5)) }
    const former = render()
    applyMe(moderator)
    expect(render()).toBe(former)
    expect(former).toContain('href="/catalog/merges/2">Открыть группу дублей №2</a>')
  })
  it('announces the preliminary merge to a user without the right as text without a link to the group', () => {
    applyMe(reader)
    mocked.states = [success(groups())]
    const html = section(card({ kind: 'ok', data: { ...detail, id: 5, name: 'Steinhof.PizzaSpezial' } }, 5))
    expect(html).toContain('<p>Предварительно объединено 3 написания — требует подтверждения. Покупки всех написаний уже показаны в этой карточке.</p></div>')
    expect(html).not.toContain('/catalog/merges'); expect(html).not.toContain('Открыть группу дублей')
    expect(html).toContain('<dt>Бренд</dt>')
  })
  it('shows no notice on a product outside pending groups, including the kept product of a confirmed group', () => {
    mocked.states = [success(groups())]
    expect(section(card({ kind: 'ok', data: { ...detail, id: 2 } }, 2))).not.toContain('Предварительно объединено')
    mocked.states = [success({ ...groups(), count: 0, pages: 0, results: [] })]
    expect(section(card({ kind: 'ok', data: detail }, 9))).not.toContain('Предварительно объединено')
  })
  it.each([
    ['is switched off', failed('permission_denied', 403)], ['does not answer', failed('network')], ['is still loading', loading],
  ])('shows the card without the notice when the local API %s', (_name, marks) => {
    mocked.states = [marks]
    const html = card({ kind: 'ok', data: { ...detail, id: 5 } }, 5)
    expect(section(html)).toContain('<dt>Бренд</dt>'); expect(section(html)).toContain('Назад в категорию')
    expect(html).not.toContain('Предварительно объединено'); expect(html).not.toContain('Локальный API')
    expect(html).toContain('Загружаем историю покупок…')
  })
  it('leads an absorbed id of a pending group to the group', () => {
    mocked.states = [success(groups())]
    const html = card({ kind: 'error', reason: 'not_found', status: 404 }, 26)
    expect(section(html)).toContain('>Товар объединён</h2>')
    expect(section(html)).toContain('Товар объединён с «Steinhof.PizzaSpezial». Слияние ещё ждёт подтверждения')
    expect(section(html)).toContain('href="/catalog/merges/2">Открыть группу дублей №2</a>')
    expect(section(html).match(/<a /g)).toHaveLength(1)
    expect(html).not.toContain('Загружаем историю покупок…')
  })
  it('leads an absorbed id of a pending group to the kept product for a user without the right', () => {
    applyMe(reader)
    mocked.states = [success(groups())]
    const html = section(card({ kind: 'error', reason: 'not_found', status: 404 }, 26))
    expect(html).toContain('>Товар объединён</h2>')
    expect(html).toContain('Товар объединён с «Steinhof.PizzaSpezial». Слияние ещё ждёт подтверждения.')
    expect(html).not.toContain('в группе дублей'); expect(html).not.toContain('/catalog/merges')
    expect(html).toContain('href="/catalog/products/5">Открыть товар «Steinhof.PizzaSpezial»</a>')
    expect(html.match(/<a /g)).toHaveLength(1)
  })
  it('leads an id deleted by a confirmed merge to the kept product for everyone', () => {
    const render = () => { mocked.states = [success(groups())]; return section(card({ kind: 'error', reason: 'not_found', status: 404 }, 36)) }
    const former = render()
    applyMe(reader)
    expect(render()).toBe(former)
  })
  it('leads an id deleted by a confirmed merge to the kept product', () => {
    mocked.states = [success(groups())]
    const html = section(card({ kind: 'error', reason: 'not_found', status: 404 }, 36))
    expect(html).toContain('Товар объединён с «GQ EgSB H-Milch 1,5%». Его покупки и написания принадлежат этому товару.')
    expect(html).toContain('href="/catalog/products/2">Открыть товар «GQ EgSB H-Milch 1,5%»</a>')
    expect(html).not.toContain('/catalog/merges/')
  })
  it.each([
    ['an unknown id', success(groups()), 999], ['a record of a cancelled group', success(groups()), 38],
    ['a switched-off local API', failed('permission_denied', 403), 26], ['a failed lookup', failed('network'), 26], ['a pending lookup', loading, 26],
  ])('keeps the former «Товар не найден» for %s', (_name, marks, productId) => {
    mocked.states = [marks]
    const html = section(card({ kind: 'error', reason: 'not_found', status: 404 }, productId))
    expect(html).toContain('>Товар не найден</h2>')
    expect(html).toContain('Данные не найдены. Вернитесь в каталог.')
    expect(html).toContain('href="/catalog">В каталог</a>')
    expect(html).not.toContain('Товар объединён')
  })
  it('does not turn another card failure into a merge hint', () => {
    mocked.states = [success(groups())]
    const html = section(card({ kind: 'error', reason: 'network' }, 26))
    expect(html).toContain('Повторить'); expect(html).not.toContain('Товар объединён')
  })
})

describe('text of a refused access', () => {
  const denied = { kind: 'error' as const, reason: 'permission_denied' as const, status: 403 }
  const localText = 'Локальный API выключен или недоступен с этого адреса. Запустите сервер с ALLOW_LOCAL_RECOGNITION_API=1 и откройте приложение с этого компьютера.'

  it('names the missing right to a user of accounts, for a read and for an action', () => {
    applyMe(reader)
    expect(errorText(denied)).toBe('Нет права модератора каталога.')
    expect(errorText(denied, true)).toBe('Нет права модератора каталога.')
    // The right was there when the screen opened and is withdrawn now: the text is the same.
    applyMe(moderator)
    expect(errorText(denied, true)).toBe('Нет права модератора каталога.')
  })
  it.each([
    ['local_single', () => applyMe(local)], ['a guest', () => applyMe(null)], ['an unknown session', resetSession],
  ])('keeps the former text about the local API for %s', (_name, enter) => {
    enter()
    expect(errorText(denied)).toBe(localText)
    expect(errorText(denied, true)).toBe(localText)
  })
  it('leaves every other text independent of the session', () => {
    const texts = () => (['csrf_failed', 'not_found', 'merge_busy', 'network', 'server'] as const).map((reason) => errorText({ kind: 'error', reason }, true))
    const former = texts()
    applyMe(reader)
    expect(texts()).toEqual(former)
  })
})

describe('App shell routes of the catalog section', () => {
  const app = (snapshot: NavigationSnapshot) => { mocked.snapshot = snapshot; return renderToStaticMarkup(<App />) }
  const sectionNav = (html: string) => html.match(/<nav[^>]*aria-label="Раздел каталога"[^>]*>[\s\S]*?<\/nav>/)?.[0] ?? ''

  it('connects the list of duplicate groups under a single h1 and marks «Дубли»', () => {
    const html = app({ href: '/catalog/merges?status=all', route: { kind: 'merges', query: { status: 'all', page: 1 } } })
    expect(html).toContain('<h1 id="page-heading" tabindex="-1">Дубли товаров</h1>')
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(html).toContain('<option value="all" selected="">Все группы</option>')
    expect(sectionNav(html)).toContain('<a aria-current="page" href="/catalog/merges">Дубли</a>')
    expect(sectionNav(html)).toContain('<a href="/catalog">Товары</a>')
    expect(html).toMatch(/aria-label="Основная навигация">\s*<a aria-current="page" href="\/catalog">Каталог<\/a>/)
  })
  it('connects the group screen and passes the list context', () => {
    const html = app({ href: '/catalog/merges/7', route: { kind: 'merge', groupId: 7 }, returnTo: '/catalog/merges?status=confirmed' })
    expect(html).toContain('<h1 id="page-heading" tabindex="-1">Группа дублей</h1>')
    expect(html).toContain('Группа №7')
    expect(html).toContain('href="/catalog/merges?status=confirmed">К списку групп</a>')
    expect(sectionNav(html)).toContain('<a aria-current="page" href="/catalog/merges">Дубли</a>')
  })
  it('offers «Дубли» from the catalog, a category and a product, but not from other sections', () => {
    for (const snapshot of [
      { href: '/catalog', route: { kind: 'catalog' as const, query: { page: 1 } } },
      { href: '/catalog/categories/4', route: { kind: 'category' as const, categoryId: 4, query: { page: 1 } } },
      { href: '/catalog/products/5', route: { kind: 'product' as const, productId: 5, query: { page: 1 } } },
    ]) {
      const nav = sectionNav(app(snapshot))
      expect(nav).toContain('<a aria-current="page" href="/catalog">Товары</a>')
      expect(nav).toContain('<a href="/catalog/merges">Дубли</a>')
    }
    expect(sectionNav(app({ href: '/receipts', route: { kind: 'receipts', query: { page: 1 } } }))).toBe('')
    expect(sectionNav(app({ href: '/health', route: { kind: 'health' } }))).toBe('')
  })
  it('keeps an invalid list query outside the screen', () => {
    const html = app({ href: '/catalog/merges?status=done', route: { kind: 'invalid-query', path: '/catalog/merges', fields: ['status'], resetTo: '/catalog/merges' } })
    expect(html).toContain('href="/catalog/merges">Сбросить параметры</a>')
    expect(html).not.toContain('Состояние групп')
  })
})
