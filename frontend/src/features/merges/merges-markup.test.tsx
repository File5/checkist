import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { errorFixtures } from '../../api/product-merges-test-support'
import type { LocalApiFailure } from '../../api/types'
import type { RequestState } from '../recognition/polling'
import type { ActionState, MergeAction } from './actions'
import MergeGroupView from './MergeGroupView'
import MergeLines from './MergeLines'
import MergePage, { MergeSummary } from './MergePage'
import MergesPage, { MergesView } from './MergesPage'
import { initialSelection, selectName, selectResolution, selectTarget } from './state'
import { detected, failed, group, groups, groupsOf, lines, success } from './test-support'

const mocked = vi.hoisted(() => ({ states: [] as RequestState<unknown>[] }))
vi.mock('../recognition/useRequest', () => ({ useRequest: () => ({
  state: mocked.states.shift() ?? { kind: 'loading' },
  request: { pause: vi.fn(), resume: vi.fn(), setData: vi.fn(), refresh: vi.fn(), queueRefresh: vi.fn() },
}) }))
beforeEach(() => { mocked.states = [] })

const noop = () => {}
const idle: ActionState = { kind: 'idle' }
const refusal = (name: string): LocalApiFailure => {
  const { status, reason, fields } = errorFixtures[name]
  return { kind: 'error', reason: reason as LocalApiFailure['reason'], status, ...(fields && { fields }) }
}
const confirm: MergeAction = { type: 'confirm', id: 1, input: { version: 1, target_product_id: 2 } }
const button = (html: string, label: string) => html.match(new RegExp(`<button[^>]*>${label}</button>`))?.[0]
const pizza = group('group-pending.json')
const milk = group('group-pending-conflict.json')

