import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ManualSuggestion } from '../../api/receipts'
import { isManualSuggestions } from '../../api/receipts-schema'
import type { Category } from '../../api/types'
import { buildRoute, parseRoute } from '../../navigation'
import { caretAfter, charsBefore, evaluateAmount, groupDigits, hasOperator, ungrouped } from './amount-calc'
import { draftBody, emptyDraft, saveLabel } from './expense-form'
import { ExpenseForm } from './ExpensePage'
import { ManualSpendActions } from './ManualSpendActions'
import { parseTexts } from './parse-text'
import { chipText, draftFromSuggestion, hasSearchWords, suggestionMeta, suggestionTitle } from './suggestions'
import { TextHintView } from './TextHint'

const noop = () => {}
const category = (id: number, name: string): Category => ({
  id, name, path: [{ id, name }], parent_id: null, depth: 0, children_count: 0, generic_products_count: 0, products_count: 0, products_total: 0,
})
const chips = [category(1, 'Еда'), category(15, 'Связь и подписки')]
const claude: ManualSuggestion = {
  receipt_id: 213, store_name: 'CLAUDE.AI SUBSCRIPTION', category: { id: 15, name: 'Связь и подписки' }, currency: 'USD',
  total: '225.00', note: 'Claude Max', purchased_on: '2026-09-12', lines: [], uses: 4,
}
const groceries: ManualSuggestion = {
  receipt_id: 7, store_name: 'Демо-магнит', category: null, currency: 'KZT', total: '680.50', note: '', purchased_on: '2025-12-30',
  lines: [{ name: 'Молоко', amount: '450.00', category: 1 }, { name: 'Хлеб', amount: '230.50', category: 99 }], uses: 1,
}

describe('the amount calculator (no eval)', () => {
  it('counts +, −, ×, ÷ with the usual order and rounds to kopecks', () => {
    expect(evaluateAmount('1200+350')).toBe('1550')
    expect(evaluateAmount('1 200 + 350')).toBe('1550')
    expect(evaluateAmount('3*450-100')).toBe('1250')
    expect(evaluateAmount('100+2×3')).toBe('106')
    expect(evaluateAmount('1000/3')).toBe('333.33')
    expect(evaluateAmount('1000÷3')).toBe('333.33')
    expect(evaluateAmount('2000−500')).toBe('1500')
    expect(evaluateAmount('12,5*2')).toBe('25')
    expect(evaluateAmount('0.1+0.2')).toBe('0.30')
    expect(evaluateAmount('1200+')).toBe('1200') // the operator waits for its number
    for (const bad of ['', '+5', '5++5', '5/0', '100-200', '1e3', 'alert(1)', '(1+2)', '5-5']) expect(evaluateAmount(bad), bad).toBeUndefined()
  })

  it('groups digits while typing and keeps the caret after the same characters', () => {
    expect(groupDigits('12500+350')).toBe('12\u00a0500+350')
    expect(groupDigits('1234567,89')).toBe('1\u00a0234\u00a0567,89')
    expect(ungrouped('12\u00a0500 + 350')).toBe('12500+350')
    expect(charsBefore('12\u00a0500', 4)).toBe(3)
    expect(caretAfter('12\u00a0500', 3)).toBe(4)
    expect(caretAfter('1\u00a0200', 1)).toBe(1)
    expect(caretAfter('1\u00a0200', 5)).toBe(5)
    expect(hasOperator('12.50')).toBe(false)
    expect(hasOperator('12×3')).toBe(true)
  })

  it('saves the counted amount and shows it on the save bar', () => {
    const draft = { ...emptyDraft('KZT', '2026-10-13'), amount: '1200+350', category: 1 }
    expect(draftBody(draft)).toEqual({ body: expect.objectContaining({ total: '1550', lines: [] }) })
    expect(saveLabel(draft)).toBe('Сохранить · 1\u00a0550\u00a0₸')
    expect(draftBody({ ...draft, amount: '500-600' })).toEqual({ errors: { amount: expect.any(String) } })
  })

  it('draws the field grouped, the keys of the calculator and the counted amount', () => {
    const html = renderToStaticMarkup(<ExpenseForm draft={{ ...emptyDraft('KZT', '2026-10-13'), amount: '12000+350' }} chips={chips}
      errors={{}} saving={false} onChange={noop} onSubmit={noop} />)
    expect(html).toContain('value="12\u00a0000+350"')
    expect(html).toContain('<div class="expense-calc-keys" role="group" aria-label="Посчитать сумму">')
    expect(html).toContain('<button type="button" class="expense-calc-key" aria-label="Плюс">+</button>')
    expect(html).toContain('<button type="button" class="expense-calc-key" aria-label="Разделить">÷</button>')
    expect(html).toContain('<output class="expense-calc-result" for="expense-amount">= 12\u00a0350</output>')
    expect(html).toContain('Сохранить · 12\u00a0350\u00a0₸')
  })
})

