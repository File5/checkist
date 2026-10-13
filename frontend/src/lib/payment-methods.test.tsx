import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Receipt, ReceiptListItem } from '../api/receipts'
import { publicFixture } from '../api/recognition-test-support'
import type { Page } from '../api/types'
import MethodChips from '../components/MethodChips'
import { draftFromParse } from '../features/expense/parse-text'
import { ReceiptHeader } from '../features/receipts/ReceiptContent'
import { SpendDays } from '../features/receipts/SpendDays'
import { isPaymentMethod, lastMethod, rememberMethod } from './payment-methods'

const NBSP = String.fromCharCode(0xa0)
const plain = (text: string) => text.replaceAll(NBSP, ' ')
const base: ReceiptListItem = { ...(publicFixture('receipts.json') as Page<ReceiptListItem>).results[0], categories: undefined }

/** The tests run in Node: a storage of this device in memory. */
beforeEach(() => {
  const items = new Map<string, string>()
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => items.get(key) ?? null, setItem: (key: string, value: string) => { items.set(key, value) },
    removeItem: (key: string) => { items.delete(key) },
  })
})
afterEach(() => { vi.unstubAllGlobals() })

describe('the way of payment (Vitest/SSR, not browser visual acceptance)', () => {
  it('knows the five ways and «не указан»', () => {
    for (const value of ['', 'kaspi_gold', 'forte', 'cash', 'crypto', 'card']) expect(isPaymentMethod(value)).toBe(true)
    for (const value of [null, undefined, 'visa', 1]) expect(isPaymentMethod(value)).toBe(false)
  })
  it('remembers the last chosen way on this device', () => {
    expect(lastMethod()).toBe('')
    rememberMethod('forte')
    expect(lastMethod()).toBe('forte')
    rememberMethod('')
    expect(lastMethod()).toBe('')
    localStorage.setItem('checkist.paymentMethod', 'visa')
    expect(lastMethod()).toBe('')
    // A closed storage (a private window): no default, no error.
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('denied') } })
    rememberMethod('cash')
    expect(lastMethod()).toBe('')
  })
  it('offers five chips, the chosen one pressed', () => {
    const html = renderToStaticMarkup(<MethodChips value="cash" onChange={() => {}} labelledBy="label" />)
    expect(html).toBe('<div class="ck-method-chips" role="group" aria-labelledby="label">'
      + '<button type="button" class="ck-chip" aria-pressed="false">Kaspi Gold</button><button type="button" class="ck-chip" aria-pressed="false">ForteBank</button>'
      + '<button type="button" class="ck-chip" aria-pressed="true">Наличные</button><button type="button" class="ck-chip" aria-pressed="false">Криптовалюта</button>'
      + '<button type="button" class="ck-chip" aria-pressed="false">Другая карта</button></div>')
  })
  it('shows the way short and whole under the amount of a row and on the page of a spend', () => {
    const rows: ReceiptListItem[] = [
      { ...base, id: 1, source: 'manual', store: null, purchased_on: '2026-10-12', currency: 'KZT', total: '1060.00', payment_method: 'kaspi_gold' },
      { ...base, id: 2, source: 'manual', store: null, purchased_on: '2026-10-12', currency: 'KZT', total: '990.00', payment_method: '' },
    ]
    const html = plain(renderToStaticMarkup(<SpendDays receipts={rows} today="2026-10-12" showOwner={false} />))
    expect(html).toContain('1 060 ₸<span class="spends-row-method"><span aria-hidden="true">Kaspi</span><span class="spends-hidden">, Kaspi Gold</span></span></span>')
    expect(html.match(/spends-row-method/g)).toHaveLength(1)
    const page = renderToStaticMarkup(<ReceiptHeader receipt={{ ...rows[0], payment_method: 'cash' } as Receipt} />)
    expect(page).toContain('<div><dt>Оплата</dt><dd>Наличные</dd></div>')
    expect(renderToStaticMarkup(<ReceiptHeader receipt={rows[1] as Receipt} />)).not.toContain('Оплата')
  })
  it('takes the way said in the text; a text that says none leaves the choice of the form', () => {
    const parsed = { total: '4500', currency: 'KZT', category: null, purchased_on: '2026-10-12', store_name: null, note: '', lines: [] }
    expect(draftFromParse({ ...parsed, payment_method: 'cash' }, []).method).toBe('cash')
    expect(draftFromParse({ ...parsed, payment_method: '' }, []).method).toBeUndefined()
  })
})