describe('list of duplicate groups (SSR in Node, backend fixtures)', () => {
  const view = (state: RequestState<ReturnType<typeof groups>>, action: ActionState = idle, query: Parameters<typeof MergesView>[0]['query'] = { page: 1 }) =>
    renderToStaticMarkup(<MergesView query={query} state={state} action={action} onDetect={noop} onRetry={noop} />)

  it('shows loading inside the block and keeps the filter and the search button', () => {
    const html = view({ kind: 'loading' })
    expect(html).toContain('Загружаем данные…')
    expect(html).toMatch(/<section[^>]*aria-busy="true"/)
    expect(html).toContain('<label for="merge-status-filter">Состояние групп</label>')
    expect(html).toContain('<option value="" selected="">Ожидают подтверждения</option>')
    expect(button(html, 'Найти дубли')).not.toContain('disabled')
  })
  it('lists pending groups with the kept record, counters, the conflict flag and links', () => {
    const data = { ...groupsOf('pending'), results: [{ ...groupsOf('pending').results[0], has_conflicts: true }] }
    const html = view(success(data))
    expect(html).toContain('href="/catalog/merges/2">Группа №2: Steinhof.PizzaSpezial</a>')
    expect(html).toContain('Ожидает подтверждения')
    expect(html).toContain('Есть конфликт данных')
    expect(html).toContain('после слияния добавлено 1')
    expect(html).toContain('Steinof.PizzaSpezial')
    expect(html).toContain('Всего: 1 группа.')
    expect(html).not.toContain('<nav class="pagination"')
  })
  it('shows every state under the «all» filter without a conflict flag for finished groups', () => {
    const html = view(success(groups()), idle, { status: 'all', page: 1 })
    expect(html).toContain('<option value="all" selected="">Все группы</option>')
    expect(html).toContain('Всего: 3 группы.')
    for (const text of ['Подтверждено', 'Отменено', 'Ожидает подтверждения', 'Группа №1', 'Группа №3']) expect(html).toContain(text)
    expect(html).not.toContain('Есть конфликт данных')
  })
  it('keeps the filter in page links', () => {
    const html = view(success({ ...groups(), count: 120, pages: 3, page: 2 }), idle, { status: 'all', page: 2 })
    expect(html).toContain('href="/catalog/merges?status=all"')
    expect(html).toContain('href="/catalog/merges?status=all&amp;page=3"')
    expect(html).toContain('aria-label="Страницы групп"')
  })
  it('offers the search when nothing waits for confirmation', () => {
    const html = view(success({ ...groups(), count: 0, pages: 0, results: [] }))
    expect(html).toContain('Групп, требующих подтверждения, нет.')
    expect(html.match(/>Найти дубли<\/button>/g)).toHaveLength(2)
  })
  it('offers the default list when another filter is empty', () => {
    const html = view(success({ ...groups(), count: 0, pages: 0, results: [] }), idle, { status: 'cancelled', page: 1 })
    expect(html).toContain('Групп с таким состоянием нет.')
    expect(html).toContain('href="/catalog/merges">Показать ожидающие</a>')
    expect(html.match(/>Найти дубли<\/button>/g)).toHaveLength(1)
  })
  it('explains a switched-off local API, offers a retry and disables the search', () => {
    const html = view(failed('permission_denied', 403))
    expect(html).toContain('Локальный API выключен')
    expect(html).toContain('data-request-retry="true"')
    expect(button(html, 'Найти дубли')).toContain('disabled=""')
  })
  it('offers a retry after a read failure and the first page for a missing one', () => {
    const network = view(failed('network'))
    expect(network).toContain('Нет ответа сервера')
    expect(network).toContain('>Повторить</button>')
    const missing = view(failed('page_out_of_range', 404), idle, { status: 'confirmed', page: 9 })
    expect(missing).toContain('href="/catalog/merges?status=confirmed">На первую страницу</a>')
    expect(missing).not.toContain('>Повторить</button>')
  })
  it('keeps the last list with a warning when a refresh fails', () => {
    const html = view({ kind: 'ok', data: groups(), refreshing: false, refreshError: { kind: 'error', reason: 'network' } }, idle, { status: 'all', page: 1 })
    expect(html).toContain('показаны последние полученные')
    expect(html).toContain('Повторить обновление')
    expect(html).toContain('Группа №2')
  })
  it('disables the search during its request and then reports the found groups', () => {
    const running = view(success(groups()), { kind: 'pending', action: { type: 'detect' } })
    expect(button(running, 'Ищем дубли…')).toContain('disabled=""')
    const done = view(success(groups()), { kind: 'done', action: { type: 'detect' }, message: 'Создано групп: 3.', detected: detected() })
    expect(done).toMatch(/role="status"[^>]*>Создано групп: 3\.<\/p>/)
    expect(done).toContain('aria-label="Найденные группы"')
    expect(done).toContain('href="/catalog/merges/3">Группа №3</a>')
    expect(button(done, 'Найти дубли')).not.toContain('disabled')
  })
  it('reports a busy catalog after the search without hiding the list', () => {
    const error = refusal('error-merge-busy.json')
    const html = view(success(groups()), { kind: 'failed', action: { type: 'detect' }, error, message: 'Каталог сейчас изменяется: идёт импорт чека или другое слияние.' })
    expect(html).toMatch(/class="ck-merge-error">Каталог сейчас изменяется/)
    expect(html).toContain('Группа №2')
  })
  it('connects the page to its request', () => {
    mocked.states = [success(groupsOf('pending'))]
    expect(renderToStaticMarkup(<MergesPage query={{ page: 1 }} />)).toContain('Группа №2: Steinhof.PizzaSpezial')
    expect(renderToStaticMarkup(<MergesPage query={{ page: 1 }} />)).toContain('Загружаем данные…')
  })
})

