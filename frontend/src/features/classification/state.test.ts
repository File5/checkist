import { describe, expect, it } from 'vitest'
import type { Classification, ClassificationRun } from '../../api/product-classifications'
import type { LocalApiFailure } from '../../api/types'
import { apiOffText, categoryText, errorText, productFacts, runText, statusLabel, uncertain, unitLabels } from './labels'
import {
  applyRunRequest, areaKey, batches, canRequestRun, chooseOptions, confirmable, confirmItems, groupRecords, listParams, openArea, replaceRecords,
  runActive, runFinished, searchQuery, stateActive,
} from './state'
import { generics, record, records, runRequest, stateOf } from './test-support'

describe('list request of the screen', () => {
  it('asks for pending records grouped by the suggested generic product, 200 per page', () => {
    expect(listParams({ page: 1 })).toEqual({ status: 'pending', page: 1, page_size: 200, ordering: 'generic' })
    expect(listParams({ product: 13, page: 2 })).toEqual({ status: 'pending', product: 13, page: 2, page_size: 200, ordering: 'generic' })
  })
  it('asks for the other filters as a plain list, new first, and for «Все» without a status', () => {
    expect(listParams({ status: 'confirmed', page: 3 })).toEqual({ status: 'confirmed', page: 3, page_size: 200, ordering: '-id' })
    expect(listParams({ status: 'rejected', product: 13, page: 1 })).toEqual({ status: 'rejected', product: 13, page: 1, page_size: 200, ordering: '-id' })
    expect(listParams({ status: 'superseded', page: 1 })).toMatchObject({ status: 'superseded', ordering: '-id' })
    expect(listParams({ status: 'all', page: 1 })).toEqual({ page: 1, page_size: 200, ordering: '-id' })
  })
})

describe('groups of pending records', () => {
  it('groups by the suggested generic product and keeps the order of the server', () => {
    const groups = groupRecords(records().results)
    expect(groups.map((group) => [group.generic.name, group.records.map((item) => item.id), group.pendingCount, group.generic.is_new]))
      .toEqual([['Кефир', [1, 2], 2, true], ['Колбаса', [3], 1, true], ['Молоко', [4], 1, false]])
    expect(groups[1].category?.path.map((item) => [item.name, item.is_new])).toEqual([['Продукты питания', false], ['Мясные продукты', true]])
  })
  it('never re-sorts: code-point order of the database (latin, Ё, А…Я, а…я) stays as sent', () => {
    const named = (name: string, id: number): Classification => {
      const item = structuredClone(records().results[0])
      Object.assign(item, { id })
      Object.assign(item.suggested.generic, { id: 100 + id, name })
      return item
    }
    const sent = [named('Milk', 1), named('Ёжик', 2), named('Яблоко', 3), named('арбуз', 4), named('ёлка', 5)]
    expect(groupRecords(sent).map((group) => group.generic.name)).toEqual(['Milk', 'Ёжик', 'Яблоко', 'арбуз', 'ёлка'])
  })
  it('groups by id, not by name: two generic products may share a name', () => {
    const [first, second] = structuredClone(records().results)
    second.suggested.generic.id = 193
    expect(groupRecords([first, second]).map((group) => group.records.length)).toEqual([1, 1])
  })
  it('collects only actionable pending records for «Подтвердить все», each with its own version', () => {
    const [first, second, third] = structuredClone(records().results)
    second.version = 4
    Object.assign(third.actions, { can_confirm: false, can_choose: false, can_reject: false })
    const decided = record('classification-confirmed.json')
    expect(confirmItems(confirmable([first, second, third, decided]))).toEqual([{ id: 1, version: 1 }, { id: 2, version: 4 }])
  })
  it('splits a large group into requests of at most 100 records', () => {
    const items = Array.from({ length: 250 }, (_, index) => ({ id: index + 1, version: 1 }))
    expect(batches(items).map((batch) => batch.length)).toEqual([100, 100, 50])
    expect(batches(items.slice(0, 100)).map((batch) => batch.length)).toEqual([100])
    expect(batches(items.slice(0, 101)).map((batch) => [batch[0].id, batch.length])).toEqual([[1, 100], [101, 1]])
    expect(batches([])).toEqual([])
  })
  it('replaces the answered records and leaves the page counters to the next read', () => {
    const page = records()
    const confirmed = record('classification-confirmed.json')
    const next = replaceRecords(page, [confirmed, { ...confirmed, id: 99 }])
    expect(next.results.map((item) => [item.id, item.status])).toEqual([[1, 'pending'], [2, 'pending'], [3, 'pending'], [4, 'confirmed']])
    expect(next.count).toBe(page.count)
  })
})

