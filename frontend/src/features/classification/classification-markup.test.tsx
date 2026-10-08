import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Classification, ClassificationState } from '../../api/product-classifications'
import type { Me } from '../../api/session'
import type { GenericProduct, LocalApiFailure, Page } from '../../api/types'
import App from '../../App'
import type { ClassificationQuery, NavigationSnapshot } from '../../navigation'
import { applyMe } from '../../session'
import { resetSession } from '../../session/store'
import type { RequestState } from '../recognition/polling'
import type { ActionState, ClassificationAction } from './actions'
import ClassificationPage, { ClassificationView } from './ClassificationPage'
import { GenericChooserView } from './GenericChooser'
import { apiOffText, errorText } from './labels'
import type { OpenArea } from './state'
import { failed, generics, pageOf, record, records, refusal, stateOf, success } from './test-support'

const mocked = vi.hoisted(() => ({ states: [] as RequestState<unknown>[], loads: [] as unknown[], navigation: undefined as NavigationSnapshot | undefined }))
vi.mock('../recognition/useRequest', () => ({ useRequest: (load: unknown, active: unknown) => {
  mocked.loads.push([load, active])
  return {
    state: mocked.states.shift() ?? { kind: 'loading' },
    request: { pause: vi.fn(), resume: vi.fn(), setData: vi.fn(), refresh: vi.fn(), queueRefresh: vi.fn(), getSnapshot: vi.fn() },
  }
} }))
vi.mock('../../navigation', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../navigation')>(),
  useNavigation: () => mocked.navigation,
}))
// «Я» as the server answers: without accounts everyone moderates, with them — only the holder of the right.
const me = (mode: Me['mode'], moderate_catalog: boolean): Me =>
  ({ mode, user: { id: 3, username: 'anna', is_staff: false }, permissions: { moderate_catalog }, csrf_token: 'token' })
const local = me('local_single', true)
const moderator = me('accounts', true)
const reader = me('accounts', false)
// The former markup is the markup of local_single: the real store of the session holds it in every test.
beforeEach(() => { mocked.states = []; mocked.loads = []; mocked.navigation = undefined; applyMe(local) })
afterEach(() => { resetSession() })

const noop = () => {}
const idle: ActionState = { kind: 'idle' }
const confirm: ClassificationAction = { type: 'confirm', id: 1, input: { version: 1, generic_id: 93 } }
const reject: ClassificationAction = { type: 'reject', id: 3, input: { version: 1 } }
const failure = (action: ClassificationAction, error: LocalApiFailure, context: 'action' | 'choose' = 'action'): ActionState =>
  ({ kind: 'failed', action, error, message: errorText(error, context) })
const buttons = (html: string, label: string) => [...html.matchAll(/<button[^>]*>(.*?)<\/button>/g)].filter((match) => match[1].startsWith(label)).map((match) => match[0])
const button = (html: string, label: string) => buttons(html, label)[0]
const allDisabled = (html: string) => [...html.matchAll(/<(?:button|input)[^>]*>/g)].every((match) => match[0].includes('disabled=""'))
type Props = { query?: ClassificationQuery; state?: RequestState<ClassificationState>; list?: RequestState<Page<Classification>>; action?: ActionState; open?: OpenArea }
const view = ({ query = { page: 1 }, state = success(stateOf('status.json')), list = success(records()), action = idle, open }: Props = {}) =>
  renderToStaticMarkup(<ClassificationView query={query} state={state} list={list} action={action} open={open}
    onRun={noop} onRetryAction={noop} onRetryState={noop} onRetryList={noop} onAction={noop} onOpen={noop} onClose={noop} />)

describe('shell of the catalog section (SSR in Node, not browser behavior)', () => {
  const shell = (href: string, route: NavigationSnapshot['route']) => {
    mocked.navigation = { href, route }
    return renderToStaticMarkup(<App />)
  }
  it('titles the page, adds the third tab and keeps the catalog section active', () => {
    const html = shell('/catalog/classification', { kind: 'classification', query: { page: 1 } })
    expect(html).toMatch(/<h1 id="page-heading" tabindex="-1">Категории товаров<\/h1>/)
    expect(html.match(/<h1\b/g)).toHaveLength(1)
    expect(html).toContain('<a aria-current="page" href="/catalog">Каталог</a>')
    expect(html).toMatch(/aria-label="Раздел каталога"><a href="\/catalog">Товары<\/a><a href="\/catalog\/merges">Дубли<\/a><a aria-current="page" href="\/catalog\/classification">Категории<\/a><\/nav>/)
    expect(html).toContain('Предположение категорий')
  })
  it('shows the tab on the other catalog screens without making it current', () => {
    const merges = shell('/catalog/merges', { kind: 'merges', query: { page: 1 } })
    expect(merges).toContain('<a aria-current="page" href="/catalog/merges">Дубли</a><a href="/catalog/classification">Категории</a>')
    const catalog = shell('/catalog', { kind: 'catalog', query: { page: 1 } })
    expect(catalog).toContain('<a aria-current="page" href="/catalog">Товары</a><a href="/catalog/merges">Дубли</a><a href="/catalog/classification">Категории</a>')
    expect(shell('/health', { kind: 'health' })).not.toContain('Раздел каталога')
  })
  it('keeps an invalid address outside the screen', () => {
    const html = shell('/catalog/classification?status=done', { kind: 'invalid-query', path: '/catalog/classification', fields: ['status'], resetTo: '/catalog/classification' })
    expect(html).toContain('Некорректная ссылка')
    expect(html).toContain('href="/catalog/classification">Сбросить параметры</a>')
    expect(html).not.toContain('Предположение категорий')
  })
})