describe('group screen (SSR in Node, backend fixtures)', () => {
  const view = (data = pizza, selection = initialSelection(data), action: ActionState = idle) =>
    renderToStaticMarkup(<MergeGroupView group={data} selection={selection} action={action} onSelection={noop} onConfirm={noop} onCancel={noop} onExclude={noop} />)
  const checked = (html: string, name: string) => [...html.matchAll(new RegExp(`<input type="radio" name="${name}"[^>]*>`, 'g'))]
    .filter((match) => match[0].includes('checked=""')).map((match) => match[0].match(/value="(\d+)"/)?.[1])

  it('shows records with spellings, purchase counts, dates and facts in a labelled table', () => {
    const html = view()
    expect(html).toContain('<caption>Выберите запись')
    for (const heading of ['Оставляемая запись', 'Название', 'Написания в чеках', 'Покупок', 'Даты покупок', 'Факты', 'Действие']) expect(html).toContain(`<th scope="col">${heading}</th>`)
    expect(html.match(/<th scope="row">/g)).toHaveLength(3)
    expect(html).toContain('Steinof.PizzaSpezial<span class="ck-merge-subtext">Demomarkt</span>')
    expect(html).toContain('09.06.2026 — 06.07.2026')
    expect(html).toContain('<dt>Обобщённый продукт</dt><dd>Не разобрано</dd>')
    expect(html).toContain('role="region" aria-label="Таблица записей группы, прокручивается по горизонтали" tabindex="0"')
  })
  it('links only the record which is still a catalog product', () => {
    const html = view()
    expect(html).toContain('href="/catalog/products/5">Steinhof.PizzaSpezial</a>')
    expect(html).not.toContain('href="/catalog/products/26"')
    expect(html).not.toContain('href="/catalog/products/43"')
    const cancelled = view(group('group-cancelled.json'))
    expect(cancelled).toContain('href="/catalog/products/18"'); expect(cancelled).toContain('href="/catalog/products/38"')
    const confirmed = view(group('group-confirmed.json'))
    expect(confirmed).toContain('href="/catalog/products/2"'); expect(confirmed).not.toContain('href="/catalog/products/14"')
    expect(confirmed).toContain('удалена после слияния')
  })
  it('keeps the record of the group and the unchanged name by default', () => {
    const html = view()
    expect(checked(html, 'merge-target')).toEqual(['5'])
    expect(html).toContain('<option value="" selected="">Не менять: «Steinhof.PizzaSpezial»</option>')
    expect(html).toContain('<option value="26">Взять из записи №26: «Steinhof PizzaSpezial»</option>')
    expect(html).not.toContain('<option value="5"')
    expect(button(html, 'Подтвердить слияние')).not.toContain('disabled')
    expect(html).toContain('Подтверждение необратимо')
  })
  it('reflects another kept record and an explicit name source', () => {
    const html = view(pizza, selectName(selectTarget(initialSelection(pizza), 43), 26))
    expect(checked(html, 'merge-target')).toEqual(['43'])
    expect(html).toContain('<option value="">Не менять: «Steinof.PizzaSpezial»</option>')
    expect(html).toContain('<option value="26" selected="">Взять из записи №26')
    expect(html).toContain('<option value="5">Взять из записи №5')
  })
  it('requires a value for every disputed field before confirmation', () => {
    const html = view(milk)
    expect(html).toContain('<legend>Обобщённый продукт</legend>')
    expect(html).toMatch(/<fieldset role="radiogroup" aria-required="true" aria-invalid="false">/)
    expect(html).toContain('Молоко<span class="ck-merge-subtext">из записи №2: GQ EgSB H-Milch 1,5%</span>')
    expect(html).toContain('H-Milch (демо)<span class="ck-merge-subtext">из записи №36')
    expect(html.match(/name="merge-resolution-generic"/g)).toHaveLength(2)
    expect(checked(html, 'merge-resolution-generic')).toEqual([])
    expect(button(html, 'Подтвердить слияние')).toContain('disabled=""')
    expect(html).toContain('Чтобы подтвердить, выберите значение: обобщённый продукт.')
    expect(button(html, 'Отменить слияние')).not.toContain('disabled')
  })
  it('enables confirmation once the value is chosen', () => {
    const html = view(milk, selectResolution(initialSelection(milk), 'generic', 2))
    expect(checked(html, 'merge-resolution-generic')).toEqual(['2'])
    expect(button(html, 'Подтвердить слияние')).not.toContain('disabled')
  })
  it('highlights the fields refused with merge_conflict and names the error for a screen reader', () => {
    const error = refusal('error-merge-conflict.json')
    const html = view(milk, initialSelection(milk), { kind: 'failed', action: confirm, error, message: 'У записей разные значения.' })
    expect(html).toMatch(/<fieldset role="radiogroup" aria-required="true" aria-invalid="true" aria-describedby="merge-resolution-generic-error" class="ck-merge-invalid">/)
    expect(html).toContain('id="merge-resolution-generic-error">Сервер отклонил подтверждение')
    expect(html).toMatch(/role="status" aria-live="polite" class="ck-merge-error">У записей разные значения\.<\/p>/)
  })
  it('marks the name field when the result collides with another product', () => {
    const error: LocalApiFailure = { kind: 'error', reason: 'merge_conflict', status: 409, fields: ['name'] }
    const html = view(pizza, initialSelection(pizza), { kind: 'failed', action: confirm, error, message: 'Совпадение по названию.' })
    expect(html).toMatch(/<select id="merge-name" aria-invalid="true"/)
  })
  it('disables every control while a request is running and names the running action', () => {
    const html = view(milk, selectResolution(initialSelection(milk), 'generic', 2), { kind: 'pending', action: confirm })
    expect(button(html, 'Подтверждаем…')).toContain('disabled=""')
    expect(button(html, 'Отменить слияние')).toContain('disabled=""')
    expect(html.match(/<button[^>]*disabled=""[^>]*>Исключить из группы<\/button>/g)).toHaveLength(3)
    expect(html.match(/<input type="radio"[^>]*disabled=""/g)).toHaveLength(5)
    expect(html).toMatch(/<select id="merge-name" disabled=""/)
    const excluding = view(pizza, initialSelection(pizza), { kind: 'pending', action: { type: 'exclude', id: 2, input: { version: 1, product_id: 43 } } })
    expect(excluding.match(/>Исключаем…<\/button>/g)).toHaveLength(1)
    expect(excluding).toMatch(/aria-label="Исключить из группы запись №43: Steinof.PizzaSpezial"[^>]*>Исключаем…/)
  })
  it('offers «Повторить» only after merge_busy and only as an explicit button', () => {
    const busy = view(pizza, initialSelection(pizza), { kind: 'failed', action: confirm, error: refusal('error-merge-busy.json'), message: 'Каталог сейчас изменяется.' })
    expect(busy).toContain('Каталог сейчас изменяется.')
    expect(busy).toContain('>Повторить</button>')
    expect(button(busy, 'Подтвердить слияние')).not.toContain('disabled')
    for (const name of ['error-merge-changed.json', 'error-merge-resolved.json', 'error-merge-conflict.json']) {
      expect(view(pizza, initialSelection(pizza), { kind: 'failed', action: confirm, error: refusal(name), message: 'Отказ.' })).not.toContain('>Повторить</button>')
    }
  })
  it('reports a changed group with the reset choice', () => {
    const next = { ...pizza, version: 2 }
    const html = view(next, initialSelection(next), { kind: 'failed', action: confirm, error: refusal('error-merge-changed.json'), message: 'Состав группы изменился. Данные обновлены, выбор сброшен.' })
    expect(html).toContain('Состав группы изменился. Данные обновлены, выбор сброшен.')
    expect(checked(html, 'merge-target')).toEqual(['5'])
  })
  it.each(['group-confirmed.json', 'group-cancelled.json'])('hides every action of the finished %s', (name) => {
    const html = view(group(name), initialSelection(group(name)), { kind: 'failed', action: confirm, error: refusal('error-merge-resolved.json'), message: 'Слияние уже завершено. Показано актуальное состояние группы.' })
    expect(html).not.toContain('<button')
    expect(html).not.toContain('<input')
    expect(html).not.toContain('<select')
    expect(html).toContain('действия с группой больше недоступны')
    expect(html).toContain('Слияние уже завершено. Показано актуальное состояние группы.')
    expect(html).not.toContain('<th scope="col">Действие</th>')
  })
  it('shows an excluded record without a choice or an action', () => {
    const data = { ...pizza, version: 2, members: pizza.members.map((member) => member.product_id === 43
      ? { ...member, state: 'excluded' as const, lines_count: 0, first_purchased_on: null, last_purchased_on: null, aliases: [] } : member) }
    const html = view(data)
    expect(html).toContain('Запись №43 · исключена из группы')
    expect(html).toContain('href="/catalog/products/43"')
    expect(html.match(/name="merge-target"/g)).toHaveLength(2)
    expect(html.match(/>Исключить из группы<\/button>/g)).toHaveLength(2)
    expect(html).not.toContain('<option value="43"')
    expect(html).toContain('Нет покупок')
  })
  it('summarises the current and the final state of a group', () => {
    const pending = renderToStaticMarkup(<MergeSummary group={milk} />)
    expect(pending).toContain('Ожидает подтверждения'); expect(pending).toContain('Есть конфликт данных')
    expect(pending).toContain('href="/catalog/products/2"')
    const withNew = renderToStaticMarkup(<MergeSummary group={pizza} />)
    expect(withNew).toContain('5 · 1 добавлена после слияния')
    const confirmed = renderToStaticMarkup(<MergeSummary group={group('group-confirmed.json')} />)
    expect(confirmed).toContain('Слияние подтверждено: остался товар'); expect(confirmed).toContain('Завершена')
    expect(renderToStaticMarkup(<MergeSummary group={group('group-cancelled.json')} />)).toContain('Слияние отменено: записи снова отдельные товары')
  })
})