describe('options of «Выбрать другой»', () => {
  it('drops the service «Не разобрано» in any case and the generic product already suggested', () => {
    const kefir = records().results[0]
    expect(chooseOptions(generics().results, kefir).map((item) => item.name)).toEqual(['Молоко', 'Творог'])
    const odd = generics().results.map((item) => item.id === 91 ? { ...item, name: '  не РАЗОБРАНО ' } : item)
    expect(chooseOptions(odd, records().results[3]).map((item) => item.name)).toEqual(['Кефир', 'Творог'])
  })
  it('searches from 2 characters and sends nothing for an empty or one-character text', () => {
    expect(searchQuery('')).toEqual({ short: false })
    expect(searchQuery('   ')).toEqual({ short: false })
    expect(searchQuery(' с ')).toEqual({ short: true })
    expect(searchQuery('😀')).toEqual({ short: true })
    expect(searchQuery(' сы ')).toEqual({ q: 'сы', short: false })
  })
})

describe('run state', () => {
  const run = (status: ClassificationRun['status']) => ({ ...stateOf('status-queued.json').run!, status })
  it('polls only while the run is queued or running', () => {
    expect([run('queued'), run('running'), run('succeeded'), run('failed'), run('cancelled'), null, undefined].map(runActive))
      .toEqual([true, true, false, false, false, false, false])
    expect(stateActive(stateOf('status-queued.json'))).toBe(true)
    expect(stateActive(stateOf('status-running.json'))).toBe(true)
    expect(stateActive(stateOf('status.json'))).toBe(false)
    expect(stateActive(stateOf('status-empty.json'))).toBe(false)
  })
  it('reports the end of a run exactly once: when an active run is not active any more', () => {
    const [queued, running, done, empty] = ['status-queued.json', 'status-running.json', 'status.json', 'status-empty.json'].map(stateOf)
    expect(runFinished(undefined, done)).toBe(false)
    expect(runFinished(queued, running)).toBe(false)
    expect(runFinished(running, done)).toBe(true)
    expect(runFinished(queued, done)).toBe(true)
    expect(runFinished(running, empty)).toBe(true)
    expect(runFinished(done, done)).toBe(false)
    expect(runFinished(done, queued)).toBe(false)
  })
  it('allows a new run only with candidates and without an active run', () => {
    expect(canRequestRun(stateOf('status.json'))).toBe(true)
    expect(canRequestRun(stateOf('status-queued.json'))).toBe(false)
    expect(canRequestRun(stateOf('status-running.json'))).toBe(false)
    expect(canRequestRun(stateOf('status-empty.json'))).toBe(false)
    expect(canRequestRun({ ...stateOf('status.json'), unclassified_count: 0 })).toBe(false)
  })
  it('shows the answered run and worker at once and keeps the last run when nothing was queued', () => {
    const before = stateOf('status.json')
    const created = runRequest('run-created.json')
    expect(applyRunRequest(before, created)).toEqual({ ...before, run: created.run, executor: created.executor })
    expect(applyRunRequest(before, runRequest('run-nothing.json')).run).toEqual(before.run)
  })
})

describe('open inline area', () => {
  it('lives only while its record or group can still be acted on', () => {
    const list = structuredClone(records().results)
    expect(openArea({ kind: 'reject', id: 1 }, list)).toEqual({ kind: 'reject', id: 1 })
    expect(openArea({ kind: 'choose', id: 3 }, list)).toEqual({ kind: 'choose', id: 3 })
    expect(openArea({ kind: 'bulk', genericId: 93 }, list)).toEqual({ kind: 'bulk', genericId: 93 })
    expect(openArea({ kind: 'reject', id: 77 }, list)).toBeUndefined()
    expect(openArea({ kind: 'bulk', genericId: 777 }, list)).toBeUndefined()
    expect(openArea(undefined, list)).toBeUndefined()
    Object.assign(list[0].actions, { can_confirm: false, can_choose: false, can_reject: false })
    expect(openArea({ kind: 'reject', id: 1 }, list)).toBeUndefined()
    expect(openArea({ kind: 'bulk', genericId: 93 }, list)).toEqual({ kind: 'bulk', genericId: 93 })
    expect(openArea({ kind: 'choose', id: 4 }, [record('classification-confirmed.json')])).toBeUndefined()
  })
  it('names an area for the focus return', () => {
    expect([areaKey({ kind: 'reject', id: 5 }), areaKey({ kind: 'choose', id: 5 }), areaKey({ kind: 'bulk', genericId: 93 })]).toEqual(['reject-5', 'choose-5', 'bulk-93'])
  })
})

