import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CountryEntry } from '../../api/countries'
import { readError } from '../../api/http'
import type { NormalizedLine, ReceiptImageDetail, ReviewConfirmResult } from '../../api/recognition'
import { isJobDetail, isReceiptImageDetail, isReviewConfirmResult } from '../../api/recognition-schema'
import { issue, publicFixture } from '../../api/recognition-test-support'
import ActionButtons from './ActionButtons'
import JobSummary from './JobSummary'
import ReceiptImages from './ReceiptImages'
import { reviewErrorText } from './labels'
import ReviewForm from './ReviewForm'
import type { ReviewFormProps } from './ReviewForm'
import { buildInput, createReview, missingRequired, reviewReducer } from './review-state'
import type { ReviewEdit, ReviewState } from './review-state'
import { refusalText } from './review-actions'
import type { ReviewActionState } from './review-actions'

function image(): ReceiptImageDetail { const value = publicFixture('receipt-image.json'); if (!isReceiptImageDetail(value)) throw new Error('Invalid fixture'); return value }
function confirmed(): ReviewConfirmResult { const value = publicFixture('review-confirmed.json'); if (!isReviewConfirmResult(value)) throw new Error('Invalid fixture'); return value }
const countries: CountryEntry[] = [
  { code: 'DE', name: 'Германия', currencies: ['EUR'], stores_count: 1, products_count: 1 }, { code: 'KZ', name: 'Казахстан', currencies: [], stores_count: 0, products_count: 0 },
]
const start = () => createReview(image().normalized_result, image().issues)
const apply = (state: ReviewState, ...edits: ReviewEdit[]) => edits.reduce(reviewReducer, state)
const form = (state: ReviewState, props: Partial<ReviewFormProps> = {}) => renderToStaticMarkup(
  <ReviewForm imageId={42} state={state} dispatch={vi.fn()} countries={countries} pending={false} onConfirm={vi.fn()} {...props} />)
const cards = (item: ReceiptImageDetail, state: ReviewActionState, finished = true) => renderToStaticMarkup(
  <ReceiptImages images={[item]} finished={finished} review={{ state, run: async () => undefined }} />)
/** Every control of the markup with its id and the ids it is described by. */
function controls(html: string) {
  return [...html.matchAll(/<(input|select)\b([^>]*)>/g)].map(([, tag, attrs]) => ({
    tag, id: /\bid="([^"]+)"/.exec(attrs)?.[1], described: /aria-describedby="([^"]+)"/.exec(attrs)?.[1]?.split(' ') ?? [], invalid: attrs.includes('aria-invalid="true"'), attrs,
  }))
}