describe('purchases of a group', () => {
  it('shows the printed name, the original record, money as strings and the receipt link', () => {
    const html = renderToStaticMarkup(<MergeLines group={pizza} lines={lines()} onPage={noop} />)
    expect(html).toContain('5 покупок · страница 1 из 1')
    expect(html.match(/<th scope="row">/g)).toHaveLength(5)
    expect(html).toContain('<th scope="row">Steinof.PizzaSpezial</th><td>№43: Steinof.PizzaSpezial</td>')
    expect(html).toContain('<th scope="row">Steinhof PizzaSpezial</th><td>№26: Steinhof PizzaSpezial</td>')
    expect(html).toContain('<td>Добавлена после слияния</td>')
    expect(html).toContain('<time dateTime="2026-10-01">01.10.2026</time>')
    expect(html).toContain('3,49 EUR'); expect(html).toContain('3,59 EUR'); expect(html).toContain('1 шт')
    expect(html).toContain('href="/receipts/13">Чек №13</a>')
    expect(html).toContain('Musterstadt · DE')
    expect(html).not.toContain('<nav')
  })
  it('paginates locally with buttons', () => {
    const html = renderToStaticMarkup(<MergeLines group={pizza} lines={{ ...lines(), count: 120, pages: 3, page: 2 }} onPage={noop} />)
    expect(html).toContain('aria-label="Страницы покупок группы"')
    expect(html).toContain('>Предыдущая</button>'); expect(html).toContain('>Следующая</button>')
    expect(html).toMatch(/aria-current="page" disabled="">2<\/button>/)
  })
  it('explains the empty list of a cancelled group', () => {
    const html = renderToStaticMarkup(<MergeLines group={group('group-cancelled.json')} lines={{ ...lines(), count: 0, pages: 0, results: [] }} onPage={noop} />)
    expect(html).toContain('покупки возвращены исходным товарам')
    expect(html).not.toContain('<table')
  })
})