describe('block «Предположение категорий»', () => {
  it('loads independently of the list', () => {
    const html = view({ state: { kind: 'loading' } })
    expect(html).toMatch(/<section[^>]*aria-labelledby="class-state-title" aria-busy="true"/)
    expect(html).toMatch(/<section[^>]*aria-labelledby="class-list-title" aria-busy="false"/)
    expect(html).toContain('Demo Kefir mild 500g')
    expect(button(html, 'Предложить категории')).toContain('disabled=""')
    const other = view({ list: { kind: 'loading' } })
    expect(other).toMatch(/<section[^>]*aria-labelledby="class-list-title" aria-busy="true"/)
    expect(other).toContain('Ожидают подтверждения: 4. Без категории: 2.')
  })
  it('shows the counters, the finished run and an enabled start button', () => {
    const html = view()
    expect(html).toContain('Ожидают подтверждения: 4. Без категории: 2.')
    expect(html).toMatch(/role="status" aria-live="polite">Запуск завершён: предложено 8, не распознано 1, пропущено 0\.<\/p>/)
    expect(button(html, 'Предложить категории')).not.toContain('disabled')
    expect(html).not.toContain('Автозапуск')
    expect(html).not.toContain('Товаров без категории нет.')
  })
  it('disables the start without candidates and says why', () => {
    const html = view({ state: success(stateOf('status-empty.json')), list: success(pageOf([])) })
    expect(html).toContain('Ожидают подтверждения: 0. Без категории: 0.')
    expect(buttons(html, 'Предложить категории')).toHaveLength(1)
    expect(button(html, 'Предложить категории')).toContain('disabled=""')
    expect(html).toContain('<span class="ck-class-note">Товаров без категории нет.</span>')
  })
  it.each([
    ['status-queued.json', 'ck-class-warning', 'Запуск в очереди. Воркер распознавания не запущен: запуск начнётся, когда воркер запустят.'],
    ['status-running.json', 'ck-class-run', 'Модель предлагает категории: обработано 0 из 2.'],
  ])('disables the start during the active run of %s and describes it', (name, style, text) => {
    const html = view({ state: success(stateOf(name)) })
    expect(html).toContain(`<p class="${style}" role="status" aria-live="polite">${text}</p>`)
    expect(button(html, 'Предложить категории')).toContain('disabled=""')
  })
  it('describes the queue by the worker and omits the worker when its state is unknown', () => {
    const queued = stateOf('status-queued.json')
    const withWorker = (state: 'idle' | 'busy' | 'unknown') => view({ state: success({ ...queued, executor: { available: true, state, last_seen_at: null } }) })
    expect(withWorker('busy')).toContain('Запуск в очереди. Воркер занят другим заданием.')
    expect(withWorker('idle')).toContain('Запуск в очереди и начнётся в ближайшие секунды.')
    const unknown = withWorker('unknown')
    expect(unknown).toContain('>Запуск в очереди.</p>')
    expect(unknown).not.toMatch(/[Вв]оркер/)
  })
  it('describes a failed and a cancelled run with local texts only', () => {
    const base = stateOf('status.json')
    const failedRun = { ...base.run!, status: 'failed' as const, error: { code: 'timeout', message: 'СЕРВЕРНЫЙ ТЕКСТ' } }
    const html = view({ state: success({ ...base, run: failedRun }) })
    expect(html).toContain('Запуск завершился ошибкой: время ожидания ответа модели истекло. Уже предложенные категории сохранены.')
    expect(html).not.toContain('СЕРВЕРНЫЙ')
    expect(button(html, 'Предложить категории')).not.toContain('disabled')
    expect(view({ state: success({ ...base, run: { ...base.run!, status: 'cancelled' } }) })).toContain('Запуск отменён.')
    expect(view({ state: success({ ...base, run: { ...base.run!, remaining: 5 } }) })).toContain('Без предложения осталось 5: запустите ещё раз.')
  })
  it('mentions the automatic start only when it is on', () => {
    expect(view({ state: success({ ...stateOf('status.json'), auto_suggest: true }) })).toContain('Автозапуск после импорта чека включён.')
  })
  it('labels the pressed start button, disables the screen and then reports the result next to it', () => {
    const running = view({ action: { kind: 'pending', action: { type: 'run' } } })
    expect(button(running, 'Ставим в очередь…')).toContain('disabled=""')
    expect(allDisabled(running)).toBe(true)
    const nothing = view({ action: { kind: 'done', action: { type: 'run' }, message: 'Товаров без категории нет.' } })
    expect(nothing).toMatch(/<p tabindex="-1" role="status" aria-live="polite" class="ck-class-result">Товаров без категории нет\.<\/p>/)
    expect(nothing).toMatch(/<div class="ck-class-result-bar" data-request-focus-own=""><p tabindex="-1" role="status" aria-live="polite" class="ck-class-result"><\/p><\/div>/)
    const busy = view({ action: failure({ type: 'run' }, refusal('error-classification-busy.json')) })
    expect(busy).toMatch(/class="ck-class-error">Каталог сейчас изменяется: идёт импорт чека, слияние дублей или другое действие\. Ничего не сохранено\.<\/p>/)
    expect(buttons(busy, 'Повторить')).toHaveLength(0)
  })
  it('keeps the last state with a warning when its refresh fails', () => {
    const html = view({ state: { kind: 'ok', data: stateOf('status.json'), refreshing: false, refreshError: { kind: 'error', reason: 'network' } } })
    expect(html).toContain('Не удалось обновить данные, показаны последние полученные. Нет ответа сервера. Проверьте соединение и повторите запрос.')
    expect(html).toContain('Повторить обновление')
    expect(html).toContain('Ожидают подтверждения: 4.')
  })
  it('offers a retry after a failed read of the state while the list stays usable', () => {
    const html = view({ state: failed('server', 500) })
    expect(html).toContain('Сервис временно недоступен. Повторите запрос позже.')
    expect(html).toContain('data-request-retry="true"')
    expect(button(html, 'Предложить категории')).toContain('disabled=""')
    expect(button(html, 'Подтвердить<')).not.toContain('disabled')
  })
})

