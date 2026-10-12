import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Line, Receipt } from '../../api/receipts'
import { publicFixture } from '../../api/recognition-test-support'
import type { Category, Page } from '../../api/types'
import { numbered } from '../../lib/text'
import { ReceiptHeader, ReceiptLines } from '../receipts/ReceiptContent'
import { ReceiptView } from '../receipts/ReceiptPage'
import type { BlockRequest } from '../receipts/ReceiptPage'
import { ReceiptList } from '../receipts/ReceiptsPage'
import { emptyDraft, messages, newLine } from './expense-form'
import type { ExpenseDraft } from './expense-form'
import { ExpenseForm } from './ExpensePage'
import { DeleteSpend, ManualSpendActions } from './ManualSpendActions'

const noop = () => {}
const category = (id: number, name: string): Category => ({
  id, name, path: [{ id, name }], parent_id: null, depth: 0, children_count: 0, generic_products_count: 0, products_count: 0, products_total: 0,
})
const chips = [category(1, 'Еда'), category(2, 'Кафе'), category(3, 'Транспорт')]
const form = (draft: ExpenseDraft, extra: Partial<Parameters<typeof ExpenseForm>[0]> = {}) => renderToStaticMarkup(
  <ExpenseForm draft={draft} chips={chips} errors={{}} saving={false} onChange={noop} onSubmit={noop} {...extra} />)

const photo = publicFixture('receipt.json') as Receipt
const manual: Receipt = { ...photo, id: 90, source: 'manual', store: null, note: 'кофе с другом', origin: 'legacy/manual',
  receipt_images_count: 0, preview_image_url: null, purchased_on: '2026-10-01', total: '450.00', currency: 'KZT' }
const manualLine = { ...(publicFixture('lines.json') as Page<Line>).results[0], id: 900, name: 'Кафе', product: null,
  matching_status: 'unmatched', category: { id: 2, name: 'Кафе' }, amount: '450.00', paid_amount: '450.00' } as Line
const loaded = <T,>(data: T): BlockRequest<T> => ({ state: { kind: 'ok', data }, retry: noop })
const pageOf = <T,>(results: T[]): Page<T> => ({ count: results.length, page: 1, page_size: 50, pages: 1, results })

