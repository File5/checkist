import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { Discount, Line, Receipt, Tax } from '../../api/receipts'
import type { ReceiptImage } from '../../api/recognition'
import { issue, publicFixture, taxEvidenceMissingIssues } from '../../api/recognition-test-support'
import type { Page } from '../../api/types'
import { ReceiptPage, ReceiptsPage } from './index'
import { ReceiptDiscounts, ReceiptHeader, ReceiptImages, ReceiptLines, ReceiptTaxes } from './ReceiptContent'
import ReceiptFilters from './ReceiptFilters'
import SpendSearch from './SpendSearch'
import ReceiptMedia, { ReceiptImageFallback } from './ReceiptMedia'
import { ReceiptPagination } from './ReceiptBlock'
import { ReceiptView } from './ReceiptPage'
import { ReceiptDeleteActions } from './ReceiptDeleteActions'
import { ReceiptPhoto } from './ReceiptPhoto'
import type { BlockRequest, ReceiptViewProps } from './ReceiptPage'
import { ReceiptList, ReceiptsView } from './ReceiptsPage'
import { ownerShown } from './state'
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
  it('marks a crop confirmed by a person with the moment of the confirmation and no other crop', () => {
    const [automatic] = images.results
    expect(automatic.confirmed_at).toBeNull()
    expect(renderToStaticMarkup(<ReceiptImages images={[automatic]} receiptId={71} />)).not.toContain('Подтверждено вручную')
    const html = renderToStaticMarkup(<ReceiptImages images={[{ ...automatic, id: automatic.id + 1, status: 'imported', normalized_result: null, confirmed_at: '2026-10-04T12:35:00Z' }, automatic]} receiptId={71} />)
    expect(html.match(/Подтверждено вручную/g)).toHaveLength(1)
    expect(html).toContain('Подтверждено вручную: <time dateTime="2026-10-04T12:35:00Z">04.10.2026,\u00a012:35\u00a0UTC</time>')
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
  it('keeps the order of line rates, tax totals and requisites for a reversed answer with a foreign group between them', () => {
    const clipped = issue('clipped', 'warning', { entity: 'geometry', attribute: 'clipped' }, { code: 'clipped', field: '/clipped' })
    const [first, ...rest] = taxEvidenceMissingIssues().reverse()
    const image = { ...images.results[0], status: 'imported' as const, receipt_id: 71, normalized_result: null, issues: [first, clipped, ...rest] }
    const html = renderToStaticMarkup(<ReceiptImages images={[image]} receiptId={71} />)
    expect(html.match(/<summary>[^<]*<\/summary>|<p class="rec-issues-title">[^<]*<\/p>/g)).toEqual([
      '<summary>НДС не использован в 25 строках</summary>', '<summary>Пропущены 2 налоговых итога</summary>', '<summary>Не прочитаны 2 реквизита</summary>',
      '<p class="rec-issues-title">Часть чека обрезана · Обрезанный чек</p>'])
    expect(html).toContain(`Строки: ${Array.from({ length: 25 }, (_, index) => index + 1).join(', ')}`)
    expect(html).toContain('Налоговые итоги №: 1, 2')
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
    expect(detail).toContain('Чек\u00a0№71')
    expect(detail.match(/class="request-state request-state-loading"/g)).toHaveLength(5)
    for (const html of [list, detail]) { expect(html).not.toContain('<h1'); expect(html).not.toContain('<main') }
  })
  it('renders canonical receipt, printed line, linked catalog item, discount and tax from backend fixtures', () => {
    const html = renderToStaticMarkup(<ReceiptView {...view} />)
    for (const text of ['Тестовый магазин', 'Teststrasse 12', '04.10.2026', '14:35', 'Продажа', '3 €', '1 €', 'MILCH 1 L', '2 шт', '1,29 €', '3 €', 'Rabatt MILCH', 'НДС 7,00 %', '3 €', '1 €']) expect(html).toContain(text)
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
    expect(html).toContain('Строка\u00a03 · Залог')
    expect(html).toContain('Залог к <a href="#receipt-line-101">Строка\u00a01: MILCH 1 L</a>')
    expect(html).toContain('href="#receipt-line-103"')
    expect(html).toContain('Строка\u00a04 · Услуга')
    expect(html).toContain('Возврат залога')
    expect(html).toContain('-1 €')
  })
  it('keeps parent identity visible when a deposit/discount references another page', () => {
    const deposit: Line = { ...lines.results[0], kind: 'deposit', parent_id: 999 }
    expect(renderToStaticMarkup(<ReceiptLines lines={[deposit]} currency="EUR" />)).toContain('Строка\u00a0ID\u00a0999 (на другой странице строк)')
    const html = renderToStaticMarkup(<ReceiptDiscounts discounts={[...discounts.results, { ...discounts.results[0], id: 202, line_id: null }]} lines={[]} currency="EUR" />)
    expect(html).toContain('Строка\u00a0ID\u00a0101')
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
    const html = renderToStaticMarkup(<ReceiptHeader receipt={{ ...receipt, operation: 'refund', total: '-2.38', discount_total: '0.00', store: { ...receipt.store!, name: '', address: '' } }} />)
    expect(html.match(/Не распознано/g)).toHaveLength(2)
    expect(html).toContain('Возврат')
    expect(html).toContain('-3 €')
    expect(html).toContain('0 €')
    expect(renderToStaticMarkup(<ReceiptTaxes taxes={[{ ...taxes.results[0], tax_rate: { ...taxes.results[0].tax_rate, kind: 'exempt', rate: null }, tax_code: '' }]} currency="EUR" />)).toContain('Без НДС')
  })
  it('empty unfiltered list invites first upload, filtered list offers reset', () => {
    const unfiltered = renderToStaticMarkup(<ReceiptsView query={{ page: 1 }} state={{ kind: 'ok', data: emptyPage() }} retry={noop} />)
    expect(unfiltered).toContain('Загрузите первое фото чека')
    expect(unfiltered).toContain('href="/receipts/upload"')
    expect(unfiltered).toContain('href="/recognition/jobs"')
    const filtered = renderToStaticMarkup(<ReceiptsView query={{ page: 1, operation: 'refund' }} state={{ kind: 'ok', data: emptyPage() }} retry={noop} />)
    expect(filtered).toContain('По выбранным фильтрам трат нет')
    expect(filtered).toContain('Сбросить фильтры')
    // A search that found nothing names its words and drops only them (2026-10-13).
    const searched = renderToStaticMarkup(<ReceiptsView query={{ page: 1, q: 'MILCH', operation: 'refund' }} state={{ kind: 'ok', data: emptyPage() }} retry={noop} />)
    expect(searched).toContain('По запросу «MILCH» трат нет.')
    expect(searched).toContain('<a class="action-link" href="/receipts?operation=refund">Сбросить поиск</a>')
  })
  it('list rows, their review flag and page links retain the complete URL query', () => {
    const data = { ...(publicFixture('receipts.json') as Page<Receipt>), count: 5, page: 2, pages: 3,
      results: [{ ...receipt, unmatched_products_count: 1, review_required: true }] }
    const html = renderToStaticMarkup(<ReceiptsView query={{ page: 2, q: 'MILCH', date_from: '2026-10-01', date_to: '2026-10-04', operation: 'sale' }} state={{ kind: 'ok', data }} retry={noop} />)
    for (const text of ['Тестовый магазин', '<span class="spends-row-flag">требует проверки</span>', '3\u00a0€', '<time dateTime="2026-10-04">', 'Страница 2 из 3']) expect(html).toContain(text)
    expect(html).toContain('href="/receipts/71"')
    const nextHref = /<a rel="next" href="([^"]+)"/.exec(html)![1].replaceAll('&amp;', '&')
    expect(Object.fromEntries(new URL(nextHref, 'http://checkist.local').searchParams)).toEqual({
      date_from: '2026-10-01', date_to: '2026-10-04', operation: 'sale', q: 'MILCH', page: '3',
    })
  })
  it('restores date/search/sort form fields from URL and labels server field errors locally', () => {
    const failure = { kind: 'error' as const, reason: 'invalid_parameter' as const, status: 400, fields: ['q', 'date_from'] }
    const query = { page: 1, q: 'MILCH', date_from: '2026-10-01', date_to: '2026-10-04', ordering: 'purchased_at' as const }
    const html = renderToStaticMarkup(<ReceiptFilters query={query} failure={failure} />)
    // The words of a search are the search line's (2026-10-13): the form has no field for them and no error of theirs.
    expect(html).not.toContain('name="q"')
    expect(html).toContain('value="2026-10-01"')
    expect(html).toContain('value="2026-10-04"')
    expect(html).toContain('value="purchased_at" selected')
    expect(html.match(/aria-invalid="true"/g)).toHaveLength(1)
    expect(html).toContain('Исправьте поля фильтров')
    const search = renderToStaticMarkup(<SpendSearch query={query} failure={failure} />)
    expect(search).toContain('name="q" value="MILCH"')
    expect(search.match(/aria-invalid="true"/g)).toHaveLength(1)
    expect(search).toContain('Введите от 2 до 100 символов без управляющих символов.')
  })
  it('local detail pagination uses keyboard buttons and marks current page', () => {
    const html = renderToStaticMarkup(<ReceiptPagination page={2} pages={3} onPage={noop} label="Страницы: строки чека" />)
    expect(html).toContain('aria-label="Страницы: строки чека"')
    expect(html).toContain('type="button"')
    expect(html).toContain('aria-current="page" disabled')
    expect(html).toContain('Предыдущая')
    expect(html).toContain('Следующая')
  })
  it('glues a word to its number in the visible labels of the list and of the receipt', () => {
    const list = renderToStaticMarkup(<ReceiptsView query={{ page: 1 }} state={{ kind: 'ok', data: { ...emptyPage<Receipt>(), count: 1, pages: 1, results: [receipt] } }} retry={noop} />)
    expect(list).toMatch(/\d\u00a0позици/)
    expect(list).toContain('1\u00a0трата · Страница 1 из 1')
    const detail = renderToStaticMarkup(<ReceiptView {...view} />)
    expect(detail).toMatch(/<h3>Фото\u00a0№\d+ · вырезка\u00a0\d+<\/h3>/)
    expect(detail).toContain('>Задание\u00a0№31</a>')
    expect(detail).toMatch(/<span class="receipt-note">Строка\u00a0\d+ · Товар<\/span>/)
    // No visible label of these screens keeps an ordinary space between the word and its number.
    for (const html of [list, detail]) expect(html.replace(/(alt|aria-label)="[^"]*"/g, '')).not.toMatch(/(чек|Фото|Задание) №|вырезка \d|Строка \d/)
  })
  it('puts every date of the list and of the receipt into <time>', () => {
    const list = renderToStaticMarkup(<ReceiptsView query={{ page: 1 }} state={{ kind: 'ok', data: { ...emptyPage<Receipt>(), count: 1, pages: 1, results: [receipt] } }} retry={noop} today="2026-10-12" />)
    const confirmed = { ...images.results[0], receipt_id: 71, confirmed_at: '2026-10-04T12:35:00Z' }
    const detail = renderToStaticMarkup(<ReceiptView {...view} images={loaded({ ...images, results: [confirmed] })} />)
    // The list names its days in words: «4 окт».
    expect(list).toContain('<time dateTime="2026-10-04">4\u00a0окт</time>')
    expect(detail).toMatch(/<time dateTime="[^"]+">\d{2}\.\d{2}\.\d{4}/)
    for (const html of [list, detail]) expect(html.replace(/<time\b[^>]*>[^<]*<\/time>|aria-label="[^"]*"/g, '')).not.toMatch(/\d{2}\.\d{2}\.\d{4}|\d+\u00a0окт/)
    expect(detail.match(/<time\b/g)).toHaveLength(2)
  })
  it('marks the numbers of the lines table and the totals with the classes that keep a value whole', () => {
    const html = renderToStaticMarkup(<ReceiptView {...view} />)
    const row = /<tr id="receipt-line-101"[^>]*>([\s\S]*?)<\/tr>/.exec(html)![1]
    expect(row.match(/<td\b/g)).toHaveLength(5)
    expect(row.match(/<td class="receipt-number">/g)).toHaveLength(5)
    expect(row.match(/<th scope="row">/g)).toHaveLength(1)
    // The total of the header is the one hero figure of the page (its class keeps the value whole).
    expect(html).toContain('<p class="receipt-head-total"><span class="receipt-head-label">Итог</span><span class="ck-hero-figure">')
    expect(html.match(/ck-hero-figure/g)).toHaveLength(1)
  })
  it('heads the receipt with its card: place, date, who added it and from where, the total, the categories, then the facts', () => {
    const html = renderToStaticMarkup(<ReceiptHeader receipt={receipt} showOwner categories={[{ id: 3, name: 'Продукты' }]} />)
    expect(html.startsWith('<div class="receipt-head"><div class="receipt-head-top"><div class="receipt-head-main"><h3 class="receipt-store-name">')).toBe(true)
    expect(html).toContain('<dl class="receipt-head-meta"><div><dt>Дата и время покупки</dt><dd><time dateTime=')
    expect(html).toContain('<div><dt>Добавил</dt><dd class="receipt-owner">')
    expect(html).toContain('<div><dt>Откуда</dt><dd>по чеку</dd></div></dl>')
    expect(html).toContain('<ul class="receipt-head-chips" aria-label="Категории"><li><span class="receipt-line-chip" data-tone="3">Продукты</span></li></ul>')
    expect(html.indexOf('receipt-head-total')).toBeLessThan(html.indexOf('receipt-head-chips'))
    expect(html.indexOf('receipt-head-chips')).toBeLessThan(html.indexOf('<dl class="receipt-facts">'))
    expect(html).not.toContain('<dt>Итог</dt>')
    expect(html).not.toContain('ck-tape')
  })

  it('names the statement of an imported spend as its source and keeps the rest of the note as the comment', () => {
    const imported = { ...receipt, source: 'manual' as const, store: { ...receipt.store!, address: '', city: '' }, note: 'Аренда · Выписка Kaspi Gold' }
    const html = renderToStaticMarkup(<ReceiptHeader receipt={imported} />)
    expect(html).toContain('<div><dt>Откуда</dt><dd>Выписка Kaspi Gold</dd></div>')
    expect(html).toContain('<div><dt>Комментарий</dt><dd>Аренда</dd></div>')
    // A place typed by hand has no address: no «Не распознано» rows for it.
    expect(html).not.toContain('Не распознано')
    expect(html).not.toContain('<dt>Адрес</dt>')
  })
  it('puts the actions into the header card, the photo as a thumbnail on a phone and the deletion in a sheet', () => {
    const withPhoto = { ...receipt, preview_image_url: '/media/receipts/71.jpg', preview_thumb_url: '/media/receipts/71-thumb.jpg' }
    const phone = renderToStaticMarkup(<ReceiptView {...view} header={{ state: { kind: 'ok', data: withPhoto }, retry: noop }} narrow />)
    // The last thing of the header card, before the images; no pinned bar of its own above the navigation.
    expect(phone).toContain('<div class="receipt-toolbar"><div class="receipt-actions receipt-delete-bar ck-action-bar"><button type="button" class="receipt-secondary" aria-label="Удалить чек">Удалить</button></div></div></section>')
    expect(phone.indexOf('receipt-toolbar')).toBeLessThan(phone.indexOf('Изображения чека'))
    expect(phone).toContain('<button type="button" class="receipt-photo-thumb" aria-haspopup="dialog" aria-expanded="false"><img src="/media/receipts/71-thumb.jpg" alt=""')
    // A phone goes back with the top bar of the shell; a wide screen keeps its link.
    expect(phone).not.toContain('receipt-back')
    const wide = renderToStaticMarkup(<ReceiptView {...view} header={{ state: { kind: 'ok', data: withPhoto }, retry: noop }} />)
    expect(wide).not.toContain('receipt-photo-thumb')
    expect(wide).toContain('<p class="receipt-back"><a class="action-link" href="/receipts">К тратам</a></p>')
    expect(wide.indexOf('receipt-delete-bar')).toBeLessThan(wide.indexOf('Изображения чека'))
    const asking = renderToStaticMarkup(<ReceiptDeleteActions receiptId={71} narrow initial={{ kind: 'confirm', withPhoto: true }} />)
    expect(asking).toContain('<div class="ck-sheet" role="dialog" aria-modal="true"')
    expect(asking).toContain('Удалить чек?</h2>')
    expect(asking).toContain('<div class="expense-confirm" role="group" aria-labelledby="receipt-delete-71">')
    expect(asking.indexOf('receipt-delete-bar')).toBeLessThan(asking.indexOf('ck-sheet'))
    const inline = renderToStaticMarkup(<ReceiptDeleteActions receiptId={71} initial={{ kind: 'confirm', withPhoto: true }} />)
    expect(inline).not.toContain('ck-sheet')
    expect(inline.startsWith('<div class="expense-confirm"')).toBe(true)
  })
  it('opens the full photo with «Скачать оригинал» in a sheet', () => {
    const html = renderToStaticMarkup(<ReceiptPhoto receiptId={71} thumb="/media/a-thumb.jpg" image="/media/a.jpg" download="/media/a.jpg?download=1" initialOpen />)
    expect(html).toContain('Фото чека</h2>')
    expect(html).toContain('<img src="/media/a.jpg" alt="Фото чека №71"')
    expect(html).toContain('Скачать оригинал')
    expect(renderToStaticMarkup(<ReceiptPhoto receiptId={71} thumb={null} image={null} />)).toBe('')
  })
  it('keeps filtered return URL and recovers list page errors without clearing filters', () => {
    const detail = renderToStaticMarkup(<ReceiptView {...view} returnTo="/receipts?q=MILCH&page=2" />)
    expect(detail).toContain('href="/receipts?q=MILCH&amp;page=2"')
    const html = renderToStaticMarkup(<ReceiptsView query={{ page: 5, q: 'MILCH' }} state={{ kind: 'error', reason: 'page_out_of_range', status: 404 }} retry={noop} />)
    expect(html).toContain('href="/receipts?q=MILCH"')
    expect(html).toContain('На первую страницу')
  })
})