describe('past spends under «Скажите словами» (no model)', () => {
  it('accepts the answer of the server', () => {
    expect(isManualSuggestions({ results: [claude, groceries] })).toBe(true)
    expect(isManualSuggestions({ results: [{ ...claude, uses: 0 }] })).toBe(false)
    expect(isManualSuggestions({ results: [{ ...claude, total: 225 }] })).toBe(false)
  })

  it('names a spend by its place, else its note, category or first position', () => {
    expect(suggestionTitle(claude)).toBe('CLAUDE.AI SUBSCRIPTION')
    expect(suggestionTitle({ ...claude, store_name: null, note: '· Комиссия' })).toBe('Комиссия')
    expect(suggestionTitle({ ...claude, store_name: null, note: '' })).toBe('Связь и подписки')
    expect(suggestionMeta(claude, '2026-10-13')).toBe('Связь и подписки · 12.09')
    expect(suggestionMeta(groceries, '2026-10-13')).toBe('2 позиции · 30.12.25')
    expect(chipText(claude)).toBe('CLAUDE.AI SUBSCRIPTION · 225\u00a0$')
    expect(hasSearchWords('cl')).toBe(true)
    expect(hasSearchWords('c 225')).toBe(false)
  })

  it('fills the form as a repeat with today', () => {
    expect(draftFromSuggestion(claude, chips, '2026-10-13')).toEqual({
      amount: '225', currency: 'USD', category: 15, date: '2026-10-13', place: 'CLAUDE.AI SUBSCRIPTION', note: 'Claude Max', lines: [],
      item: '',
    })
    // A repeat carries «Что купили»; the row names it after the place.
    const named = { ...claude, item_name: 'Подписка Claude Max 20x' }
    expect(draftFromSuggestion(named, chips, '2026-10-13').item).toBe('Подписка Claude Max 20x')
    expect(suggestionMeta(named, '2026-10-13')).toBe('Подписка Claude Max 20x · 12.09')
    expect(suggestionTitle({ ...named, store_name: null, note: '' })).toBe('Подписка Claude Max 20x')
    const itemized = draftFromSuggestion(groceries, chips, '2026-10-13')
    expect(itemized.amount).toBe('')
    expect(itemized.lines.map(({ name, amount, category }) => [name, amount, category])).toEqual([['Молоко', '450', 1], ['Хлеб', '230.50', null]])
  })

  it('shows rows while the text has words and frequent chips while it is empty', () => {
    const typed = renderToStaticMarkup(<TextHintView text="cla" view={{ kind: 'idle' }} onText={noop} onSubmit={noop}
      suggestions={[claude]} frequent={[groceries]} today="2026-10-13" />)
    expect(typed).toContain('<ul class="ck-list expense-suggest" aria-label="Как в прошлый раз">')
    expect(typed).toContain('<span class="ck-row-title">CLAUDE.AI SUBSCRIPTION</span><span class="ck-row-meta">Связь и подписки · 12.09</span>')
    expect(typed).toContain('<span class="ck-row-amount">225\u00a0$</span>')
    expect(typed).not.toContain('Частые траты')
    const empty = renderToStaticMarkup(<TextHintView text="" view={{ kind: 'repeated' }} onText={noop} onSubmit={noop}
      suggestions={[claude]} frequent={[claude]} />)
    expect(empty).not.toContain('expense-suggest')
    expect(empty).toContain('Частые траты')
    expect(empty).toContain('>CLAUDE.AI SUBSCRIPTION · 225\u00a0$</button>')
    expect(empty).toContain(parseTexts.repeated)
    const working = renderToStaticMarkup(<TextHintView text="cla" view={{ kind: 'working' }} onText={noop} onSubmit={noop} suggestions={[claude]} />)
    expect(working).not.toContain('expense-suggest')
  })

  it('«Повторить» on the page of a manual spend opens a new spend from it', () => {
    expect(renderToStaticMarkup(<ManualSpendActions receiptId={90} />))
      .toContain('<a class="action-link receipt-secondary expense-repeat" href="/receipts/new?repeat=90">Повторить</a>')
    expect(parseRoute('/receipts/new?repeat=90')).toEqual({ kind: 'expense-new', repeat: 90 })
    expect(parseRoute('/receipts/new?repeat=x')).toEqual({ kind: 'expense-new' })
    expect(buildRoute({ kind: 'expense-new', repeat: 90 })).toBe('/receipts/new?repeat=90')
    expect(buildRoute({ kind: 'expense-new' })).toBe('/receipts/new')
  })
})