describe('labels', () => {
  it('names every state and resolution as the contract does', () => {
    const labels = ([
      ['pending', null], ['confirmed', 'confirmed'], ['confirmed', 'other'], ['rejected', 'rejected'], ['rejected', 'cancelled'],
      ['superseded', 'changed'], ['superseded', 'merged'], ['superseded', 'product_removed'],
    ] as const).map(([status, resolution]) => statusLabel({ status, resolution }))
    expect(labels).toEqual([
      'Ожидает подтверждения', 'Подтверждено', 'Выбран другой обобщённый продукт', 'Отклонено', 'Отменено командой',
      'Заменено: обобщённый продукт изменён вручную', 'Заменено: товар объединён с другим', 'Заменено: товар удалён',
    ])
    expect(unitLabels).toEqual({ kg: 'кг', l: 'л', pcs: 'шт' })
  })
  it('joins a category path with arrows and lists only the known facts of a product', () => {
    expect(categoryText(records().results[2].suggested.category)).toBe('Продукты питания → Мясные продукты')
    expect(categoryText(null)).toBe('Категория не указана')
    expect(categoryText({ path: [{ name: '  ' }] })).toBe('Не указано')
    expect(productFacts(records().results[2].product)).toBe('Бренд: Demowurst · Фасовка: 200 г')
    expect(productFacts(records().results[0].product)).toBe('Фасовка: 500 г')
    expect(productFacts({ brand: null, package: null })).toBe('')
  })

  const queued = stateOf('status-queued.json')
  const withRun = (patch: Partial<ClassificationRun>, state = 'absent') =>
    runText({ run: { ...queued.run!, ...patch }, executor: { available: state !== 'absent', state: state as 'idle', last_seen_at: null } })
  it('describes a queued run by the state of the worker', () => {
    expect(withRun({})).toEqual({ text: 'Запуск в очереди. Воркер распознавания не запущен: запуск начнётся, когда воркер запустят.', warning: true })
    expect(withRun({}, 'busy')).toEqual({ text: 'Запуск в очереди. Воркер занят другим заданием.', warning: false })
    expect(withRun({}, 'idle')).toEqual({ text: 'Запуск в очереди и начнётся в ближайшие секунды.', warning: false })
  })
  it('says nothing about the worker when its state is unknown', () => {
    expect(withRun({}, 'unknown')).toEqual({ text: 'Запуск в очереди.', warning: false })
  })
  it('shows the progress of a started run that waits in the queue between its batches', () => {
    const between = { started_at: '2026-10-06T21:13:45.465650Z', progress: { requested: 10, processed: 4, applied: 3, unknown: 1, skipped: 0 } }
    expect(withRun(between, 'idle')).toEqual({ text: 'Модель предлагает категории: обработано 4 из 10.', warning: false })
    expect(withRun(between, 'unknown')).toEqual({ text: 'Модель предлагает категории: обработано 4 из 10.', warning: false })
    expect(withRun(between, 'busy')).toEqual({ text: 'Модель предлагает категории: обработано 4 из 10. Воркер занят другим заданием.', warning: false })
    expect(withRun(between)).toEqual({
      text: 'Запуск приостановлен: обработано 4 из 10. Воркер распознавания не запущен: запуск продолжится, когда воркер запустят.', warning: true,
    })
    for (const state of ['absent', 'busy', 'idle', 'unknown']) expect(withRun(between, state)?.text).not.toContain('начнётся')
  })
  it('describes a running, finished, failed and cancelled run', () => {
    expect(runText(stateOf('status-running.json'))?.text).toBe('Модель предлагает категории: обработано 0 из 2.')
    expect(withRun({ status: 'running', progress: { requested: 1200, processed: 25, applied: 20, unknown: 3, skipped: 2 } })?.text)
      .toBe('Модель предлагает категории: обработано 25 из 1 200.')
    expect(runText(stateOf('status.json'))?.text).toBe('Запуск завершён: предложено 8, не распознано 1, пропущено 0.')
    expect(withRun({ status: 'succeeded', remaining: 12 })?.text).toBe('Запуск завершён: предложено 0, не распознано 0, пропущено 0. Без предложения осталось 12: запустите ещё раз.')
    expect(withRun({ status: 'failed', error: { code: 'invalid_output', message: 'private' } }))
      .toEqual({ text: 'Запуск завершился ошибкой: ответ модели не прошёл проверку. Уже предложенные категории сохранены.', warning: true })
    expect(withRun({ status: 'cancelled' })?.text).toBe('Запуск отменён.')
    expect(runText(stateOf('status-empty.json'))).toBeUndefined()
  })
  it('translates every run error code locally and never prints the server message', () => {
    const codes = ['auth_required', 'network_unavailable', 'rate_limited', 'provider_unavailable', 'configuration_error', 'invalid_input',
      'invalid_output', 'timeout', 'worker_lost', 'input_too_large']
    const texts = codes.map((code) => withRun({ status: 'failed', error: { code, message: 'СЕРВЕРНЫЙ ТЕКСТ' } })!.text)
    expect(new Set(texts).size).toBe(codes.length)
    for (const text of texts) {
      expect(text).toMatch(/^Запуск завершился ошибкой: [а-яё ]+\. Уже предложенные категории сохранены\.$/)
      expect(text).not.toContain('СЕРВЕРНЫЙ')
    }
    for (const code of ['internal_error', 'something_new', 'constructor']) {
      expect(withRun({ status: 'failed', error: { code, message: 'СЕРВЕРНЫЙ ТЕКСТ' } })?.text).toBe('Запуск завершился ошибкой. Уже предложенные категории сохранены.')
    }
  })

  const error = (reason: LocalApiFailure['reason']): LocalApiFailure => ({ kind: 'error', reason })
  it('uses the contract texts for refused actions', () => {
    expect(errorText(error('classification_busy'), 'action')).toBe('Каталог сейчас изменяется: идёт импорт чека, слияние дублей или другое действие. Ничего не сохранено.')
    expect(errorText(error('classification_changed'), 'action')).toBe('Предложение изменилось. Данные обновлены: проверьте запись и повторите действие.')
    expect(errorText(error('classification_resolved'), 'action')).toBe('Предложение уже решено. Показано актуальное состояние.')
    expect(errorText(error('invalid_parameter'), 'choose')).toBe('Этот обобщённый продукт больше недоступен. Выберите другой.')
    expect(errorText(error('csrf_failed'), 'action')).toBe('Токен безопасности устарел. Повторите действие.')
    for (const reason of ['network', 'timeout', 'server', 'database_unavailable'] as const) {
      expect(errorText(error(reason), 'action')).toBe('Ответ сервера не получен. Действие могло выполниться: проверьте состояние записи перед повтором.')
      expect(errorText(error(reason), 'choose')).toBe('Ответ сервера не получен. Действие могло выполниться: проверьте состояние записи перед повтором.')
    }
    expect(errorText(error('permission_denied'), 'action')).toBe(apiOffText)
    expect(apiOffText).toBe('Локальный API выключен или недоступен с этого адреса. Запустите сервер с ALLOW_LOCAL_RECOGNITION_API=1 и откройте приложение с этого компьютера.')
  })
  it('gives a read failure its own text and a different one for an action', () => {
    expect(errorText(error('permission_denied'))).toBe(apiOffText)
    expect(errorText(error('network'))).toBe('Нет ответа сервера. Проверьте соединение и повторите запрос.')
    expect(errorText(error('server'))).toBe('Сервис временно недоступен. Повторите запрос позже.')
    expect(errorText(error('page_out_of_range'))).toBe('Такой страницы больше нет. Откройте первую страницу.')
    expect(errorText(error('invalid_parameter'))).not.toBe(errorText(error('invalid_parameter'), 'action'))
    expect(errorText(error('invalid_parameter'), 'action')).not.toBe(errorText(error('invalid_parameter'), 'choose'))
    expect(errorText(error('upload_too_large'))).toBe('Запрос не выполнен. Повторите действие позже.')
  })
  it('knows after which failures the action may have been saved', () => {
    expect((['network', 'timeout', 'server', 'database_unavailable', 'invalid_response'] as const).map((reason) => uncertain(error(reason)))).toEqual([true, true, true, true, true])
    expect((['classification_busy', 'classification_changed', 'classification_resolved', 'invalid_parameter', 'csrf_failed', 'permission_denied', 'not_found'] as const)
      .map((reason) => uncertain(error(reason)))).toEqual([false, false, false, false, false, false, false])
  })
})