describe('who added the receipt (family)', () => {
  const page = { ...emptyPage<Receipt>(), count: 1, pages: 1, results: [{ ...receipt, owner: 'synthetic-two', owner_name: 'Лиза' }] }
  it('names who added it in the list and on the receipt page of a family member', () => {
    expect(receipt.owner).toBe('local')
    const list = renderToStaticMarkup(<ReceiptsView query={{ page: 1 }} state={{ kind: 'ok', data: page }} retry={noop} showOwner />)
    // The name from «Имя» of the admin, not the username: first in the line under the place.
    expect(list).toContain('<span class="spends-row-meta"><span>Лиза</span>')
    expect(list).not.toContain('synthetic-two')
    // An older server without `owner_name`: the username.
    const { owner_name: _name, ...older } = page.results[0]
    expect(_name).toBe('Лиза')
    expect(renderToStaticMarkup(<ReceiptList receipts={[older]} showOwner />)).toContain('<dd class="receipt-owner">synthetic-two</dd>')
    const detail = renderToStaticMarkup(<ReceiptView {...view} showOwner />)
    expect(detail).toContain('<dt>Добавил</dt><dd class="receipt-owner">local</dd>')
  })
  it('shows nothing without a family', () => {
    expect(renderToStaticMarkup(<ReceiptList receipts={page.results} />)).not.toContain('Добавил')
    expect(renderToStaticMarkup(<ReceiptView {...view} />)).not.toContain('Добавил')
    expect(renderToStaticMarkup(<ReceiptHeader receipt={receipt} />)).not.toContain('Добавил')
  })
  it('escapes the name as text', () => {
    const html = renderToStaticMarkup(<ReceiptList receipts={[{ ...receipt, owner: 'x', owner_name: '<i>x</i>' }]} showOwner />)
    expect(html).toContain('&lt;i&gt;x&lt;/i&gt;')
    expect(html).not.toContain('<i>x</i>')
  })
  it('is shown only to a signed-in member of a family', () => {
    const user = { kind: 'user' as const, mode: 'accounts' as const, user: { id: 1, username: 'synthetic-reader', is_staff: false }, permissions: { moderate_catalog: false } }
    expect(ownerShown({ ...user, household: { id: 4, name: 'Демо-семья', members: ['synthetic-reader', 'synthetic-two'] } })).toBe(true)
    expect(ownerShown({ ...user, household: null })).toBe(false)
    expect(ownerShown({ kind: 'guest', expired: false })).toBe(false)
    expect(ownerShown({ kind: 'loading' })).toBe(false)
  })
})

