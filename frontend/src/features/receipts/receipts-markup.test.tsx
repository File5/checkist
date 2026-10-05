import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Discount, Line, Receipt, Tax } from '../../api/receipts'
import type { ReceiptImage } from '../../api/recognition'
import { issue, publicFixture, taxEvidenceMissingIssues } from '../../api/recognition-test-support'
import type { Page } from '../../api/types'
import { ReceiptPage, ReceiptsPage } from './index'
import { ReceiptDiscounts, ReceiptHeader, ReceiptImages, ReceiptLines, ReceiptTaxes } from './ReceiptContent'
import ReceiptFilters from './ReceiptFilters'
import ReceiptMedia, { ReceiptImageFallback } from './ReceiptMedia'
import { ReceiptPagination } from './ReceiptBlock'
import { ReceiptView } from './ReceiptPage'
import type { BlockRequest, ReceiptViewProps } from './ReceiptPage'
import { ReceiptsView } from './ReceiptsPage'
import { imageLabels, reasonLabels } from '../../lib/recognition-labels'

const receipt = publicFixture('receipt.json') as Receipt
const lines = publicFixture('lines.json') as Page<Line>
const images = publicFixture('receipt-images.json') as Page<ReceiptImage>
const discounts = publicFixture('discounts.json') as Page<Discount>
const taxes = publicFixture('taxes.json') as Page<Tax>
const noop = () => {}
const loaded = <T,>(data: T): BlockRequest<T> => ({ state: { kind: 'ok', data }, retry: noop })
const emptyPage = <T,>(): Page<T> => ({ count: 0, page: 1, page_size: 50, pages: 0, results: [] })
const view: ReceiptViewProps = {
  receiptId: 71, header: loaded(receipt), lines: loaded(lines), images: loaded({ ...images, results: images.results.filter((image) => image.receipt_id === 71) }),
  discounts: loaded(discounts), taxes: loaded(taxes), pages: { images: 1, lines: 1, discounts: 1, taxes: 1 }, onPage: noop,
}