describe('filter of states', () => {
  it('offers five links, marks the current one and keeps the product', () => {
    const html = view()
    expect(html).toContain('<nav class="ck-class-filter" aria-label="Состояние записей">')
    expect(html).toContain('<a aria-current="true" href="/catalog/classification">Ожидают</a>')
    for (const [value, label] of [['confirmed', 'Подтверждённые'], ['rejected', 'Отклонённые'], ['superseded', 'Заменённые'], ['all', 'Все']]) {
      expect(html).toContain(`<a href="/catalog/classification?status=${value}">${label}</a>`)
    }
    const narrowed = view({ query: { status: 'rejected', product: 13, page: 3 }, list: success(pageOf([record('classification-rejected.json')])) })
    expect(narrowed).toContain('<a aria-current="true" href="/catalog/classification?status=rejected&amp;product=13">Отклонённые</a>')
    expect(narrowed).toContain('<a href="/catalog/classification?product=13">Ожидают</a>')
    expect(narrowed).toContain('Записи товара №13 · Отклонённые · Страница 3')
    expect(narrowed).toContain('href="/catalog/classification?status=rejected">Показать записи всех товаров</a>')
  })
})

describe('groups of pending records', () => {
  it('shows a group with its name, the «новый» mark, the category path, the unit, the count and the mass button', () => {
    const html = view()
    expect(html).toContain('<h2 id="class-list-title" tabindex="-1" data-request-focus-target="true">Ожидают · Страница 1</h2>')
    expect(html).toContain('<h3 id="class-group-93">Кефир <span class="ck-class-new">новый</span></h3>')
    expect(html).toContain('<h3 id="class-group-92">Молоко</h3>')
    expect(html).toContain('<p class="ck-class-path"><span>Продукты питания</span><span> → Молочные продукты</span></p>')
    expect(html).toContain('<p class="ck-class-path"><span>Продукты питания</span><span> → Мясные продукты <span class="ck-class-new">новая</span></span></p>')
    expect(html).toContain('Базовая единица: л · 2 товара')
    expect(html).toContain('Базовая единица: кг · 1 товар')
    expect(html.match(/<h3 /g)).toHaveLength(3)
    expect(html.indexOf('Кефир <span')).toBeLessThan(html.indexOf('>Колбаса <span'))
    expect(html.indexOf('>Колбаса <span')).toBeLessThan(html.indexOf('>Молоко</h3>'))
    expect(button(html, 'Подтвердить все (2)')).toContain('data-class-trigger="bulk-93"')
    expect(buttons(html, 'Подтвердить все (1)')).toHaveLength(2)
    expect(html).toContain('Всего: 4 записи. Страница 1 из 1.')
    expect(html).not.toContain('Показано')
  })
  it('says when a group continues on other pages or belongs to other products too', () => {
    const [first] = records().results
    const html = view({ list: success({ ...pageOf([first]), count: 201, pages: 2 }) })
    expect(html).toContain('Показано 1 из 2: остальные на других страницах')
    expect(html).toContain('Подтвердить все (1)')
    expect(html).toContain('href="/catalog/classification?page=2"')
    expect(html).toContain('aria-label="Страницы записей"')
    expect(view({ query: { product: 11, page: 1 }, list: success(pageOf([first])) })).toContain('Показано 1 из 2: остальные у других товаров')
  })
  it('shows a record with the product link, receipt spellings, brand, package and three labelled buttons', () => {
    const html = view()
    expect(html).toContain('<p class="ck-class-product"><a href="/catalog/products/11">Demo Kefir mild 500g</a></p>')
    expect(html).toContain('aria-label="Написания в чеках: Demo Kefir mild 500g"')
    expect(html).toContain('<span class="ck-class-subtext">Demomarkt</span>')
    expect(html).toContain('Фасовка: 500 г')
    expect(html).toContain('Бренд: Demowurst')
    expect(buttons(html, 'Подтвердить<')).toHaveLength(4)
    expect(button(html, 'Подтвердить<')).toBe('<button type="button">Подтвердить<span class="ck-class-hidden">: Demo Kefir mild 500g</span></button>')
    expect(button(html, 'Выбрать другой')).toContain('data-class-trigger="choose-1"')
    expect(button(html, 'Выбрать другой')).toContain('<span class="ck-class-hidden"> обобщённый продукт для товара: Demo Kefir mild 500g</span>')
    expect(button(html, 'Отклонить')).toContain('data-class-trigger="reject-1"')
    expect(html).not.toContain('window.confirm')
    expect(html).not.toMatch(/<dialog|role="dialog"|aria-modal/)
  })
  it('links a product absorbed by a duplicate group to the group instead of its hidden card', () => {
    const [first, ...rest] = structuredClone(records().results)
    first.product.merge_group_id = 7
    const html = view({ list: success(pageOf([first, ...rest])) })
    expect(html).toContain('<p class="ck-class-product">Demo Kefir mild 500g</p>')
    expect(html).toContain('<a href="/catalog/merges/7">Входит в группу дублей №7</a>')
    expect(html).not.toContain('href="/catalog/products/11"')
  })
  it('replaces the buttons of a record changed outside the screen and of a removed product', () => {
    const [changed, removed, ...rest] = structuredClone(records().results)
    Object.assign(changed.actions, { can_confirm: false, can_choose: false, can_reject: false })
    changed.product.generic = { id: 92, name: 'Молоко', base_unit: 'l' }
    Object.assign(removed.actions, { can_confirm: false, can_choose: false, can_reject: false })
    Object.assign(removed.product, { exists: false, generic: null, aliases: [] })
    const html = view({ list: success(pageOf([changed, removed, ...rest])) })
    expect(html).toContain('Обобщённый продукт товара изменён вне этого экрана. Запись закроется как „заменено“ при следующем действии или запуске.')
    expect(html).toContain('<p class="ck-class-warning">Товар удалён.</p>')
    expect(html).toContain('<p class="ck-class-product">Demo Kefir 1,5% 1L</p>')
    expect(buttons(html, 'Подтвердить<')).toHaveLength(2)
    // The mass button counts only the records that can be confirmed: none is left in «Кефир».
    expect(buttons(html, 'Подтвердить все')).toHaveLength(2)
    expect(html).not.toContain('data-class-trigger="bulk-93"')
  })
  it('shows a record the action has just decided in words, without buttons, until the list is read again', () => {
    const [, second, ...rest] = records().results
    const decided = { ...record('classification-confirmed.json'), id: 1, suggested: second.suggested }
    const html = view({ list: success(pageOf([decided, second, ...rest])), action: { kind: 'done', action: confirm, message: 'Категория подтверждена.' } })
    expect(html).toContain('<p class="ck-class-state ck-class-state-confirmed">Подтверждено</p>')
    expect(html).toContain('Подтвердить все (1)')
    expect(html).toMatch(/<div class="ck-class-result-bar ck-class-result-shown" data-request-focus-own=""><p tabindex="-1" role="status" aria-live="polite" class="ck-class-result">Категория подтверждена\.<\/p><\/div>/)
  })
})

