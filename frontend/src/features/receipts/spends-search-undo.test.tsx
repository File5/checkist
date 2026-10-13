import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ReceiptListItem } from '../../api/receipts'
import { publicFixture } from '../../api/recognition-test-support'
import type { Page } from '../../api/types'
import { ReceiptsView, UndoBar } from './ReceiptsPage'
import { SpendDays } from './SpendDays'
import SpendSearch from './SpendSearch'
import { askHref } from './spends'

const NBSP = '\u00a0'
const noop = () => {}
const base: ReceiptListItem = { ...(publicFixture('receipts.json') as Page<ReceiptListItem>).results[0], categories: undefined }
const photo: ReceiptListItem = { ...base, id: 1, purchased_on: '2026-10-12', currency: 'KZT', total: '18940.00', store: { ...base.store!, name: 'Magnum' } }
const manual: ReceiptListItem = { ...base, id: 2, source: 'manual', store: null, preview_image_url: null, purchased_on: '2026-10-12', currency: 'KZT',
  total: '1060.00', first_line: 'Такси', category: { id: 8, name: 'Транспорт' } }
const page = (results: ReceiptListItem[]): Page<ReceiptListItem> => ({ count: results.length, page: 1, page_size: 50, pages: 1, results })

describe('the search line of «Траты» (2026-10-13)', () => {
  it('is one field of the address words; «Спросить» comes with text and carries it to /ask', () => {
    const empty = renderToStaticMarkup(<SpendSearch query={{ page: 1 }} />)
    expect(empty).toContain('<form role="search" class="spends-search"')
    expect(empty).toContain('type="search"')
    expect(empty).toContain('placeholder="Место, комментарий, позиция или сумма"')
    expect(empty).not.toContain('Спросить')
    const asked = renderToStaticMarkup(<SpendSearch query={{ page: 1, q: 'сколько на кафе?' }} />)
    expect(asked).toContain('name="q" value="сколько на кафе?"')
    expect(asked).toContain(`<a class="spends-ask" href="${askHref('сколько на кафе?')}">Спросить</a>`)
    expect(askHref('кофе & чай')).toBe('/ask?q=%D0%BA%D0%BE%D1%84%D0%B5%20%26%20%D1%87%D0%B0%D0%B9')
  })

  it('stands above the chips and the filters on every width', () => {
    for (const narrow of [true, false]) {
      const html = renderToStaticMarkup(<ReceiptsView narrow={narrow} query={{ page: 1 }} state={{ kind: 'ok', data: page([photo]) }} retry={noop} />)
      expect(html.indexOf('class="spends-search"')).toBeGreaterThan(-1)
      expect(html.indexOf('class="spends-search"')).toBeLessThan(html.indexOf('class="spends-toolbar"'))
    }
  })
})

describe('swipe and «Удалено · Отменить» (2026-10-13)', () => {
  it('gives a spend by hand its «Удалить» behind the row; a photo receipt stays a plain row', () => {
    const html = renderToStaticMarkup(<SpendDays receipts={[photo, manual]} today="2026-10-12" showOwner={false} onDelete={noop} />)
    expect(html.match(/class="spends-row-delete"/g)).toHaveLength(1)
    expect(html).toContain('<li class="spends-swipe"><a class="spends-row" href="/receipts/2">')
    expect(html).toContain('<button type="button" class="spends-row-delete">')
    expect(html).toContain('Удалить<span class="spends-hidden">: Такси</span>')
    expect(html).toContain('<li><a class="spends-row" href="/receipts/1">')
    // Without a handler (other screens, older tests) there is nothing to delete.
    expect(renderToStaticMarkup(<SpendDays receipts={[manual]} today="2026-10-12" showOwner={false} />)).not.toContain('spends-row-delete')
  })

  it('leaves the deleted spends out of the list, the day total and the count', () => {
    const html = renderToStaticMarkup(<ReceiptsView query={{ page: 1 }} state={{ kind: 'ok', data: page([photo, manual]) }} retry={noop}
      hidden={new Set([2])} onDelete={noop} today="2026-10-12" />)
    expect(html).not.toContain('href="/receipts/2"')
    expect(html).toMatch(/<span class="spends-day-sum ck-figures">18.940.₸<\/span>/)
    expect(html).toContain(`1${NBSP}трата · Страница 1 из 1`)
  })

  it('shows a refused deletion above the list', () => {
    const html = renderToStaticMarkup(<ReceiptsView query={{ page: 1 }} state={{ kind: 'ok', data: page([manual]) }} retry={noop}
      failure="Не удалось связаться с сервером." />)
    expect(html).toContain('<p class="receipt-warning spends-delete-failure" role="alert">Не удалось связаться с сервером.</p>')
  })

  it('keeps a live region and fills it while a deletion waits', () => {
    expect(renderToStaticMarkup(<UndoBar pending={null} onUndo={noop} />)).toBe('<div class="spends-undo-region" role="status"></div>')
    const html = renderToStaticMarkup(<UndoBar pending={{ id: 2, title: 'Такси' }} onUndo={noop} />)
    expect(html).toContain('<span class="spends-undo-text">Удалено · Такси</span>')
    expect(html).toContain('<button type="button" class="spends-undo-action">Отменить</button>')
  })
})