describe('review form SSR markup (interaction in a browser stays manual)', () => {
  it('prefills from the projection, leaves unread fields empty and marked, and offers one confirmation', () => {
    const html = form(start())
    expect(html).toContain('<h4>Исправление и подтверждение</h4>')
    expect(html).toContain('Несохранённые правки хранятся только на этой открытой странице: перезагрузка или закрытие вкладки их стирает, черновика на сервере нет.')
    expect(html).not.toContain('пока недоступны'); expect(html).not.toContain('<form')
    for (const value of ['Тестовый магазин', 'Teststrasse 12', '2026-10-04', '14:35', 'EUR', '4,52', 'МОЛОКО', '1,2900']) expect(html).toContain(`value="${value}"`)
    expect(html).toMatch(/<select id="review-42-receipt-country"[^>]*>.*<option value="DE" selected="">DE · Германия<\/option>/)
    expect(html).toMatch(/<option value="sale" selected="">Покупка<\/option>/); expect(html).toMatch(/<option value="yes" selected="">Включён<\/option>/)
    expect(html).toContain('<datalist id="review-42-currencies"><option value="EUR"></option></datalist>')
    const quantity = controls(html).find((control) => control.id === 'review-42-lines-1-quantity')!
    expect(quantity.attrs).toContain('value=""'); expect(quantity.attrs).toContain('inputMode="decimal"')
    expect(quantity.described).toEqual(['review-42-lines-1-quantity-unread', 'review-42-lines-1-quantity-error'])
    expect(html).toContain('<p id="review-42-lines-1-quantity-unread" class="ck-review-unread">Не прочитано</p>')
    expect(html.match(/class="ck-review-unread"/g)).toHaveLength(4) // quantity, amount, tax kind, tax code
    expect(html.match(/<button[^>]*data-review-confirm[^>]*>[^<]*<\/button>/g)).toEqual([
      '<button type="button" data-review-confirm="true" aria-describedby="review-42-confirm-note">Подтвердить и сохранить чек</button>'])
    expect(html).toContain('<legend>Строка 1</legend>'); expect(html).toContain('Удалить строку 1'); expect(html).toContain('Добавить строку')
    expect(html).toContain('<h4>Скидки (0)</h4>'); expect(html).toContain('Добавить скидку'); expect(html).toContain('<h4>Налоговые итоги (0)</h4>'); expect(html).toContain('Добавить налоговый итог')
  })
  it('gives every control a label and ties the cause to its field', () => {
    const html = form(start())
    const all = controls(html)
    expect(all.length).toBeGreaterThan(15)
    expect(new Set(all.map((control) => control.id)).size).toBe(all.length)
    for (const control of all) {
      expect(control.id, control.attrs).toBeTruthy()
      expect(html, control.id).toContain(`<label for="${control.id}">`)
      for (const id of control.described) expect(html, id).toContain(`id="${id}"`)
    }
    expect(all.filter((control) => control.invalid).map((control) => control.id)).toEqual(['review-42-lines-1-quantity'])
    expect(html).toContain('<p id="review-42-lines-1-quantity-error" class="ck-review-error">Не удалось прочитать обязательное поле</p>')
    expect(html).toContain('<p tabindex="-1" role="status" class="ck-review-notice"></p>')
    // The live line of a refusal exists before any refusal, right before the button.
    expect(html).toMatch(/<p role="status" class="ck-review-refusal"><\/p><div class="ck-rec-action-block"><div class="ck-rec-actions"><button type="button" data-review-confirm/)
  })
  it('labels every field of one record differently: the kind of a tax and its amount are not both «Налог»', () => {
    const state = apply(start(), { type: 'add', list: 'lines' }, { type: 'add', list: 'discounts' }, { type: 'add', list: 'taxes' }, { type: 'add', list: 'taxes' })
    const deposit = apply(state, { type: 'line', key: state.lines[1].key, patch: { kind: 'deposit' } })
    const html = form(deposit)
    const groups = [...html.matchAll(/<fieldset class="ck-review-group"><legend>([^<]+)<\/legend>(.*?)<\/fieldset>/g)].map(([, legend, body]) => ({
      legend, labels: [...body.matchAll(/<label for="[^"]+">([^<]*)<\/label>/g)].map(([, text]) => text) }))
    expect(groups.map((group) => group.legend)).toEqual(['Магазин', 'Чек', 'Строка 1', 'Строка 2 · добавлена вручную', 'Скидка 1', 'Налоговый итог 1', 'Налоговый итог 2'])
    for (const group of groups) expect(new Set(group.labels).size, `${group.legend}: ${group.labels.join(' | ')}`).toBe(group.labels.length)
    expect(groups[5].labels).toEqual(['Вид налога', 'Ставка НДС, %', 'Код налога', 'Сумма без налога', 'Сумма налога', 'Сумма с налогом'])
    expect(groups[3].labels).toEqual(['Название', 'Тип строки', 'Залог к строке', 'Количество', 'Единица', 'Цена за единицу', 'Сумма', 'Вид налога', 'Ставка НДС, %', 'Код налога'])
    expect(groups[4].labels).toEqual(['Название скидки', 'Сумма скидки', 'К чему относится'])
    expect(html).not.toMatch(/<label for="[^"]+">Налог<\/label>/)
  })
  it('asks for a text keyboard at the local time: a numeric one may lack the colon', () => {
    const time = controls(form(start())).find((control) => control.id === 'review-42-receipt-local_time')!
    expect(time.attrs).toContain('type="text"'); expect(time.attrs).not.toContain('inputMode')
  })
  it('marks the fields of a refused confirmation and never prints server phrases', () => {
    const before = apply(start(), { type: 'add', list: 'lines' }, { type: 'add', list: 'discounts' }, { type: 'add', list: 'taxes' }, { type: 'add', list: 'taxes' })
    const { sent } = buildInput(before)
    const fields = reviewReducer(before, { type: 'refused', error: readError(400, publicFixture('review-invalid-parameter.json'), true), sent })
    const html = form(fields)
    expect(controls(html).filter((control) => control.invalid).map((control) => control.id)).toEqual([
      'review-42-receipt-total', 'review-42-lines-1-quantity', `review-42-discounts-${sent.discounts[0]}-line_position`, `review-42-taxes-${sent.taxes[1]}-tax_rate-rate`])
    expect(html).toContain('Запись не принята: проверьте её поля и связи.')
    for (const phrase of ['Неверный тип значения', 'Неверный формат значения', 'Значение обязательно', 'Ссылка на отсутствующую']) expect(html).not.toContain(phrase)
    const invalid = reviewReducer(start(), { type: 'refused', error: readError(409, publicFixture('review-invalid.json'), true), sent: buildInput(start()).sent })
    const refused = form(invalid)
    expect(controls(refused).filter((control) => control.invalid).map((control) => control.id)).toEqual(['review-42-receipt-total'])
    expect(refused).toContain('<p id="review-42-receipt-total-error" class="ck-review-error">Сумма строк не совпадает с итогом</p>')
    expect(refused).not.toContain('Сумма чека не совпадает'); expect(refused).not.toContain('Исправленные данные не прошли проверку.')
  })
  it('shows the store cause at the store search and the chosen store instead of the hint', () => {
    const ambiguous = createReview(image().normalized_result, [issue('store_ambiguous', 'error', { attribute: 'store' })])
    const html = form(ambiguous)
    expect(html).toContain('<label for="review-42-receipt-store">Найти существующий магазин</label>')
    expect(html).toMatch(/<input id="review-42-receipt-store" aria-invalid="true" aria-describedby="review-42-receipt-store-hint review-42-receipt-store-error" type="search"/)
    expect(html).toContain('Найдено несколько подходящих магазинов'); expect(html).toContain('Существующий магазин не выбран')
    const chosen = form(apply(ambiguous, { type: 'header', patch: { store: { id: 51, label: 'ID 51 · Same Chain · адрес неизвестен · Berlin · DE' } } }))
    expect(chosen).toContain('Выбран существующий магазин: <strong>ID 51 · Same Chain · адрес неизвестен · Berlin · DE</strong>')
    expect(chosen).toContain('Не использовать выбранный магазин'); expect(chosen).not.toContain('Найдено несколько подходящих магазинов')
  })
  it('falls back to typed codes without the reference and keeps a recognized code that the reference lacks', () => {
    const typed = form(start(), { countries: null, countriesFailed: true })
    expect(typed).toMatch(/<input id="review-42-receipt-country"[^>]*maxLength="2"[^>]*value="DE"/)
    expect(typed).toContain('Справочник стран не загружен'); expect(typed).toContain('Загрузить справочник')
    expect(form(start(), { countries: null })).not.toContain('Справочник стран не загружен')
    const foreign = form(apply(start(), { type: 'header', patch: { country: 'FR' } }))
    expect(foreign).toContain('<option value="FR" selected="">FR · нет в справочнике</option>')
  })
  it('locks the fields while the request is in flight, keeps the pressed button focusable and explains an unavailable confirmation', () => {
    const pending = form(start(), { pending: true })
    expect(pending).toContain('<fieldset class="ck-review-body" disabled="">')
    // Not the `disabled` attribute: a disabled pressed button would lose focus. A second press is ignored by its state.
    expect(pending).toContain('<button type="button" data-review-confirm="true" aria-disabled="true" aria-describedby="review-42-confirm-note">Сохраняем чек…</button>')
    expect(pending.slice(pending.indexOf('</fieldset><p tabindex="-1" role="status" class="ck-review-notice">'))).not.toContain('disabled=""')
    const waiting = form(start(), { unavailable: 'Задание ещё не завершено: подтверждение станет доступно после окончания обработки.' })
    expect(waiting).toMatch(/data-review-confirm="true" disabled=""[^>]*>Подтвердить и сохранить чек/)
    expect(waiting).toContain('<p id="review-42-confirm-note" class="ck-rec-note">Задание ещё не завершено'); expect(waiting).toContain('<fieldset class="ck-review-body">')
  })
  it('offers the deposit link only to a deposit and only product lines as its target', () => {
    let state = apply(start(), { type: 'add', list: 'lines' }, { type: 'add', list: 'lines' })
    const [first, second, third] = state.lines
    state = apply(state, { type: 'line', key: second.key, patch: { kind: 'service', name: 'ДОСТАВКА' } }, { type: 'line', key: third.key, patch: { kind: 'deposit', name: 'PFAND', parent: first.key } }, { type: 'add', list: 'discounts' })
    const html = form(state)
    expect(html.match(/Залог к строке/g)).toHaveLength(1)
    expect(html).toMatch(new RegExp(`<select id="review-42-lines-${third.key}-parent_position"[^>]*><option value="">Не связан</option><option value="${first.key}" selected="">Строка 1: МОЛОКО</option></select>`))
    expect(html).toMatch(new RegExp(`<select id="review-42-discounts-${state.discounts[0].key}-line_position"[^>]*><option value="" selected="">Весь чек</option><option value="${first.key}">Строка 1: МОЛОКО</option><option value="${second.key}">Строка 2: ДОСТАВКА</option><option value="${third.key}">Строка 3: PFAND</option></select>`))
    expect(html).toContain('<legend>Строка 2 · добавлена вручную</legend>')
    expect(html).toMatch(new RegExp(`<input id="review-42-lines-${second.key}-tax_rate-rate"[^>]*disabled=""`))
  })
  it('renders a long receipt of 25 lines with distinct controls and long texts intact', () => {
    const name = 'ОЧЕНЬ ДЛИННОЕ НАЗВАНИЕ ТОВАРА '.repeat(8).trim()
    const lines = Array.from({ length: 25 }, (_, index): NormalizedLine => ({ ...image().normalized_result!.lines[0], position: index + 1, name: `${name} ${index + 1}`, quantity: '1.000', amount: '1.29' }))
    const state = createReview({ ...image().normalized_result!, lines }, [])
    const html = form(state)
    expect(html.match(/<legend>Строка \d+<\/legend>/g)).toHaveLength(25); expect(html).toContain('<h4>Строки (25)</h4>')
    const all = controls(html)
    expect(new Set(all.map((control) => control.id)).size).toBe(all.length); expect(all.length).toBeGreaterThan(25 * 9)
    expect(html).toContain(`value="${name} 25"`); expect(html).toContain('Удалить строку 25')
    expect(buildInput(state).input.lines.map((line) => line.position)).toEqual(Array.from({ length: 25 }, (_, index) => index + 1))
  })
  it('announces local row actions in the status line of the form', () => {
    const html = form(apply(start(), { type: 'remove', list: 'lines', key: 1 }))
    expect(html).toContain('<p tabindex="-1" role="status" class="ck-review-notice">Строка 1 удалена.</p>')
    expect(html).toContain('Строк нет. Чек без строк сохранить нельзя.')
  })
  it('has in the document every element that a removal names as the place of focus', () => {
    const filled = apply(start(), { type: 'add', list: 'lines' }, { type: 'add', list: 'discounts' }, { type: 'add', list: 'discounts' }, { type: 'add', list: 'taxes' }, { type: 'add', list: 'taxes' })
    const id = (field: string) => `id="review-42-${field.replaceAll('.', '-')}"`
    for (const list of ['lines', 'discounts', 'taxes'] as const) {
      const next = apply(filled, { type: 'remove', list, key: filled[list][0].key })
      expect(next.notice.focus).toMatch(new RegExp(`^${list}\\.${filled[list][1].key}\\.`)); expect(form(next), list).toContain(id(next.notice.focus!))
      const empty = apply(next, { type: 'remove', list, key: filled[list][1].key })
      expect(empty.notice.focus).toBe(`${list}.add`); expect(form(empty), list).toMatch(new RegExp(`<button type="button" ${id(empty.notice.focus!)}[^>]*>Добавить `))
    }
  })
  const noticeLine = (html: string) => /<p tabindex="-1" role="status" class="ck-review-notice">([^<]*)<\/p>/.exec(html)![1]
  it('prints «Запрос не отправлен…» only while it is true: not in the pending markup and not next to a refusal', () => {
    const empty = apply(start(), { type: 'header', patch: { total: '' } })
    const stopped = reviewReducer(empty, { type: 'missing', problems: missingRequired(empty) })
    expect(noticeLine(form(stopped))).toBe('Запрос не отправлен: заполните обязательные поля (1).')
    expect(form(stopped)).toContain('<p id="review-42-receipt-total-error" class="ck-review-error">Заполните поле.</p>')
    const typed = reviewReducer(stopped, { type: 'header', patch: { total: '9,99' } })
    expect(form(typed)).not.toContain('Запрос не отправлен'); expect(form(typed)).not.toContain('Заполните поле.')
    // The second press: the request is sent, «Сохраняем чек…» stands without the text of the stopped press.
    const sent = reviewReducer(typed, { type: 'sent' })
    const pending = form(sent, { pending: true })
    expect(pending).toContain('>Сохраняем чек…</button>'); expect(pending).not.toContain('Запрос не отправлен'); expect(noticeLine(pending)).toBe('')
    const error = readError(409, publicFixture('review-invalid.json'), true)
    const refused = form(reviewReducer(sent, { type: 'refused', error, sent: buildInput(sent).sent }), { refusal: reviewErrorText(error) })
    expect(refused).toContain(`<p role="status" class="ck-review-refusal">${reviewErrorText(error)}</p>`)
    expect(refused).not.toContain('Запрос не отправлен'); expect(noticeLine(refused)).toBe('')
    // Also when the press follows the stopped one at once (nothing typed in between, the state of the reducer after `sent`).
    const direct = reviewReducer(stopped, { type: 'sent' })
    expect(form(direct, { pending: true })).not.toContain('Запрос не отправлен'); expect(form(direct, { refusal: reviewErrorText(error) })).not.toContain('Запрос не отправлен')
  })
  it('has in the document every element that a stopped press names as the place of focus', () => {
    const id = (field: string) => `id="review-42-${field.replaceAll('.', '-')}"`
    const filled = apply(createReview(null, []), { type: 'add', list: 'discounts' }, { type: 'add', list: 'taxes' })
    const blank = apply(filled, { type: 'line', key: filled.lines[0].key, patch: { kind: '' } }, { type: 'tax', key: filled.taxes[0].key, patch: { taxKind: '' } })
    const missing = Object.keys(missingRequired(blank))
    expect(missing).toHaveLength(8)
    for (const field of missing) expect(form(blank), field).toMatch(new RegExp(`<(input|select) ${id(field)}[ >]`))
    const empty = apply(start(), { type: 'remove', list: 'lines', key: 1 })
    const stopped = reviewReducer(empty, { type: 'missing', problems: missingRequired(empty) })
    expect(form(stopped)).toMatch(new RegExp(`<button type="button" ${id(stopped.notice.focus!)}[^>]*>Добавить строку</button>`))
    expect(form(stopped)).toContain('<p class="ck-review-error" role="alert">Добавьте хотя бы одну строку.</p>')
  })
  it('names the country field as the place of focus of «Загрузить справочник», which disappears with its press', () => {
    const html = form(start(), { countries: null, countriesFailed: true })
    expect(html).toContain('<button type="button" class="ck-review-secondary" data-review-focus="review-42-receipt-country">Загрузить справочник</button>')
    expect(html).toContain('<input id="review-42-receipt-country"')
    // The same id belongs to the select that replaces the input once the reference is read.
    expect(form(start())).toContain('<select id="review-42-receipt-country"'); expect(form(start())).not.toContain('data-review-focus')
  })
})

describe('crop card around the confirmation', () => {
  it('keeps the confirmation unavailable until the job is finished and while another action runs', () => {
    expect(cards(image(), { kind: 'idle' }, false)).toMatch(/data-review-confirm="true" disabled=""/)
    expect(cards(image(), { kind: 'idle' }, false)).toContain('Задание ещё не завершено: подтверждение станет доступно после окончания обработки. Править поля можно уже сейчас.')
    expect(cards(image(), { kind: 'idle' })).not.toMatch(/data-review-confirm="true" disabled=""/)
    const busy = renderToStaticMarkup(<ReceiptImages images={[image()]} finished busy />)
    expect(busy).toMatch(/data-review-confirm="true" disabled=""/); expect(busy).toContain('Выполняется другое действие с заданием')
    const other = cards(image(), { kind: 'pending', imageId: 41 })
    expect(other).toMatch(/data-review-confirm="true" disabled=""/); expect(other).toContain('Сохраняется другой чек этого задания'); expect(other).toContain('<fieldset class="ck-review-body">')
    expect(cards(image(), { kind: 'pending', imageId: 42 })).toContain('Сохраняем чек…')
  })
  it('shows the saved crop from the answer at once: status, receipt link, manual mark and announced result', () => {
    const html = cards(image(), { kind: 'done', imageId: 42, image: confirmed().image, message: 'Подтверждено. Чек №72 сохранён.' })
    expect(html).toContain('<h3>Чек 2 · Чек сохранён</h3>'); expect(html).toContain('href="/receipts/72">Открыть чек №72</a>')
    expect(html).toContain('<p tabindex="-1" role="status" class="ck-rec-result">Подтверждено. Чек №72 сохранён.</p>')
    expect(html).toContain('Подтверждено вручную: <time dateTime="2026-10-04T12:35:00Z">04.10.2026, 12:35 UTC</time>')
    expect(html).not.toContain('Исправление и подтверждение'); expect(html).not.toContain('Причины проверки')
    expect(html).toContain('Тип операции определён автоматически · Операция')
  })
  it('replaces the refusal of the last request by the text of a press that the local check stopped', () => {
    const error = readError(409, { error: { code: 'review_busy' } }, true)
    const failed: ReviewActionState = { kind: 'failed', imageId: 42, error, message: 'Отказ' }
    expect(refusalText(failed, 42, null)).toBe('Отказ'); expect(refusalText(failed, 41, null)).toBeUndefined()
    // The stopped press remembers the refusal it replaced: an edit that erases «Запрос не отправлен…» does not bring it back.
    expect(refusalText(failed, 42, failed)).toBeUndefined()
    expect(refusalText({ kind: 'pending', imageId: 42 }, 42, failed)).toBeUndefined(); expect(refusalText({ kind: 'idle' }, 42, null)).toBeUndefined()
    // The next refusal is a new answer and is shown, also with the same text.
    expect(refusalText({ ...failed }, 42, failed)).toBe('Отказ')
    expect(refusalText({ kind: 'done', imageId: 42, image: confirmed().image, message: 'Подтверждено.' }, 42, null)).toBeUndefined()
  })
  it('keeps the person in the form with the refusal announced next to the pressed button, once', () => {
    const error = readError(409, { error: { code: 'review_busy', message: 'Данные сейчас изменяются. Повторите позже.' } }, true)
    const html = cards(image(), { kind: 'failed', imageId: 42, error, message: 'Данные сейчас изменяются другой операцией, чек не сохранён.' })
    expect(html).toContain('<p role="status" class="ck-review-refusal">Данные сейчас изменяются другой операцией, чек не сохранён.</p><div class="ck-rec-action-block"><div class="ck-rec-actions"><button type="button" data-review-confirm="true" aria-describedby="review-42-confirm-note">Подтвердить и сохранить чек</button>')
    // One live region speaks: the message of the card above the form stays empty while the form is shown.
    expect(html.match(/Данные сейчас изменяются другой операцией/g)).toHaveLength(1)
    expect(html).toContain('<p tabindex="-1" role="status" class="ck-rec-result"></p>')
    expect(html).toContain('Исправление и подтверждение'); expect(html).toContain('value="МОЛОКО"'); expect(html).not.toContain('Повторите позже')
    expect(html).not.toMatch(/data-review-confirm="true" disabled=""/); expect(html).not.toContain('aria-disabled')
    // The message of another crop is not repeated in this card.
    expect(cards(image(), { kind: 'failed', imageId: 41, error, message: 'Чужое сообщение' })).not.toContain('Чужое сообщение')
  })
  it.each([
    [409, 'review_invalid'], [400, 'invalid_parameter'], [400, 'invalid_request'], [409, 'review_busy'], [409, 'review_resolved'], [409, 'review_unavailable'],
    [409, 'job_active'], [404, 'not_found'], [403, 'csrf_failed'], [403, 'permission_denied'],
  ])('shows every refusal at the button without the server phrase: HTTP %i %s', (status, code) => {
    const fixtures: Record<string, string> = { review_invalid: 'review-invalid.json', invalid_parameter: 'review-invalid-parameter.json' }
    const body = code in fixtures ? publicFixture(fixtures[code]) as { error: object } : { error: { code } }
    const error = readError(status, { ...body, error: { ...body.error, message: 'Фраза сервера' } }, true)
    expect(error.reason).toBe(code)
    const message = reviewErrorText(error)
    const html = cards(image(), { kind: 'failed', imageId: 42, error, message })
    expect(html).toContain(`<p role="status" class="ck-review-refusal">${message}</p><div class="ck-rec-action-block">`)
    expect(html.split(message)).toHaveLength(2); expect(html).not.toContain('Фраза сервера')
  })
  it.each([
    ['network', 'Ответ сервера не получен. Действие могло выполниться: проверьте задание перед повтором.'],
    ['timeout', 'Ответ сервера не получен. Действие могло выполниться: проверьте задание перед повтором.'],
    ['server', 'Сервис ответил ошибкой. Действие могло выполниться: проверьте задание перед повтором.'],
    ['invalid_response', 'Сервис ответил ошибкой. Действие могло выполниться: проверьте задание перед повтором.'],
  ] as const)('shows an answer that was lost or unreadable at the button: %s', (reason, text) => {
    const error = { kind: 'error' as const, reason }
    const html = cards(image(), { kind: 'failed', imageId: 42, error, message: reviewErrorText(error) })
    expect(html).toContain(`<p role="status" class="ck-review-refusal">${text}</p><div class="ck-rec-action-block">`)
  })
  it('moves the refusal to the message of the card when a reread replaced the form by the saved state', () => {
    const error = readError(409, { error: { code: 'review_resolved', message: 'Фраза сервера' } }, true)
    const html = cards(confirmed().image, { kind: 'failed', imageId: 42, error, message: reviewErrorText(error) })
    expect(html).toContain(`<p tabindex="-1" role="status" class="ck-rec-result ck-rec-result-failed">${reviewErrorText(error)}</p>`)
    expect(html).not.toContain('ck-review-refusal'); expect(html).not.toContain('Исправление и подтверждение')
  })
  it('marks every card as the owner of its focus, so that the block heading never takes it', () => {
    expect(cards(image(), { kind: 'idle' })).toContain('<li class="ck-rec-card" data-request-focus-own="">')
    expect(cards(confirmed().image, { kind: 'idle' })).toContain('<li class="ck-rec-card" data-request-focus-own="">')
  })
  it.each(['reused', 'updated'] as const)('states that corrections were not applied to an existing receipt (%s), also after a reload', (status) => {
    const linked: ReceiptImageDetail = { ...confirmed().image, status, receipt_id: 71, issues: [
      issue('receipt_conflict', 'warning', { attribute: 'total' }, { field: '/total' }), issue('receipt_line_conflict', 'warning', { entity: 'line', index: 0, position: 1, attribute: 'amount' }, { field: '/lines/0/amount' }),
      issue('receipt_structure_conflict', 'warning', { entity: 'discount', attribute: null }, { field: '/discounts' })] }
    const html = cards(linked, { kind: 'idle' })
    expect(html).toContain('Чек уже был сохранён раньше: вырезка привязана к нему. Заполненные значения этого чека не изменены — исправления к ним не применены.')
    expect(html).toContain('Подтверждено вручную'); expect(html).toContain('href="/receipts/71">Открыть чек №71</a>')
    for (const text of ['Данные противоречат сохранённому чеку · Итого', 'Строка отличается от сохранённой · Сумма', 'Состав чека отличается от сохранённого · Скидки']) expect(html).toContain(text)
    expect(html).not.toContain('Исправление и подтверждение')
    // A crop linked automatically, without a confirmation, makes no claim about corrections.
    expect(cards({ ...linked, confirmed_at: null }, { kind: 'idle' })).not.toContain('исправления к ним не применены')
  })
  it('locks cancel and retry while a confirmation is in flight and explains recounted counters', () => {
    const value = publicFixture('job.json'); if (!isJobDetail(value)) throw new Error('Invalid fixture')
    const html = renderToStaticMarkup(<ActionButtons job={value} state={{ kind: 'idle' }} run={vi.fn()} busy />)
    expect(html.match(/disabled=""/g)).toHaveLength(2); expect(html).toContain('>Повторить обработку<')
    expect(renderToStaticMarkup(<ActionButtons job={value} state={{ kind: 'idle' }} run={vi.fn()} />)).toMatch(/<button type="button">Повторить обработку/)
    expect(renderToStaticMarkup(<JobSummary job={confirmed().job} />)).toContain('После подтверждения вырезки человеком счётчики и статус задания пересчитываются.')
  })
})