describe('inline confirmations', () => {
  it('turns «Отклонить» into a question with two buttons', () => {
    const html = view({ open: { kind: 'reject', id: 3 } })
    expect(html).toContain('role="group" tabindex="-1" data-class-focus="true" aria-label="Отклонение предложения для товара «Demo Mettwurst fein»"')
    expect(html).toContain('<p>Отклонить предложение? Товар вернётся в „Не разобрано“.</p>')
    expect(button(html, 'Да, отклонить')).not.toContain('disabled')
    expect(buttons(html, 'Отмена')).toHaveLength(1)
    expect(html).not.toContain('data-class-trigger="reject-3"')
    expect(buttons(html, 'Отклонить')).toHaveLength(3)
    expect(buttons(html, 'Подтвердить<')).toHaveLength(3)
  })
  it('turns «Подтвердить все» into a question naming the count and the generic product', () => {
    const html = view({ open: { kind: 'bulk', genericId: 93 } })
    expect(html).toContain('aria-label="Подтверждение группы «Кефир»"')
    expect(html).toContain('<p>Подтвердить 2 товара как „Кефир“?</p>')
    expect(button(html, 'Да, подтвердить')).not.toContain('disabled')
    expect(html).not.toContain('Подтвердить все (2)')
    const single = view({ open: { kind: 'bulk', genericId: 94 } })
    expect(single).toContain('<p>Подтвердить 1 товар как „Колбаса“?</p>')
  })
  it('opens one area at a time and drops an area whose record is not actionable any more', () => {
    const html = view({ open: { kind: 'reject', id: 77 } })
    expect(html).not.toContain('Отклонить предложение?')
    const decided = view({ open: { kind: 'reject', id: 4 }, list: success(pageOf([record('classification-confirmed.json')])) })
    expect(decided).not.toContain('Отклонить предложение?')
  })
  it('labels the pressed confirmation and disables every control during the request', () => {
    const rejecting = view({ open: { kind: 'reject', id: 3 }, action: { kind: 'pending', action: reject } })
    expect(button(rejecting, 'Отклоняем…')).toContain('disabled=""')
    expect(allDisabled(rejecting)).toBe(true)
    const bulk: ClassificationAction = { type: 'confirmAll', genericId: 93, items: [{ id: 1, version: 1 }, { id: 2, version: 1 }] }
    const confirming = view({ open: { kind: 'bulk', genericId: 93 }, action: { kind: 'pending', action: bulk } })
    expect(button(confirming, 'Подтверждаем…')).toContain('disabled=""')
    expect(buttons(confirming, 'Подтверждаем…')).toHaveLength(1)
    expect(allDisabled(confirming)).toBe(true)
    const single = view({ action: { kind: 'pending', action: confirm } })
    expect(button(single, 'Подтверждаем…')).toBe('<button type="button" disabled="">Подтверждаем…<span class="ck-class-hidden">: Demo Kefir mild 500g</span></button>')
    expect(buttons(single, 'Подтверждаем…')).toHaveLength(1)
    expect(allDisabled(single)).toBe(true)
    // Links stay links: the filter and the product cards are not controls of an action.
    expect(single).toContain('<a href="/catalog/classification?status=all">Все</a>')
  })
})