describe('«Добавить трату» form (Vitest/SSR, not browser visual acceptance)', () => {
  it('opens on a big decimal amount in a card, the currency pill, wrapping chips, today and the save bar', () => {
    const html = form(emptyDraft('KZT', '2026-10-12'))
    expect(html).toContain('<section class="expense-card expense-amount"><label for="expense-amount" class="expense-label">Сумма</label>')
    expect(html).toContain('id="expense-amount" class="expense-amount-input ck-hero-figure" inputMode="decimal"')
    // «₸ KZT»: the sign is a picture, the field keeps the code and its name.
    expect(html).toContain('<label class="expense-currency expense-currency-signed"><span class="expense-currency-sign" aria-hidden="true">₸</span><span class="expense-visually-hidden">Валюта</span>')
    expect(html).toContain('value="KZT"')
    expect(html).toMatch(/<input id="expense-date" type="date"[^>]* value="2026-10-12"\/>/)
    // Three category chips and the two date chips; the chips wrap (no scroller).
    expect(html.match(/class="expense-chip"/g)).toHaveLength(3)
    expect(html.match(/class="expense-chip expense-day"/g)).toHaveLength(2)
    expect(html).toContain('<div class="expense-chips">')
    expect(html).not.toContain('ck-chip-scroller')
    expect(html).toContain('class="expense-dot" style="--expense-tone:var(--ck-cat-2)" aria-hidden="true"></span><span class="expense-chip-name">Кафе</span></button>')
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('class="expense-actions ck-action-bar"')
    expect(html).toContain('<button type="submit" class="expense-save">Сохранить</button>')
    // The ✕ of the header closes the form: no «Отмена» of its own.
    expect(html).not.toContain('Отмена')
    expect(html).not.toContain('Удалить трату')
    expect(html).toContain('<span class="expense-row-label">Где</span><input id="expense-place" class="expense-row-input"')
    expect(html).toContain('placeholder="Без места"')
    expect(html).toContain('<textarea id="expense-note" class="expense-row-input" rows="1" placeholder="Необязательно"')
    expect(html).toContain('<span aria-hidden="true">+</span> Добавить<span class="expense-visually-hidden"> позицию</span></button>')
    expect(html).not.toContain('<table')
  })
  it('names a nested category by itself, with its parent for a screen reader and the colour of its root', () => {
    const nested: Category = { ...category(5, 'Кафе'), parent_id: 1, depth: 1, path: [{ id: 1, name: 'Еда' }, { id: 5, name: 'Кафе' }] }
    const html = renderToStaticMarkup(<ExpenseForm draft={emptyDraft('KZT', '2026-10-12')} chips={[nested]} errors={{}} saving={false} onChange={noop} onSubmit={noop} />)
    expect(html).toContain('title="Еда › Кафе"><span class="expense-dot" style="--expense-tone:var(--ck-cat-1)" aria-hidden="true"></span>'
      + '<span class="expense-visually-hidden">Еда › </span><span class="expense-chip-name">Кафе</span></button>')
  })
  it('a code without a common sign is the pill alone', () => {
    const html = form(emptyDraft('UZS', '2026-10-12'))
    expect(html).toContain('<label class="expense-currency"><span class="expense-visually-hidden">Валюта</span>')
    expect(html).not.toContain('expense-currency-sign')
  })
  it('marks the chosen chip and shows errors at their fields', () => {
    const html = form({ ...emptyDraft('KZT', '2026-10-12'), category: 2 }, {
      errors: { amount: messages.amount, category: messages.category }, failure: 'Проверьте отмеченные поля.' })
    expect(html).toContain('aria-pressed="true" title="Кафе"><span class="expense-dot"')
    expect(html).toContain(`<p class="expense-error" id="expense-amount-error">${messages.amount}</p>`)
    expect(html).toContain('aria-describedby="expense-amount-error"')
    expect(html).toContain('<fieldset class="expense-card expense-categories" aria-describedby="expense-category-error">')
    // A failed save says why right above the button.
    expect(html).toContain('<div class="expense-actions ck-action-bar"><p class="expense-failure" role="alert">Проверьте отмеченные поля.</p><button type="submit"')
  })
  it('sums positions into a read-only amount and shows their errors by the sent index', () => {
    const draft = { ...emptyDraft('KZT', '2026-10-12'), lines: [{ ...newLine() }, { ...newLine(), name: 'Хлеб', amount: '250' }, { ...newLine(), name: 'Сок', amount: '100,5' }] }
    const html = form(draft, { errors: { 'lines.1.amount': messages.lineAmount } })
    expect(html).toContain('<label for="expense-amount" class="expense-label">Сумма позиций</label>')
    expect(html).toMatch(/readOnly=""[^>]* value="350.50"/)
    expect(html).toContain('Категория позиций без своей')
    expect(html.match(/expense-lines-1-amount-error/g)).toHaveLength(2)
    expect(html).toContain('aria-label="Убрать позицию 3"')
    expect(html).toContain('>Позиция 3</label>')
    expect(html).toContain('>Сумма позиции 3</label>')
    // The exact sum stays in the field; the summary next to it shows whole units, rounded up.
    expect(html).toContain('<button type="submit" class="expense-save">Сохранить · 351 ₸</button>')
  })
  it('names the rounded amount on the save button, chooses the date by chips and keeps the calendar', () => {
    const html = form({ ...emptyDraft('KZT', '2026-10-11'), amount: '4500,40' }, { today: '2026-10-12' })
    expect(html).toContain('<button type="submit" class="expense-save">Сохранить · 4 501 ₸</button>')
    expect(html).toContain('<button type="button" class="expense-chip expense-day" aria-pressed="false">Сегодня</button>')
    expect(html).toContain('<button type="button" class="expense-chip expense-day" aria-pressed="true">Вчера</button>')
    expect(html).toContain('<div class="expense-row" role="group" aria-labelledby="expense-when-label"><span id="expense-when-label" class="expense-row-label">Когда</span>')
    expect(html).toMatch(/<label class="expense-date-pick"><svg[^>]*>.*?<\/svg><span class="expense-visually-hidden">Дата покупки<\/span><input id="expense-date" type="date"/)
    const other = form(emptyDraft('KZT', '2026-09-01'), { today: '2026-10-12' })
    expect(other).toContain('expense-date-pick expense-date-pick-chosen')
    expect(other).toContain('<time dateTime="2026-09-01">01.09</time>')
    expect(other).not.toContain('aria-pressed="true">Сегодня')
  })
  it('opens all categories with a search in a sheet', () => {
    const html = form(emptyDraft('KZT', '2026-10-12'))
    expect(html).toContain('<button type="button" class="expense-chip expense-more" aria-haspopup="dialog" aria-expanded="false">Все категории…</button>')
    expect(html).not.toContain('ck-sheet')
    const open = form({ ...emptyDraft('KZT', '2026-10-12'), category: 2 }, { initialSheet: true })
    expect(open).toContain('Все категории</h2>')
    expect(open).toContain('<input id="expense-category-search" type="search"')
    expect(open).toMatch(/<button type="button" class="expense-tree-item" aria-pressed="true"><span class="expense-dot"[^>]*><\/span>Кафе<\/button>/)
    expect(open.match(/class="expense-tree-item"/g)).toHaveLength(3)
  })
  it('says who adds the spend when the page knows it', () => {
    expect(form(emptyDraft('KZT', '2026-10-12'), { byline: 'Добавит: Андрей · видна всей семье' }))
      .toContain('<p class="expense-byline">Добавит: Андрей · видна всей семье</p>')
    expect(form(emptyDraft('KZT', '2026-10-12'))).not.toContain('expense-byline')
  })
  it('ends an edit with a quiet «Удалить трату» before the save bar', () => {
    const html = form(emptyDraft('KZT', '2026-10-12'), { receiptId: 90, saving: true })
    expect(html).toContain('<div class="expense-delete"><button type="button" class="expense-danger expense-delete-button">Удалить трату</button></div>')
    expect(html.indexOf('expense-delete-button')).toBeLessThan(html.indexOf('expense-actions'))
    expect(html).toContain('<button type="submit" class="expense-save" disabled="">Сохраняем…</button>')
    expect(html).not.toContain('href="/receipts/90"')
  })
  it('asks before deleting from the form: inline on a wide screen, in a sheet on a phone', () => {
    const wide = renderToStaticMarkup(<DeleteSpend receiptId={90} initial={{ kind: 'confirm' }} />)
    expect(wide).toContain('Удалить эту трату? Отменить удаление нельзя.')
    expect(wide).not.toContain('expense-delete-button')
    const phone = renderToStaticMarkup(<DeleteSpend receiptId={90} narrow initial={{ kind: 'confirm' }} />)
    expect(phone).toContain('class="expense-danger expense-delete-button">Удалить трату</button>')
    expect(phone).toContain('Удалить трату?</h2>')
    expect(renderToStaticMarkup(<DeleteSpend receiptId={90} initial={{ kind: 'failed', message: 'Сбой.' }} />)).toContain('role="alert">Сбой.</p>')
  })
})

