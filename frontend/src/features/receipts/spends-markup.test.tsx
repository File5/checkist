import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ReceiptListItem } from '../../api/receipts'
import { publicFixture } from '../../api/recognition-test-support'
import type { Page } from '../../api/types'
import { ReceiptsView, ReviewBanner } from './ReceiptsPage'
import { OwnerChips, SpendDays } from './SpendDays'
import { ownerChips } from './spends'

const NBSP = ' '
const noop = () => {}
const base = (publicFixture('receipts.json') as Page<ReceiptListItem>).results[0]
const rows: ReceiptListItem[] = [
  { ...base, id: 1, purchased_on: '2026-10-12', currency: 'KZT', total: '18940.00', owner: 'liza', owner_name: 'Лиза', lines_count: 23,
    store: { ...base.store!, name: 'Magnum' }, category: { id: 3, name: 'Продукты' } },
  { ...base, id: 2, source: 'manual', store: null, preview_image_url: null, purchased_on: '2026-10-12', currency: 'KZT', total: '1060.00',
    owner: 'andrey', owner_name: 'Андрей', lines_count: 1, first_line: 'Такси', category: { id: 8, name: 'Транспорт' } },
  { ...base, id: 3, purchased_on: '2026-10-11', currency: 'EUR', total: '2.38', owner: 'andrey', owner_name: 'Андрей', category: null },
]
const page = (results: ReceiptListItem[]): Page<ReceiptListItem> => ({ count: results.length, page: 1, page_size: 50, pages: 1, results })
const family = ownerChips({ kind: 'user', mode: 'accounts', user: { id: 1, username: 'andrey', is_staff: false },
  household: { id: 4, name: 'Семья', members: ['andrey', 'liza'],
    people: [{ username: 'andrey', display_name: 'Андрей' }, { username: 'liza', display_name: 'Лиза' }] }, permissions: { moderate_catalog: false } }, 'liza')

