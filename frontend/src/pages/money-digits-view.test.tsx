import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Category } from '../api/types'
import { emptyDraft, newLine, saveLabel } from '../features/expense/expense-form'
import type { ExpenseDraft } from '../features/expense/expense-form'
import { ExpenseForm } from '../features/expense/ExpensePage'
import { moneyDigits, setMoneyDigits } from '../lib/money-digits'

const noop = () => {}
const category = (id: number, name: string): Category => ({
  id, name, path: [{ id, name }], parent_id: null, depth: 0, children_count: 0, generic_products_count: 0, products_count: 0, products_total: 0,
})
const chips = [category(1, 'Еда')]
/** The real form of a spend; non-breaking spaces become plain ones to keep the expectations readable. */
const form = (draft: ExpenseDraft, narrow: boolean) => renderToStaticMarkup(
  <ExpenseForm draft={draft} chips={chips} errors={{}} saving={false} onChange={noop} onSubmit={noop} today="2026-10-12" narrow={narrow} />,
).replace(/[\xa0\u202f]/g, ' ')
const inputs = (html: string) => html.match(/<(?:input|textarea|select)\b[^>]*>/g) ?? []
const field = (html: string, id: string) => inputs(html).find((tag) => tag.includes(`id="${id}"`)) ?? ''

// One position: 2 pieces at 4 910,735 — 9 821,47 to pay. The price has more places than a cent on purpose.
const cheese = { ...newLine(), name: 'Сыр', quantity: '2', price: '4910.735', amount: '9821.47' }
const draft: ExpenseDraft = { ...emptyDraft('KZT', '2026-10-12'), lines: [cheese] }

describe('«Суммы» on a real screen: the form of a spend (Vitest/SSR, not browser visual acceptance)', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    setMoneyDigits('whole')
  })

  it('redraws the amounts of a phone form with cents, and back; the unit price and the fields stay', () => {
    expect(moneyDigits()).toBe('whole')
    const whole = form(draft, true)
    expect(whole).toContain('<span class="expense-line-title">Сыр</span><span class="expense-line-detail">2 шт × 4 910,74 ₸</span></span><span class="expense-line-sum">9 822 ₸</span>')
    expect(whole).toContain('<button type="submit" class="expense-save">Сохранить · 9 822 ₸</button>')
    expect(whole).not.toContain('9 821,47 ₸')

    setMoneyDigits('cents')
    const cents = form(draft, true)
    // The amount follows the choice; the unit price (`formatPrice`) beside it is the same text as before.
    expect(cents).toContain('<span class="expense-line-title">Сыр</span><span class="expense-line-detail">2 шт × 4 910,74 ₸</span></span><span class="expense-line-sum">9 821,47 ₸</span>')
    expect(cents).toContain('<button type="submit" class="expense-save">Сохранить · 9 821,47 ₸</button>')
    expect(cents).not.toContain('9 822 ₸')
    // Nothing else of the screen moved: the two shown amounts are the whole difference.
    expect(cents.replaceAll('9 821,47 ₸', '9 822 ₸')).toBe(whole)
    // The read-only «Сумма позиций» is a field, not a shown amount: exact in both modes.
    expect(field(whole, 'expense-amount')).toContain('value="9 821,47"')
    expect(field(cents, 'expense-amount')).toBe(field(whole, 'expense-amount'))
    expect(inputs(cents)).toEqual(inputs(whole))

    setMoneyDigits('whole')
    expect(form(draft, true)).toBe(whole)
  })

  it('leaves every field of the wide form as typed', () => {
    const whole = form(draft, false)
    setMoneyDigits('cents')
    const cents = form(draft, false)
    for (const html of [whole, cents]) {
      expect(field(html, `expense-line-${cheese.key}-amount`)).toContain('value="9821.47"')
      expect(field(html, `expense-line-${cheese.key}-price`)).toContain('value="4910.735"')
      expect(field(html, `expense-line-${cheese.key}-quantity`)).toContain('value="2"')
      expect(field(html, 'expense-amount')).toContain('value="9 821,47"')
    }
    expect(inputs(cents)).toEqual(inputs(whole))
    expect(inputs(whole).length).toBeGreaterThan(5)
    expect(whole).toContain('<button type="submit" class="expense-save">Сохранить · 9 822 ₸</button>')
    expect(cents).toContain('<button type="submit" class="expense-save">Сохранить · 9 821,47 ₸</button>')
  })

  it('words «Сохранить · сумма» by the choice', () => {
    const typed = (amount: string) => saveLabel({ ...emptyDraft('KZT', '2026-10-12'), amount }).replace(/\xa0/g, ' ')
    expect([typed('4500'), typed('12 500,01'), typed('1200+350'), typed(''), typed('0')])
      .toEqual(['Сохранить · 4 500 ₸', 'Сохранить · 12 501 ₸', 'Сохранить · 1 550 ₸', 'Сохранить', 'Сохранить'])
    expect(saveLabel(draft).replace(/\xa0/g, ' ')).toBe('Сохранить · 9 822 ₸')
    setMoneyDigits('cents')
    expect([typed('4500'), typed('12 500,01'), typed('1200+350'), typed(''), typed('0')])
      .toEqual(['Сохранить · 4 500,00 ₸', 'Сохранить · 12 500,01 ₸', 'Сохранить · 1 550,00 ₸', 'Сохранить', 'Сохранить'])
    expect(saveLabel(draft).replace(/\xa0/g, ' ')).toBe('Сохранить · 9 821,47 ₸')
  })

  it('takes a stored choice of the device on a fresh page', () => {
    vi.stubGlobal('window', { localStorage: { getItem: (key: string) => key === 'checkist.moneyDigits' ? 'cents' : null, setItem: noop } })
    // `test-setup.ts` forgot the choice before this test: the first read asks the storage.
    expect(saveLabel(draft).replace(/\xa0/g, ' ')).toBe('Сохранить · 9 821,47 ₸')
  })

  it('is followed by the shell itself, with no key on the root', () => {
    const app = readFileSync(new URL('../App.tsx', import.meta.url), 'utf8')
    expect(app).toContain("import { useMoneyDigits } from './lib/money-digits'")
    expect(app).toMatch(/export default function App\(\) \{[\s\S]*?\n {2}useMoneyDigits\(\)\n/)
    expect(app).not.toMatch(/key=\{[^}]*[dD]igits/)
  })
})