describe('receipt screens (Vitest/SSR, not browser visual acceptance)', () => {
  it.each(Object.keys(imageLabels) as ReceiptImage['status'][])('uses the shared %s status and safe issue labels', (status) => {
    const image = { ...images.results[0], status, issues: [{ code: 'invalid_value' as const, field: '/', message: 'private provider text' }] }
    const html = renderToStaticMarkup(<ReceiptImages images={[image]} receiptId={71} />)
    expect(html).toContain(imageLabels[status])
    // An old server hides every internal cause behind invalid_value, so the neutral label is shown.
    expect(html).toContain(reasonLabels.unknown)
    expect(html).toContain(status === 'failed' ? '<h4>Причины ошибки</h4>' : status === 'needs_review' ? '<h4>Причины проверки</h4>' : '<h4>Замечания распознавания</h4>')
    expect(html).not.toContain('Некорректное значение')
    expect(html).not.toContain('private provider text')
  })
  it('shows the same three collapsed groups of 29 omissions as the job screen', () => {
    const image = { ...images.results[0], status: 'imported' as const, receipt_id: 71, normalized_result: null,
      issues: taxEvidenceMissingIssues().map((item) => ({ ...item, message: 'private provider text' })) }
    const html = renderToStaticMarkup(<ReceiptImages images={[image]} receiptId={71} />)
    expect(html).toContain('Чек сохранён')
    expect(html).toContain('<h4>Замечания распознавания</h4>')
    expect(html.match(/<summary>[^<]*<\/summary>/g)).toEqual([
      '<summary>НДС не использован в 25 строках</summary>', '<summary>Пропущены 2 налоговых итога</summary>', '<summary>Не прочитаны 2 реквизита</summary>'])
    expect(html).not.toContain('<details open')
    expect(html).toContain(`Строки: ${Array.from({ length: 25 }, (_, index) => index + 1).join(', ')}`)
    expect(html).toContain('Налоговые итоги №: 1, 2')
    expect(html).toContain('Значения не показываются.')
    expect(html).not.toContain('Причины проверки')
    expect(html).not.toContain('private provider text')
    expect(html).not.toContain('aria-live')
  })
  it('separates always visible review causes from collapsed notes on the receipt card', () => {
    const image = { ...images.results[0], status: 'needs_review' as const, issues: [
      issue('optional_omitted', 'warning', { entity: 'line', index: 4, attribute: 'tax_rate' }, { field: '/lines/4/tax_rate' }),
      issue('total_mismatch', 'error', { attribute: 'total' }, { code: 'total_mismatch', field: '/total', message: 'private provider text' }),
    ] }
    const html = renderToStaticMarkup(<ReceiptImages images={[image]} receiptId={71} />)
    const [causes, notes] = html.split('<h4>Замечания распознавания</h4>')
    expect(causes).toContain('<h4>Причины проверки</h4>')
    expect(causes).toContain('Сумма строк не совпадает с итогом · Итого')
    expect(causes).not.toContain('<details')
    expect(notes).toContain('<details><summary>НДС не использован в 1 строке</summary>')
    expect(notes).toContain('Строки распознавания №: 5')
    expect(html).not.toContain('private provider text')
  })
  it('returns to the source job from a receipt', () => {
    const html = renderToStaticMarkup(<ReceiptView {...view} returnTo="/recognition/jobs/31" />)
    expect(html).toContain('href="/recognition/jobs/31">К заданию')
  })
  it('preserves shell props and shows five independent loading blocks without another h1', () => {
    const list = renderToStaticMarkup(<ReceiptsPage query={{ page: 2 }} />)
    expect(list).toContain('Страница 2')
    expect(list).toContain('Загружаем')
    const detail = renderToStaticMarkup(<ReceiptPage receiptId={71} returnTo="/receipts?q=MILCH&amp;page=2" />)
    expect(detail).toContain('Страница чека №71')
    expect(detail.match(/class="request-state request-state-loading"/g)).toHaveLength(5)
    for (const html of [list, detail]) { expect(html).not.toContain('<h1'); expect(html).not.toContain('<main') }
  })
  it('renders canonical receipt, printed line, linked catalog item, discount and tax from backend fixtures', () => {
    const html = renderToStaticMarkup(<ReceiptView {...view} />)
    for (const text of ['Тестовый магазин', 'Teststrasse 12', '04.10.2026', '14:35', 'Продажа', '2,38 EUR', '0,20 EUR', 'MILCH 1 L', '2 шт', '1,29 EUR', '2,58 EUR', 'Rabatt MILCH', 'НДС 7,00 %', '2,22 EUR', '0,16 EUR']) expect(html).toContain(text)
    expect(html).toContain('href="/catalog/products/61"')
    expect(html).toContain('href="/recognition/jobs/31"')
    expect(html).toContain('href="#receipt-line-101"')
    expect(html).toContain('scope="row"')
    expect(html).toContain('scope="col"')
    expect(html).toContain('role="region"')
    expect(html).toContain('прокручивается по горизонтали')
    expect(html).not.toContain('raw_text')
  })
  it('shows an unmatched product, service, linked deposit, and return of deposit explicitly', () => {
    const parent = lines.results[0]
    const unmatched: Line = { ...parent, id: 102, position: 2, product: null, matching_status: 'unmatched', name: 'ХЛЕБ' }
    const deposit: Line = { ...unmatched, id: 103, position: 3, kind: 'deposit', parent_id: 101, name: 'PFAND', amount: '0.25', paid_amount: '0.25', discount_amount: '0.00' }
    const service: Line = { ...unmatched, id: 104, position: 4, kind: 'service', name: 'ДОСТАВКА' }
    const returned: Line = { ...deposit, id: 105, position: 5, kind: 'deposit_return', parent_id: null, quantity: '-1.000', amount: '-0.25', paid_amount: '-0.25' }
    const html = renderToStaticMarkup(<ReceiptLines lines={[parent, unmatched, deposit, service, returned]} currency="EUR" />)
    expect(html.match(/Товар не сопоставлен/g)).toHaveLength(4)
    expect(html).toContain('Строка 3 · Залог')
    expect(html).toContain('Залог к <a href="#receipt-line-101">Строка 1: MILCH 1 L</a>')
    expect(html).toContain('href="#receipt-line-103"')
    expect(html).toContain('Строка 4 · Услуга')
    expect(html).toContain('Возврат залога')
    expect(html).toContain('-0,25 EUR')
  })
  it('keeps parent identity visible when a deposit/discount references another page', () => {
    const deposit: Line = { ...lines.results[0], kind: 'deposit', parent_id: 999 }
    expect(renderToStaticMarkup(<ReceiptLines lines={[deposit]} currency="EUR" />)).toContain('Строка ID 999 (на другой странице строк)')
    const html = renderToStaticMarkup(<ReceiptDiscounts discounts={[...discounts.results, { ...discounts.results[0], id: 202, line_id: null }]} lines={[]} currency="EUR" />)
    expect(html).toContain('Строка ID 101')
    expect(html).toContain('Скидка на весь чек')
    expect(html).not.toContain('href="#receipt-line-101"')
  })
  it.each(['header', 'images', 'lines', 'discounts', 'taxes'] as const)('an error in %s keeps other blocks visible with its own retry', (block) => {
    const props = { ...view, [block]: { state: { kind: 'error' as const, reason: 'network' as const }, retry: noop } }
    const html = renderToStaticMarkup(<ReceiptView {...props} />)
    expect(html.match(/data-request-retry/g)).toHaveLength(1)
    expect(html).toContain('Проверьте соединение')
    if (block !== 'lines') expect(html).toContain('MILCH 1 L')
    if (block !== 'discounts') expect(html).toContain('Rabatt MILCH')
    if (block !== 'taxes') expect(html).toContain('НДС 7,00 %')
    if (block !== 'images') expect(html).toContain('href="/recognition/jobs/31"')
    if (block === 'header') { expect(html).toContain('Валюта: Не распознано'); expect(html).not.toContain('EUR') }
  })
  it('recovers an out-of-range block to page one without hiding siblings', () => {
    const html = renderToStaticMarkup(<ReceiptView {...view} lines={{ state: { kind: 'error', reason: 'page_out_of_range', status: 404 }, retry: noop }} pages={{ ...view.pages, lines: 3 }} />)
    expect(html).toContain('На первую страницу')
    expect(html).toContain('Rabatt MILCH')
    expect(html).not.toContain('data-request-retry')
  })
  it('shows empty states for individual child resources', () => {
    const html = renderToStaticMarkup(<ReceiptView {...view} images={loaded(emptyPage())} lines={loaded(emptyPage())} discounts={loaded(emptyPage())} taxes={loaded(emptyPage())} />)
    for (const text of ['У этого чека нет изображений', 'В этом чеке нет строк', 'Отдельные скидки в чеке не указаны', 'Налоги в чеке не указаны']) expect(html).toContain(text)
    expect(html).toContain('Тестовый магазин')
  })
  it('renders all linked photos including multiple jobs and fixed issue descriptions', () => {
    const allImages = images.results.map((image, index) => ({ ...image, receipt_id: 71, photo_id: 11 + index, job_id: 31 + index,
      issues: image.issues.map((issue) => ({ ...issue, message: 'private provider message' })) }))
    const html = renderToStaticMarkup(<ReceiptImages images={allImages} receiptId={71} />)
    expect(html.match(/<img /g)).toHaveLength(2)
    expect(html).toContain('href="/recognition/jobs/31"')
    expect(html).toContain('href="/recognition/jobs/32"')
    expect(html).toContain('Требует проверки')
    expect(html).toContain('Не удалось прочитать обязательное поле · Количество')
    expect(html).toContain('Строки: 1')
    expect(html).not.toContain('private provider message')
  })
  it('uses safe media paths, descriptive alt and explicit image fallback/retry', () => {
    const valid = renderToStaticMarkup(<ReceiptMedia url="/media/crops/test/crop.png" alt="Вырезка чека №71" />)
    expect(valid).toContain('alt="Вырезка чека №71"')
    expect(valid).toContain('target="_blank"')
    for (const url of [null, 'https://example.com/private.png', '/media/../secret.png']) {
      const html = renderToStaticMarkup(<ReceiptMedia url={url} alt="Вырезка чека" />)
      expect(html).toContain('Изображение отсутствует')
      expect(html).not.toContain('<img')
    }
    const fallback = renderToStaticMarkup(<ReceiptImageFallback alt="Вырезка чека №71" retry={noop} />)
    expect(fallback).toContain('изображение не загрузилось')
    expect(fallback).toContain('Повторить загрузку изображения')
    expect(fallback).toContain('data-request-retry')
  })
  it('shows unknown text without losing zero money or local timezone/refund', () => {
    const html = renderToStaticMarkup(<ReceiptHeader receipt={{ ...receipt, operation: 'refund', total: '-2.38', discount_total: '0.00', store: { ...receipt.store, name: '', address: '' } }} />)
    expect(html.match(/Не распознано/g)).toHaveLength(2)
    expect(html).toContain('Возврат')
    expect(html).toContain('-2,38 EUR')
    expect(html).toContain('0,00 EUR')
    expect(renderToStaticMarkup(<ReceiptTaxes taxes={[{ ...taxes.results[0], tax_rate: { ...taxes.results[0].tax_rate, kind: 'exempt', rate: null }, tax_code: '' }]} currency="EUR" />)).toContain('Без НДС')
  })
  it('empty unfiltered list invites first upload, filtered list offers reset', () => {
    const unfiltered = renderToStaticMarkup(<ReceiptsView query={{ page: 1 }} state={{ kind: 'ok', data: emptyPage() }} retry={noop} />)
    expect(unfiltered).toContain('Загрузите первое фото чека')
    expect(unfiltered).toContain('href="/receipts/upload"')
    expect(unfiltered).toContain('href="/recognition/jobs"')
    const filtered = renderToStaticMarkup(<ReceiptsView query={{ page: 1, q: 'MILCH' }} state={{ kind: 'ok', data: emptyPage() }} retry={noop} />)
    expect(filtered).toContain('По выбранным фильтрам чеков нет')
    expect(filtered).toContain('Сбросить фильтры')
  })
  it('list metadata, thumbnails, badges and page links retain the complete URL query', () => {
    const data = { ...(publicFixture('receipts.json') as Page<Receipt>), count: 5, page: 2, pages: 3,
      results: [{ ...receipt, unmatched_products_count: 1, review_required: true }] }
    const html = renderToStaticMarkup(<ReceiptsView query={{ page: 2, q: 'MILCH', date_from: '2026-10-01', date_to: '2026-10-04', operation: 'sale' }} state={{ kind: 'ok', data }} retry={noop} />)
    for (const text of ['Товары не сопоставлены: 1', 'Данные требуют проверки', '2,38 EUR', '04.10.2026', 'Строк', 'Страница 2 из 3']) expect(html).toContain(text)
    expect(html).toContain('href="/receipts/71"')
    expect(html).toContain('alt="Миниатюра чека №71"')
    const nextHref = /<a rel="next" href="([^"]+)"/.exec(html)![1].replaceAll('&amp;', '&')
    expect(Object.fromEntries(new URL(nextHref, 'http://checkist.local').searchParams)).toEqual({
      date_from: '2026-10-01', date_to: '2026-10-04', operation: 'sale', q: 'MILCH', page: '3',
    })
  })
  it('restores date/search/sort form fields from URL and labels server field errors locally', () => {
    const html = renderToStaticMarkup(<ReceiptFilters query={{ page: 1, q: 'MILCH', date_from: '2026-10-01', date_to: '2026-10-04', ordering: 'purchased_at' }} failure={{ kind: 'error', reason: 'invalid_parameter', status: 400, fields: ['q', 'date_from'] }} />)
    expect(html).toContain('name="q"')
    expect(html).toContain('value="MILCH"')
    expect(html).toContain('value="2026-10-01"')
    expect(html).toContain('value="2026-10-04"')
    expect(html).toContain('value="purchased_at" selected')
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(2)
    expect(html).toContain('Исправьте поля фильтров')
  })
  it('local detail pagination uses keyboard buttons and marks current page', () => {
    const html = renderToStaticMarkup(<ReceiptPagination page={2} pages={3} onPage={noop} label="Страницы: строки чека" />)
    expect(html).toContain('aria-label="Страницы: строки чека"')
    expect(html).toContain('type="button"')
    expect(html).toContain('aria-current="page" disabled')
    expect(html).toContain('Предыдущая')
    expect(html).toContain('Следующая')
  })
  it('keeps filtered return URL and recovers list page errors without clearing filters', () => {
    const detail = renderToStaticMarkup(<ReceiptView {...view} returnTo="/receipts?q=MILCH&page=2" />)
    expect(detail).toContain('href="/receipts?q=MILCH&amp;page=2"')
    const html = renderToStaticMarkup(<ReceiptsView query={{ page: 5, q: 'MILCH' }} state={{ kind: 'error', reason: 'page_out_of_range', status: 404 }} retry={noop} />)
    expect(html).toContain('href="/receipts?q=MILCH"')
    expect(html).toContain('На первую страницу')
  })
})