describe('compressed previews and the original download (SSR)', () => {
  const receipts = publicFixture('receipts.json') as Page<Receipt>
  const crop = () => images.results.find((image) => image.receipt_id === 71)!
  it('lists receipts with the 400 px thumbnail, linked to the full crop', () => {
    const html = renderToStaticMarkup(<ReceiptList receipts={receipts.results} />)
    expect(html).toContain('src="/media/crops/test/thumb-400-v2.webp"')
    expect(html).toContain('href="/media/crops/test/crop.png"')
    expect(html).toContain('loading="lazy"')
  })
  it('shows a crop of the receipt by its WebP copy with a reserved size and «Скачать оригинал»', () => {
    const html = renderToStaticMarkup(<ReceiptImages images={[crop()]} receiptId={71} />)
    expect(html).toContain('src="/media/crops/test/preview-1600-v2.webp"')
    expect(html).toContain('width="8" height="16"')
    expect(html).toContain('<a class="action-link ck-media-download" href="/media/originals/test/source.png?download=1" download="">Скачать оригинал</a>')
  })
  it('names the PDF of a PDF bill and drops an unsafe download', () => {
    const pdf = renderToStaticMarkup(<ReceiptImages images={[{ ...crop(), download_url: '/media/originals/u/source.pdf?download=1' }]} receiptId={71} />)
    expect(pdf).toContain('download="">Скачать оригинал (PDF)</a>')
    for (const url of [null, '/media/originals/u/source.pdf', 'https://example.com/a.pdf?download=1', '/media/../x.pdf?download=1', '/media/a.pdf?download=1&x=1']) {
      const html = renderToStaticMarkup(<ReceiptImages images={[{ ...crop(), download_url: url }]} receiptId={71} />)
      expect(html, String(url)).not.toContain('Скачать оригинал')
    }
  })
  it('falls back to the full image when the server sends no copy or an unsafe one', () => {
    const html = renderToStaticMarkup(<ReceiptMedia url="/media/crops/test/crop.png" display={null} alt="Вырезка" />)
    expect(html).toContain('src="/media/crops/test/crop.png"')
    const unsafe = renderToStaticMarkup(<ReceiptMedia url="/media/crops/test/crop.png" display="https://example.com/x.webp" alt="Вырезка" />)
    expect(unsafe).toContain('src="/media/crops/test/crop.png"'); expect(unsafe).not.toContain('example.com')
  })
})