describe('«Выбрать другой»', () => {
  const kefir = records().results[0]
  const chooser = (props: Partial<Parameters<typeof GenericChooserView>[0]> = {}) => renderToStaticMarkup(
    <GenericChooserView record={kefir} text="" state={success(generics())} selected={undefined} busy={false} saving={false}
      onText={noop} onSelect={noop} onApply={noop} onCancel={noop} onRetry={noop} {...props} />)
  it('opens under the record with a labelled search, radio options without the service and the suggested product, and two buttons', () => {
    const html = chooser()
    expect(html).toContain('<div class="ck-class-area" role="group" aria-labelledby="class-choose-1-title">')
    expect(html).toContain('Другой обобщённый продукт для товара «Demo Kefir mild 500g»')
    expect(html).toContain('<label for="class-choose-1-search">Поиск обобщённого продукта</label>')
    expect(html).toMatch(/<input id="class-choose-1-search" type="search" maxLength="100" autoComplete="off" data-class-focus="true" aria-describedby="class-choose-1-hint" value=""\/>/)
    expect(html).toContain('Введите не меньше 2 символов.')
    expect(html).toContain('<fieldset role="radiogroup" aria-required="true"><legend>Варианты</legend>')
    expect([...html.matchAll(/<input type="radio" name="class-choose-1-option" value="(\d+)"/g)].map((match) => match[1])).toEqual(['92', '95'])
    expect(html).toContain('Молоко<span class="ck-class-subtext">Продукты → Молочные продукты · л</span>')
    expect(html).toContain('Творог<span class="ck-class-subtext">Продукты → Молочные продукты · кг</span>')
    expect(html).not.toContain('Не разобрано')
    expect(html).not.toContain('>Кефир<')
    expect(button(html, 'Применить выбор')).toContain('disabled=""')
    expect(button(html, 'Отмена')).not.toContain('disabled')
  })
  it('enables «Применить выбор» only with a chosen option that is still offered', () => {
    const chosen = chooser({ selected: 95 })
    expect(chosen).toContain('checked="" value="95"')
    expect(button(chosen, 'Применить выбор')).not.toContain('disabled')
    expect(button(chooser({ selected: 93 }), 'Применить выбор')).toContain('disabled=""')
    expect(button(chooser({ selected: 91 }), 'Применить выбор')).toContain('disabled=""')
  })
  it('does not search for one character and shows the states of its own request', () => {
    const short = chooser({ text: 'с', selected: 95 })
    expect(short).toContain('Для поиска нужно не меньше 2 символов.')
    expect(short).not.toContain('type="radio"')
    expect(button(short, 'Применить выбор')).toContain('disabled=""')
    const loading = chooser({ text: 'сыр', state: { kind: 'loading' } })
    expect(loading).toMatch(/<div class="ck-class-options" aria-live="polite" aria-busy="true"><p class="ck-class-note">Загружаем варианты…<\/p>/)
    const error = chooser({ state: failed('network') })
    expect(error).toContain('Нет ответа сервера. Проверьте соединение и повторите запрос.')
    expect(buttons(error, 'Повторить')).toHaveLength(1)
    const empty = chooser({ text: 'zz', state: success({ ...generics(), results: generics().results.filter((item) => item.id === 91 || item.id === 93) }) })
    expect(empty).toContain('Подходящих обобщённых продуктов нет. Измените запрос.')
    const more = chooser({ state: success<Page<GenericProduct>>({ ...generics(), count: 120, pages: 3 }) })
    expect(more).toContain('Показаны первые 4 из 120: уточните запрос.')
  })
  it('labels the pressed button and disables the search, the options and both buttons while saving', () => {
    const html = chooser({ selected: 95, busy: true, saving: true })
    expect(button(html, 'Сохраняем выбор…')).toContain('disabled=""')
    expect(allDisabled(html)).toBe(true)
  })
  it('is mounted under the record through the page with its own request to the catalog list', () => {
    mocked.states = [success(generics())]
    const html = view({ open: { kind: 'choose', id: 1 } })
    expect(mocked.states).toHaveLength(0)
    expect(mocked.loads).toHaveLength(1)
    expect(html).toContain('<label for="class-choose-1-search">Поиск обобщённого продукта</label>')
    expect([...html.matchAll(/name="class-choose-1-option" value="(\d+)"/g)].map((match) => match[1])).toEqual(['92', '95'])
    expect(view({ open: { kind: 'choose', id: 1 } })).toContain('Загружаем варианты…')
    expect(html).not.toContain('data-class-trigger="choose-1"')
    expect(buttons(html, 'Выбрать другой')).toHaveLength(3)
  })
  it('explains a refused choice and keeps the area open for another one', () => {
    const choose: ClassificationAction = { type: 'choose', id: 1, input: { version: 1, generic_id: 95 } }
    const html = view({ open: { kind: 'choose', id: 1 }, action: failure(choose, refusal('error-invalid-parameter.json'), 'choose') })
    expect(html).toMatch(/class="ck-class-error">Этот обобщённый продукт больше недоступен\. Выберите другой\.<\/p>/)
    expect(html).toContain('Поиск обобщённого продукта')
    expect(buttons(html, 'Повторить')).toHaveLength(0)
  })
})