describe('«Траты» on a phone (Vitest/SSR, not browser visual acceptance)', () => {
  it('shows days with their totals per currency and one linked row per receipt', () => {
    const html = renderToStaticMarkup(<SpendDays receipts={rows} today="2026-10-12" showOwner />)
    expect(html.match(/<h3>[^]*?<\/h3>/g)).toEqual([
      '<h3><time dateTime="2026-10-12">Сегодня</time></h3>', `<h3><time dateTime="2026-10-11">Вчера, 11${NBSP}окт</time></h3>`])
    expect(html).toContain(`<span class="spends-day-sum ck-figures">20${NBSP}000${NBSP}KZT</span>`)
    expect(html).toContain(`<span class="spends-day-sum ck-figures">3${NBSP}EUR</span>`)
    expect(html.match(/<a class="spends-row" href="\/receipts\/\d+">/g)).toHaveLength(3)
    // One strip of receipt tape per day.
    expect(html.match(/<ul class="spends-rows ck-tape">/g)).toHaveLength(2)
    expect(html).toContain(`<span class="spends-row-title">Magnum</span><span class="spends-row-meta">Продукты · Лиза · 23${NBSP}позиции</span>`)
    expect(html).toContain(`<span class="spends-row-amount ck-figures">18${NBSP}940${NBSP}KZT</span>`)
    // A spend without a place is titled by its first line and says it has no receipt only to a screen reader.
    expect(html).toContain('<span class="spends-row-title">Такси<span class="spends-hidden"> (трата без чека)</span></span>')
  })

  it('tints the badge by the category colour and leaves it neutral without one; a pencil for a manual spend', () => {
    const html = renderToStaticMarkup(<SpendDays receipts={rows} today="2026-10-12" showOwner={false} />)
    const badges = html.match(/<span class="spends-badge"[^>]*>/g)
    expect(badges).toEqual([
      '<span class="spends-badge" data-tone="3" aria-hidden="true">',
      '<span class="spends-badge" data-tone="2" aria-hidden="true">',
      '<span class="spends-badge" aria-hidden="true">',
    ])
    expect(html.match(/<path d="m13\.6/g)).toHaveLength(1)
    expect(html).not.toContain('liza')
  })

  it('escapes names coming from the server', () => {
    const html = renderToStaticMarkup(<SpendDays receipts={[{ ...rows[1], first_line: '<b>x</b>', owner: '<i>o</i>' }]} today="2026-10-12" showOwner />)
    expect(html).toContain('&lt;b&gt;x&lt;/b&gt;')
    expect(html).not.toContain('<b>x</b>')
    expect(html).not.toContain('<i>o</i>')
  })

  it('switches the list to days only on a phone and keeps the wide cards elsewhere', () => {
    const wide = renderToStaticMarkup(<ReceiptsView query={{ page: 1 }} state={{ kind: 'ok', data: page(rows) }} retry={noop} />)
    expect(wide).toContain('class="receipt-list"')
    expect(wide).not.toContain('spends-days')
    const phone = renderToStaticMarkup(<ReceiptsView query={{ page: 1 }} state={{ kind: 'ok', data: page(rows) }} retry={noop} narrow today="2026-10-12" />)
    expect(phone).toContain('class="spends-days"')
    expect(phone).not.toContain('class="receipt-list"')
    // Nothing of a family without one.
    expect(phone).not.toContain('spends-chips')
    expect(phone).not.toContain('spends-review')
  })
})

describe('family chips and the review banner', () => {
  it('links every chip to the list of its member, keeps the filters and marks the current one', () => {
    const html = renderToStaticMarkup(<OwnerChips chips={family} query={{ page: 2, q: 'MILCH', owner: 'liza' }} />)
    expect(html).toContain('<div class="spends-chips"><div class="ck-chip-scroller"><div class="ck-chip-scroller-track" role="region" aria-label="Кто добавил" tabindex="0"><ul>')
    expect(html.match(/<a [^>]*>[^<]*<\/a>/g)).toEqual([
      '<a class="spends-chip" href="/receipts?q=MILCH">Вся семья</a>',
      '<a class="spends-chip" href="/receipts?q=MILCH&amp;owner=andrey">Андрей</a>',
      '<a class="spends-chip" aria-current="true" href="/receipts?q=MILCH&amp;owner=liza">Лиза</a>',
    ])
    expect(renderToStaticMarkup(<OwnerChips chips={[]} query={{ page: 1 }} />)).toBe('')
  })

  it('shows the banner only with photos waiting and links it to the jobs that wait', () => {
    expect(renderToStaticMarkup(<ReviewBanner count={undefined} />)).toBe('')
    expect(renderToStaticMarkup(<ReviewBanner count={0} />)).toBe('')
    expect(renderToStaticMarkup(<ReviewBanner count={3} />))
      .toBe(`<p class="spends-review"><a href="/recognition/jobs?needs_review=1">3${NBSP}фото ждут проверки</a></p>`)
  })

  it('puts chips and the banner above the actions and offers to reset an owner filter on an empty page', () => {
    const html = renderToStaticMarkup(<ReceiptsView query={{ page: 1, owner: 'liza' }} state={{ kind: 'ok', data: page([]) }} retry={noop} chips={family} review={2} />)
    expect(html.indexOf('spends-chips')).toBeLessThan(html.indexOf('spends-review'))
    expect(html.indexOf('spends-review')).toBeLessThan(html.indexOf('receipt-actions'))
    expect(html).toContain('По выбранным фильтрам чеков нет.')
  })

  it('hides the filters behind «Фильтры (N)» on a phone and keeps the form on a wide screen', () => {
    const query = { page: 1, q: 'MILCH', date_from: '2026-10-01', owner: 'liza' }
    const phone = renderToStaticMarkup(<ReceiptsView narrow query={query} state={{ kind: 'ok', data: page([]) }} retry={noop} chips={family} />)
    expect(phone).toContain('<button type="button" class="ck-filters-toggle" aria-haspopup="dialog" aria-expanded="false">Фильтры (2)</button>')
    expect(phone).not.toContain('Применить фильтры')
    const wide = renderToStaticMarkup(<ReceiptsView query={query} state={{ kind: 'ok', data: page([]) }} retry={noop} chips={family} />)
    expect(wide).not.toContain('ck-filters-toggle')
    expect(wide).toContain('Применить фильтры')
  })
})

describe('styles of «Траты» (text of the rules, not rendering)', () => {
  const css = readFileSync(new URL('./Receipts.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '')
  const rule = (selector: string) => [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((match) => match[1].trim() === selector)?.[2].trim() ?? ''

  it('keeps the heading of a day at the top over the tape and the teeth below the last row', () => {
    expect(rule('.spends-day-head')).toContain('position: sticky; top: 0; z-index: 1;')
    expect(rule('.spends-day-head')).toContain('background: var(--ck-bg);')
    expect(rule('.spends-rows')).toContain('padding: 0 0 8px;')
    expect(rule('.ck-sheet .receipt-panel')).toBe('padding: 0; border: 0;')
  })

  it('never wraps an amount, a day total or a chip, and keeps touch targets at least 44px', () => {
    for (const selector of ['.spends-row-amount', '.spends-day-sum', '.spends-chip']) expect(rule(selector), selector).toContain('white-space: nowrap')
    expect(rule('.spends-chip')).toContain('min-height: 44px')
    expect(rule('.spends-review a')).toContain('min-height: 44px')
    expect(rule('.spends-row')).toContain('min-height: 64px')
  })

  it('takes every colour from a token and gives each of the six category tones its colour and tint', () => {
    const spends = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter((match) => match[1].includes('.spends-'))
    expect(spends.length).toBeGreaterThan(10)
    for (const [, selector, body] of spends) expect(body, selector).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    for (let tone = 1; tone <= 6; tone += 1) {
      expect(rule(`.spends-badge[data-tone="${tone}"]`)).toBe(`background: var(--ck-cat-${tone}-tint); color: var(--ck-cat-${tone});`)
    }
    expect(rule('.spends-chip[aria-current="true"]')).toBe('background: var(--ck-chip-selected-bg); border-color: var(--ck-chip-selected-bg); color: var(--ck-chip-selected-text);')
  })

  it('defines the category tokens in both themes', () => {
    const tokens = readFileSync(new URL('../../theme/tokens.css', import.meta.url), 'utf8')
    const block = (selector: string) => { const start = tokens.indexOf(`\n${selector} {`); return tokens.slice(start, tokens.indexOf('\n}', start)) }
    for (const theme of [block(':root'), block(':root[data-theme="light"]')]) {
      for (let tone = 1; tone <= 6; tone += 1) {
        expect(theme).toMatch(new RegExp(`--ck-cat-${tone}: #[0-9a-f]{6};`))
        expect(theme).toMatch(new RegExp(`--ck-cat-${tone}-tint: #[0-9a-f]{6};`))
      }
    }
  })
})
