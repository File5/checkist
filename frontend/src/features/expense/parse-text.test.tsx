import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import type { ManualParse, ManualParseDraft } from '../../api/receipts'
import { readError } from '../../api/http'
import { isManualParse } from '../../api/recognition-schema'
import type { Category } from '../../api/types'
import {
  PARSE_WAIT_MS, draftFromParse, isActive, parseErrorMessage, parseOutcome, parseTexts, requestFailureMessage,
} from './parse-text'
import { TextHintView } from './TextHint'
import type { ParseView } from './parse-text'

const category = (id: number, name: string): Category => ({
  id, name, path: [{ id, name }], parent_id: null, depth: 0, children_count: 0, generic_products_count: 0, products_count: 0, products_total: 0,
})
const chips = [category(1, 'Еда'), category(3, 'Транспорт')]
const executor = (state: 'idle' | 'busy' | 'absent') => ({ available: state !== 'absent', state, last_seen_at: null })
const draft: ManualParseDraft = {
  total: '4500', currency: 'KZT', category: 3, purchased_on: '2026-10-11', store_name: null, note: 'до аэропорта', lines: [],
}
const parse = (patch: Partial<ManualParse> = {}): ManualParse => ({
  id: 7, status: 'queued', draft: null, error: null, created_at: '2026-10-12T10:00:00Z', finished_at: null, executor: executor('idle'), ...patch,
})
const hint = (view: ParseView, text = 'такси 4500') => renderToStaticMarkup(
  <TextHintView text={text} view={view} onText={() => {}} onSubmit={() => {}} />)

describe('«Трата словами»: the answer of the server', () => {
  it('accepts a request and a draft only with its status', () => {
    expect(isManualParse(parse())).toBe(true)
    expect(isManualParse(parse({ status: 'succeeded', draft, finished_at: '2026-10-12T10:00:05Z' }))).toBe(true)
    expect(isManualParse(parse({ status: 'failed', error: { code: 'timeout', message: 'x' } }))).toBe(true)
    expect(isManualParse(parse({ status: 'succeeded' }))).toBe(false)
    expect(isManualParse(parse({ draft }))).toBe(false)
    expect(isManualParse(parse({ status: 'failed' }))).toBe(false)
    expect(isManualParse(parse({ status: 'succeeded', draft: { ...draft, total: '4 500' } }))).toBe(false)
    expect(isManualParse(parse({ status: 'succeeded', draft: { ...draft, lines: [{ name: 'Хлеб', amount: '230.5', quantity: null, category: null }] } }))).toBe(true)
  })
  it('reads 429 parse_limit as its own refusal', () => {
    expect(readError(429, { error: { code: 'parse_limit', message: 'x' } }, true)).toEqual({ kind: 'error', reason: 'parse_limit', status: 429 })
  })
})

describe('«Трата словами»: what the hint says', () => {
  it('waits while the request is queued or running', () => {
    expect(parseOutcome(parse())).toEqual({ kind: 'working' })
    expect(parseOutcome(parse({ status: 'running', executor: executor('busy') }))).toEqual({ kind: 'working' })
    expect(isActive(parse())).toBe(true)
    expect(isActive(parse({ status: 'failed', error: { code: 'x', message: 'x' } }))).toBe(false)
  })
  it('says parsing is unavailable without a worker, and gives up after the wait', () => {
    expect(parseOutcome(parse({ executor: executor('absent') }))).toEqual({ kind: 'failed', message: parseTexts.unavailable })
    expect(parseOutcome(parse(), PARSE_WAIT_MS)).toEqual({ kind: 'failed', message: parseTexts.slow })
  })
  it('fills on success and shows a short Russian message on failure', () => {
    expect(parseOutcome(parse({ status: 'succeeded', draft }))).toEqual({ kind: 'filled' })
    expect(parseOutcome(parse({ status: 'failed', error: { code: 'invalid_output', message: 'server text' } })))
      .toEqual({ kind: 'failed', message: parseTexts.failed })
    expect(parseErrorMessage('timeout')).toBe(parseTexts.timeout)
    expect(parseErrorMessage('expired')).toBe(parseTexts.unavailable)
    expect(parseErrorMessage('provider_unavailable')).toBe(parseTexts.failed)
    expect(requestFailureMessage({ kind: 'error', reason: 'parse_limit' })).toBe(parseTexts.limit)
    expect(requestFailureMessage({ kind: 'error', reason: 'invalid_parameter', fields: ['text'] })).toBe(parseTexts.text)
  })
})

describe('«Трата словами»: the form after a parse', () => {
  it('replaces every field by the draft', () => {
    expect(draftFromParse(draft, chips)).toEqual({
      amount: '4500', currency: 'KZT', category: 3, date: '2026-10-11', place: '', note: 'до аэропорта', lines: [],
    })
    expect(draftFromParse({ ...draft, total: '1299.9', store_name: 'Магнум' }, chips)).toMatchObject({ amount: '1299.90', place: 'Магнум' })
    expect(draftFromParse({ ...draft, total: null }, chips).amount).toBe('')
  })
  it('keeps positions and leaves unknown categories unchosen', () => {
    const filled = draftFromParse({ ...draft, total: '680.00', category: 99, lines: [
      { name: 'Молоко', amount: '450', quantity: null, category: 1 }, { name: 'Хлеб', amount: '230.00', quantity: '2', category: 42 },
    ] }, chips)
    expect(filled.amount).toBe('')
    expect(filled.category).toBeNull()
    expect(filled.lines.map(({ name, amount, category: id }) => [name, amount, id])).toEqual([['Молоко', '450', 1], ['Хлеб', '230', null]])
    expect(new Set(filled.lines.map((line) => line.key)).size).toBe(2)
  })
})

describe('«Трата словами»: markup (Vitest/SSR, not browser visual acceptance)', () => {
  it('is its own small form with a label, a text field and a button', () => {
    const html = hint({ kind: 'idle' })
    expect(html).toContain('<form class="expense-hint" noValidate="" aria-busy="false">')
    expect(html).toContain(`<label for="expense-hint-text" class="expense-hint-label">${parseTexts.label}</label>`)
    expect(html).toMatch(/<input id="expense-hint-text" type="text" autoComplete="off" enterKeyHint="go" maxLength="500" placeholder="такси до аэропорта 4500" aria-describedby="expense-hint-status" value="такси 4500"\/>/)
    expect(html).toContain('<button type="submit" class="expense-hint-send">Заполнить</button>')
    expect(html).toContain('class="expense-hint-status expense-hint-idle" role="status"></p>')
  })
  it('an empty text cannot be sent', () => {
    expect(hint({ kind: 'idle' }, '  ')).toContain('<button type="submit" class="expense-hint-send" disabled="">')
  })
  it('says «Разбираю…» while waiting and keeps the text read-only', () => {
    const html = hint({ kind: 'working' })
    expect(html).toContain('aria-busy="true"')
    expect(html).toContain('readOnly=""')
    expect(html).toContain(`disabled="">${parseTexts.working}</button>`)
    expect(html).toContain(`role="status">${parseTexts.working}</p>`)
  })
  it('announces the fill and a failure', () => {
    expect(hint({ kind: 'filled' })).toContain(`class="expense-hint-status expense-hint-filled" role="status">${parseTexts.filled}</p>`)
    expect(hint({ kind: 'failed', message: parseTexts.unavailable }))
      .toContain(`class="expense-hint-status expense-hint-failed" role="alert">${parseTexts.unavailable}</p>`)
  })
})