describe('states of the list', () => {
  it('offers the start when nothing waits and there are products without a category', () => {
    const html = view({ list: success(pageOf([])) })
    expect(html).toContain('Товаров, ожидающих подтверждения категории, нет.')
    expect(buttons(html, 'Предложить категории')).toHaveLength(2)
    const none = view({ list: success(pageOf([])), state: success({ ...stateOf('status.json'), unclassified_count: 0 }) })
    expect(buttons(none, 'Предложить категории')).toHaveLength(1)
    const product = view({ query: { product: 13, page: 1 }, list: success(pageOf([])) })
    expect(product).toContain('Товаров, ожидающих подтверждения категории, нет.')
    expect(product).toContain('href="/catalog/classification">Показать все ожидающие</a>')
  })
  it('offers the pending list when another filter is empty', () => {
    const html = view({ query: { status: 'superseded', page: 1 }, list: success(pageOf([])) })
    expect(html).toContain('Записей с таким состоянием нет.')
    expect(html).toContain('href="/catalog/classification">Показать ожидающие</a>')
    expect(buttons(html, 'Предложить категории')).toHaveLength(1)
  })
  it('lists decided records plainly: state in words, the suggestion, the result and the date, without buttons', () => {
    const decided = ['classification-confirmed-other.json', 'classification-rejected.json', 'classification-superseded.json', 'classification-confirmed.json'].map(record)
    const html = view({ query: { status: 'all', page: 1 }, list: success(pageOf([...decided, records().results[2]])) })
    expect(html).toContain('<h2 id="class-list-title" tabindex="-1" data-request-focus-target="true">Все · Страница 1</h2>')
    for (const text of ['Выбран другой обобщённый продукт', 'Отклонено', 'Заменено: обобщённый продукт изменён вручную', 'Подтверждено', 'Ожидает подтверждения']) expect(html).toContain(`>${text}</p>`)
    expect(html).toContain('<dt>Предложено</dt><dd>Кефир (л) · <span>Продукты питания</span><span> → Молочные продукты</span></dd>')
    expect(html).toContain('<dt>Итог</dt><dd>Творог (кг)</dd>')
    expect(html).toContain('<dt>Итог</dt><dd>Не разобрано (шт)</dd>')
    expect(html).toContain('<dt>Решено</dt><dd><time dateTime="2026-10-06T10:05:00Z">06.10.2026,\u00a010:05\u00a0UTC</time></dd>')
    expect(html).toContain('<dt>Итог</dt><dd>—</dd>')
    expect(html).toContain('<a href="/catalog/classification?product=13">Открыть среди ожидающих<span class="ck-class-hidden">: Demo Mettwurst fein</span></a>')
    expect(html).not.toMatch(/<h3 /)
    expect(html.match(/<button/g)).toHaveLength(1)
  })
  it('names the other resolutions and a removed product without a link', () => {
    const removed = structuredClone(record('classification-superseded.json'))
    Object.assign(removed, { resolution: 'product_removed', final_generic: null })
    Object.assign(removed.product, { exists: false, generic: null, aliases: [] })
    const merged = { ...record('classification-superseded.json'), id: 9, resolution: 'merged' as const }
    const cancelled = { ...record('classification-rejected.json'), id: 10, resolution: 'cancelled' as const }
    const html = view({ query: { status: 'all', page: 1 }, list: success(pageOf([removed, merged, cancelled])) })
    for (const text of ['Заменено: товар удалён', 'Заменено: товар объединён с другим', 'Отменено командой']) expect(html).toContain(text)
    expect(html).toContain('<p class="ck-class-product">Demo Joghurt Natur</p>')
  })
  it('names the missing right instead of the local API to a user of accounts and leaves no action available', () => {
    applyMe(reader)
    const off = failed('permission_denied', 403)
    const html = view({ state: off, list: off })
    expect(html.match(/Нет права модератора каталога\./g)).toHaveLength(2)
    expect(html).not.toContain('Локальный API'); expect(html).not.toContain('ALLOW_LOCAL_RECOGNITION_API')
    expect(button(html, 'Предложить категории')).toContain('disabled=""')
    expect(buttons(html, 'Подтвердить')).toHaveLength(0)
  })
  it('words a refused access by the session: the right with accounts, the local API without them', () => {
    const denied: LocalApiFailure = { kind: 'error', reason: 'permission_denied', status: 403 }
    const texts = () => (['read', 'action', 'choose'] as const).map((context) => errorText(denied, context))
    expect(texts()).toEqual(Array(3).fill(apiOffText))
    for (const enter of [() => applyMe(null), resetSession]) { enter(); expect(texts()).toEqual(Array(3).fill(apiOffText)) }
    for (const person of [reader, moderator]) { applyMe(person); expect(texts()).toEqual(Array(3).fill('Нет права модератора каталога.')) }
    // The refusal of an action keeps the text it was given when it happened.
    applyMe(reader)
    expect(failure(confirm, denied)).toMatchObject({ kind: 'failed', message: 'Нет права модератора каталога.' })
  })
  it('explains a switched-off local API with a retry and leaves no action available', () => {
    const off = failed('permission_denied', 403)
    const html = view({ state: off, list: off })
    expect(html.match(/Локальный API выключен или недоступен с этого адреса\. Запустите сервер с ALLOW_LOCAL_RECOGNITION_API=1 и откройте приложение с этого компьютера\./g)).toHaveLength(2)
    expect(html.match(/data-request-retry="true"[^>]*>Повторить<\/button>/g)).toHaveLength(2)
    expect(button(html, 'Предложить категории')).toContain('disabled=""')
    expect(buttons(html, 'Подтвердить')).toHaveLength(0)
  })
  it('disables every action when the local API went off under a list that is still shown', () => {
    const refreshError = refusal('error-permission-denied.json')
    const html = view({ list: { kind: 'ok', data: records(), refreshing: false, refreshError }, open: { kind: 'reject', id: 3 } })
    expect(html).toContain('показаны последние полученные')
    for (const label of ['Предложить категории', 'Подтвердить<', 'Выбрать другой', 'Отклонить', 'Подтвердить все', 'Да, отклонить']) {
      expect(buttons(html, label).every((item) => item.includes('disabled=""')), label).toBe(true)
    }
    expect(button(html, 'Отмена')).not.toContain('disabled')
    expect(button(html, 'Повторить обновление')).not.toContain('disabled')
  })
  it('offers a retry after a read failure and the first page for a missing one', () => {
    const network = view({ list: failed('network') })
    expect(network).toContain('Нет ответа сервера. Проверьте соединение и повторите запрос.')
    expect(network).toContain('>Повторить</button>')
    expect(network).toContain('Ожидают подтверждения: 4.')
    const missing = view({ query: { status: 'confirmed', page: 9 }, list: failed('page_out_of_range', 404) })
    expect(missing).toContain('Такой страницы больше нет. Откройте первую страницу.')
    expect(missing).toContain('href="/catalog/classification?status=confirmed">На первую страницу</a>')
    expect(buttons(missing, 'Повторить')).toHaveLength(0)
  })
  it('keeps the last list with a warning when its refresh fails', () => {
    const html = view({ list: { kind: 'ok', data: records(), refreshing: false, refreshError: { kind: 'error', reason: 'timeout' } } })
    expect(html).toContain('Не удалось обновить данные, показаны последние полученные.')
    expect(html).toContain('Demo Kefir mild 500g')
    expect(button(html, 'Подтвердить<')).not.toContain('disabled')
  })
})

