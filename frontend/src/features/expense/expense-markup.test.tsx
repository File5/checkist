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
import { ManualSpendActions } from './ManualSpendActions'

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
  it('opens on a big decimal amount, chips, today and the save bar', () => {
    const html = form(emptyDraft('KZT', '2026-10-12'))
    expect(html).toContain('id="expense-amount" class="expense-amount-input" inputMode="decimal"')
    expect(html).toContain('value="KZT"')
    expect(html).toMatch(/<input id="expense-date" type="date"[^>]* value="2026-10-12"\/>/)
    expect(html.match(/class="expense-chip"/g)).toHaveLength(3)
    expect(html).toContain('aria-pressed="false"')
    expect(html).toContain('class="expense-actions ck-action-bar"')
    expect(html).toContain('<button type="submit" class="expense-save">Сохранить</button>')
    expect(html).toContain('<a href="/receipts">Отмена</a>'.replace('<a ', '<a class="action-link" '))
    expect(html).toContain('placeholder="Без места"')
    expect(html).toContain('Добавить позицию')
    expect(html).not.toContain('<table')
  })
  it('marks the chosen chip and shows errors at their fields', () => {
    const html = form({ ...emptyDraft('KZT', '2026-10-12'), category: 2 }, {
      errors: { amount: messages.amount, category: messages.category }, failure: 'Проверьте отмеченные поля.' })
    expect(html).toContain('aria-pressed="true" title="Кафе">Кафе</button>')
    expect(html).toContain(`<p class="receipt-field-error" id="expense-amount-error">${messages.amount}</p>`)
    expect(html).toContain('aria-describedby="expense-amount-error"')
    expect(html).toContain('role="alert">Проверьте отмеченные поля.</p>')
  })
  it('sums positions into a read-only amount and shows their errors by the sent index', () => {
    const draft = { ...emptyDraft('KZT', '2026-10-12'), lines: [{ ...newLine() }, { ...newLine(), name: 'Хлеб', amount: '250' }, { ...newLine(), name: 'Сок', amount: '100,5' }] }
    const html = form(draft, { errors: { 'lines.1.amount': messages.lineAmount } })
    expect(html).toContain('<label for="expense-amount">Сумма позиций</label>')
    expect(html).toMatch(/readOnly=""[^>]* value="350.50"/)
    expect(html).toContain('Категория позиций без своей')
    expect(html.match(/expense-lines-1-amount-error/g)).toHaveLength(2)
    expect(html).toContain('aria-label="Убрать позицию 3"')
    expect(html).toContain('350,50')
  })
  it('leads «Отмена» of an edit back to the spend', () => {
    expect(form(emptyDraft('KZT', '2026-10-12'), { receiptId: 90, saving: true })).toContain('href="/receipts/90"')
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
})