describe('a manual spend on the receipt screens', () => {
  it('is listed without a place, with the mark and its note', () => {
    const html = renderToStaticMarkup(<ReceiptList receipts={[manual, photo]} />)
    expect(html).toContain(`Без места · ${numbered('трата', 90)}`)
    expect(html).toContain('<span class="receipt-source-mark">вручную</span>')
    expect(html).toContain('кофе с другом')
    expect(html.match(/receipt-source-mark/g)).toHaveLength(1)
  })
  it('shows its date, note, category line and actions; no photo, discounts or taxes', () => {
    const html = renderToStaticMarkup(<ReceiptView receiptId={90} header={loaded(manual)} lines={loaded(pageOf([manualLine]))}
      images={loaded(pageOf([]))} discounts={loaded(pageOf([]))} taxes={loaded(pageOf([]))}
      pages={{ images: 1, lines: 1, discounts: 1, taxes: 1 }} onPage={noop} notice="Трата сохранена." />)
    expect(html).toContain('<p class="expense-notice" role="status">Трата сохранена.</p>')
    expect(html).toContain(`>${numbered('Трата', 90)}</h2>`)
    expect(html).not.toContain('Сумма скидок')
    expect(html).not.toContain('Налог в ценах')
    expect(html).toContain('<dt>Дата покупки</dt><dd><time dateTime="2026-10-01">')
    expect(html).toContain('<dt>Комментарий</dt><dd>кофе с другом</dd>')
    expect(html).not.toContain('<dt>Адрес</dt>')
    expect(html).toContain('href="/receipts/90/edit">Изменить</a>')
    expect(html).toContain('>Удалить</button>')
    expect(html).toContain('Позиции траты')
    expect(html).not.toContain('Изображения чека')
    expect(html).not.toContain('Скидки')
    expect(html).not.toContain('Налоги')
  })
  it('names the category of a line without a product instead of a warning', () => {
    const html = renderToStaticMarkup(<ReceiptLines lines={[manualLine]} currency="KZT" />)
    expect(html).toContain('Категория: Кафе')
    expect(html).not.toContain('Товар не сопоставлен')
  })
  it('keeps a photo receipt as it was', () => {
    const html = renderToStaticMarkup(<ReceiptHeader receipt={photo} />)
    expect(html).toContain('<dt>Адрес</dt>')
    expect(html).not.toContain('вручную')
  })
  it('asks inline before deleting, without a browser dialog', () => {
    const html = renderToStaticMarkup(<ManualSpendActions receiptId={90} initial={{ kind: 'confirm' }} />)
    expect(html).toContain('Удалить эту трату? Отменить удаление нельзя.')
    expect(html).toContain('>Удалить трату</button>')
    expect(html).toContain('>Отмена</button>')
    expect(html).not.toContain('Изменить')
    expect(renderToStaticMarkup(<ManualSpendActions receiptId={90} initial={{ kind: 'failed', message: 'Сбой.' }} />)).toContain('role="alert">Сбой.</p>')
  })
  it('asks in a sheet over the bottom bar on a phone', () => {
    const html = renderToStaticMarkup(<ManualSpendActions receiptId={90} narrow initial={{ kind: 'confirm' }} />)
    expect(html.startsWith('<div class="receipt-actions expense-manual-actions ck-action-bar">')).toBe(true)
    expect(html).toContain('Удалить трату?</h2>')
    expect(html).toContain('Удалить эту трату? Отменить удаление нельзя.')
    expect(renderToStaticMarkup(<ManualSpendActions receiptId={90} narrow />)).not.toContain('ck-sheet')
  })
})