describe('results of actions on records', () => {
  it('announces a busy catalog and repeats the action only by the «Повторить» button', () => {
    const html = view({ open: { kind: 'reject', id: 3 }, action: failure(reject, refusal('error-classification-busy.json')) })
    expect(html).toMatch(/<p tabindex="-1" role="status" aria-live="polite" class="ck-class-error">Каталог сейчас изменяется: идёт импорт чека, слияние дублей или другое действие\. Ничего не сохранено\.<\/p><button type="button" class="ck-class-secondary">Повторить<\/button>/)
    expect(html).toContain('Отклонить предложение?')
    expect(button(html, 'Да, отклонить')).not.toContain('disabled')
  })
  it.each([
    ['error-classification-changed.json', 'Предложение изменилось. Данные обновлены: проверьте запись и повторите действие.'],
    ['error-classification-resolved.json', 'Предложение уже решено. Показано актуальное состояние.'],
    ['error-csrf-failed.json', 'Токен безопасности устарел. Повторите действие.'],
    ['error-database-unavailable.json', 'Ответ сервера не получен. Действие могло выполниться: проверьте состояние записи перед повтором.'],
  ])('announces %s without offering an automatic repeat', (name, text) => {
    const html = view({ action: failure(confirm, refusal(name)) })
    expect(html).toContain(`<p tabindex="-1" role="status" aria-live="polite" class="ck-class-error">${text}</p></div>`)
    expect(buttons(html, 'Повторить')).toHaveLength(0)
    expect(button(html, 'Подтвердить<')).not.toContain('disabled')
  })
  it('announces a lost answer of the network and of a timeout with the same warning', () => {
    for (const reason of ['network', 'timeout', 'server'] as const) {
      expect(view({ action: failure(confirm, { kind: 'error', reason }) })).toContain('Ответ сервера не получен. Действие могло выполниться: проверьте состояние записи перед повтором.')
    }
  })
  it('announces the result of a mass confirmation', () => {
    const bulk: ClassificationAction = { type: 'confirmAll', genericId: 93, items: [{ id: 1, version: 1 }, { id: 2, version: 1 }] }
    expect(view({ action: { kind: 'done', action: bulk, message: 'Подтверждено 2 из 2.' } })).toContain('class="ck-class-result">Подтверждено 2 из 2.</p>')
  })
  it('never prints a server message: every text of the fixtures stays out of the screen', () => {
    const html = view({ action: failure(confirm, refusal('error-classification-changed.json')) })
    for (const text of ['Предположение изменилось.', 'Предположение уже решено.', 'Некорректные параметры запроса.', 'Проверка CSRF не пройдена.']) expect(html).not.toContain(text)
  })
})

describe('page', () => {
  it('connects the two independent requests: the polled state and the list of the filter', () => {
    mocked.states = [success(stateOf('status-queued.json')), success(records())]
    const html = renderToStaticMarkup(<ClassificationPage query={{ page: 1 }} />)
    expect(html).toContain('Запуск в очереди.')
    expect(html).toContain('Кефир <span class="ck-class-new">новый</span>')
    expect(mocked.loads).toHaveLength(2)
    const [, active] = mocked.loads[0] as [unknown, (state: ClassificationState) => boolean]
    expect(active(stateOf('status-queued.json'))).toBe(true)
    expect(active(stateOf('status.json'))).toBe(false)
    expect((mocked.loads[1] as unknown[])[1]).toBeUndefined()
  })
  it('shows both blocks loading before any answer', () => {
    const html = renderToStaticMarkup(<ClassificationPage query={{ status: 'all', page: 2 }} />)
    expect(html.match(/Загружаем данные…/g)).toHaveLength(2)
    expect(html).toContain('Все · Страница 2')
  })
})