describe('group page requests', () => {
  it('shows loading without the form or the purchases', () => {
    const html = renderToStaticMarkup(<MergePage groupId={2} />)
    expect(html).toContain('Группа №2'); expect(html).toContain('Загружаем данные…')
    expect(html).toContain('href="/catalog/merges">К списку групп</a>')
    expect(html).not.toContain('Записи группы'); expect(html).not.toContain('Покупки группы')
  })
  it('returns to the list it came from', () => {
    expect(renderToStaticMarkup(<MergePage groupId={2} returnTo="/catalog/merges?status=all&page=2" />))
      .toContain('href="/catalog/merges?status=all&amp;page=2">К списку групп</a>')
  })
  it('shows the group, its form and independently loading purchases', () => {
    mocked.states = [success(milk), { kind: 'loading' }]
    const html = renderToStaticMarkup(<MergePage groupId={1} />)
    expect(html).toContain('Ожидает подтверждения'); expect(html).toContain('Записи группы'); expect(html).toContain('Подтвердить слияние')
    expect(html).toMatch(/aria-labelledby="merge-lines-title" aria-busy="true"/)
  })
  it('keeps the group usable when purchases fail', () => {
    mocked.states = [success(pizza), failed('network')]
    const html = renderToStaticMarkup(<MergePage groupId={2} />)
    expect(html).toContain('Подтвердить слияние'); expect(html).toContain('Нет ответа сервера'); expect(html).toContain('>Повторить</button>')
  })
  it('shows purchases of the loaded group', () => {
    mocked.states = [success(pizza), success(lines())]
    expect(renderToStaticMarkup(<MergePage groupId={2} />)).toContain('Добавлена после слияния')
  })
  it('explains a missing group, a switched-off API and a read failure', () => {
    mocked.states = [failed('not_found', 404)]
    const missing = renderToStaticMarkup(<MergePage groupId={99} />)
    expect(missing).toContain('Группа не найдена'); expect(missing).not.toContain('>Повторить</button>')
    mocked.states = [failed('permission_denied', 403)]
    const off = renderToStaticMarkup(<MergePage groupId={2} />)
    expect(off).toContain('Локальный API выключен'); expect(off).toContain('>Повторить</button>'); expect(off).not.toContain('Записи группы')
    mocked.states = [failed('server', 500)]
    expect(renderToStaticMarkup(<MergePage groupId={2} />)).toContain('Сервис временно недоступен')
  })
})
