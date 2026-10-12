import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { CountryEntry } from '../../api/countries'
import type { Job, ReceiptImageDetail } from '../../api/recognition'
import { isJobDetail, isReceiptImageDetail } from '../../api/recognition-schema'
import { publicFixture } from '../../api/recognition-test-support'
import JobSummary from './JobSummary'
import { CropPin } from './ReceiptImages'
import ReviewForm from './ReviewForm'
import type { ReviewFormProps } from './ReviewForm'
import { cropToggleLabel, jobsFilterCount, lineAmountText, lineCardId, lineDetailsForced, lineIssues, stickyOpen } from './mobile-state'
import { createReview, reviewReducer } from './review-state'
import type { ReviewEdit, ReviewState } from './review-state'
import { filtersLabel } from './_tmp-foundation-state'

function image(): ReceiptImageDetail { const value = publicFixture('receipt-image.json'); if (!isReceiptImageDetail(value)) throw new Error('Invalid fixture'); return value }
function job(): Job { const value = publicFixture('job-running.json'); if (!isJobDetail(value)) throw new Error('Invalid fixture'); return value }
const countries: CountryEntry[] = [{ code: 'DE', name: 'Германия', currencies: ['EUR'], stores_count: 1, products_count: 1 }]
const start = () => createReview(image().normalized_result, image().issues)
const apply = (state: ReviewState, ...edits: ReviewEdit[]) => edits.reduce(reviewReducer, state)
const form = (state: ReviewState, props: Partial<ReviewFormProps> = {}) => renderToStaticMarkup(
  <ReviewForm imageId={42} state={state} dispatch={vi.fn()} countries={countries} pending={false} onConfirm={vi.fn()} compact {...props} />)

describe('pure rules of the phone view of recognition', () => {
  it('keeps a forced disclosure open after its reason is gone, and lets the person fold it', () => {
    expect(stickyOpen(false, false)).toBe(false)
    expect(stickyOpen(false, true)).toBe(true)
    expect(stickyOpen(true, false)).toBe(true)
  })
  it('counts the active filters of the jobs list', () => {
    expect(jobsFilterCount({})).toBe(0)
    expect(jobsFilterCount({ status: 'failed' })).toBe(1)
    expect(jobsFilterCount({ status: 'failed', photo: 3, needs_review: 1 })).toBe(3)
    expect(filtersLabel(0)).toBe('Фильтры'); expect(filtersLabel(2)).toBe('Фильтры (2)')
  })
  it('lists the lines with problems in the order of the form, each once with its texts', () => {
    const state = start()
    const issues = lineIssues(state)
    expect(issues).toEqual([{ key: 1, index: 0, title: 'Строка 1: МОЛОКО', problems: ['Не удалось прочитать обязательное поле'] }])
    // The quantity is folded under «Подробнее»: its problem opens the disclosure.
    expect(lineDetailsForced(state, 1)).toBe(true)
    const fixed = apply(state, { type: 'line', key: 1, patch: { quantity: '1' } })
    expect(lineIssues(fixed)).toEqual([]); expect(lineDetailsForced(fixed, 1)).toBe(false)
    // A problem of the name is not inside «Подробнее»: the line is listed, the disclosure stays as it is.
    const missing = apply(fixed, { type: 'line', key: 1, patch: { name: '' } }, { type: 'missing', problems: { 'lines.1.name': ['Заполните поле.'] } })
    expect(lineIssues(missing)).toEqual([{ key: 1, index: 0, title: 'Строка 1', problems: ['Заполните поле.'] }])
    expect(lineDetailsForced(missing, 1)).toBe(false)
  })
  it('shows the amount of a line as typed, a dash when empty', () => {
    expect(lineAmountText({ amount: ' 4,52 ' })).toBe('4,52'); expect(lineAmountText({ amount: '' })).toBe('—')
    expect(lineCardId(42, 7)).toBe('review-42-line-7')
    expect(cropToggleLabel(true)).toBe('Скрыть фото'); expect(cropToggleLabel(false)).toBe('Показать фото')
  })
})

describe('phone markup of the correction form (SSR, compact)', () => {
  it('draws one card per line: a leader with the amount in figures, the main fields, the rest under «Подробнее»', () => {
    const html = form(apply(start(), { type: 'line', key: 1, patch: { amount: '1,29' } }))
    expect(html).toContain('<li id="review-42-line-1" tabindex="-1" class="ck-review-line">')
    expect(html).toContain('<p class="ck-leader ck-review-line-sum" aria-hidden="true"><span>МОЛОКО</span><span class="ck-figures">1,29</span></p>')
    const card = html.slice(html.indexOf('id="review-42-line-1"'), html.indexOf('Удалить строку 1'))
    const [main, more] = card.split('<details')
    for (const field of ['name', 'kind', 'amount']) expect(main).toContain(`id="review-42-lines-1-${field}"`)
    for (const field of ['quantity', 'unit', 'unit_price', 'tax_rate-kind', 'tax_rate-rate', 'tax_code']) {
      expect(more, field).toContain(`id="review-42-lines-1-${field}"`); expect(main, field).not.toContain(`id="review-42-lines-1-${field}"`)
    }
    expect(more).toMatch(/^ class="ck-review-line-more" open=""><summary>Подробнее<\/summary>/)
    // «Добавить строку» stays after the last card, the confirmation stays in the pinned bar.
    expect(html.indexOf('Добавить строку')).toBeGreaterThan(html.indexOf('Удалить строку 1'))
    expect(html).toContain('<div class="ck-rec-action-block ck-action-bar"><div class="ck-rec-actions"><button type="button" data-review-confirm')
  })
  it('folds «Подробнее» while nothing inside has a problem', () => {
    const html = form(apply(start(), { type: 'line', key: 1, patch: { quantity: '1' } }))
    expect(html).toContain('<details class="ck-review-line-more"><summary>Подробнее</summary>')
    expect(html).not.toContain('ck-review-jumps')
  })
  it('links the lines with problems at the top of the form', () => {
    const html = form(start())
    const nav = /<nav class="ck-review-jumps" aria-label="Строки с замечаниями">([\s\S]*?)<\/nav>/.exec(html)?.[1] ?? ''
    expect(nav).toContain('<p>Строки с замечаниями: 1</p>')
    expect(nav).toContain('<a href="#review-42-line-1">Строка 1: МОЛОКО</a>')
    expect(html.indexOf('ck-review-jumps')).toBeLessThan(html.indexOf('<fieldset class="ck-review-body"'))
  })
  it('keeps every control labelled and its ids unique, as on a wide screen', () => {
    const html = form(start())
    const ids = [...html.matchAll(/<(?:input|select)\b[^>]*\bid="([^"]+)"/g)].map((match) => match[1])
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(html, id).toContain(`<label for="${id}">`)
    expect(form(start(), { compact: false })).not.toMatch(/ck-review-line|ck-review-jumps|<details/)
  })
})

describe('phone markup of the job screens (SSR)', () => {
  it('pins the crop with a button that folds it', () => {
    const html = renderToStaticMarkup(<CropPin><img alt="Вырезка" /></CropPin>)
    expect(html).toMatch(/^<div class="ck-rec-crop-pin"><button type="button" class="ck-review-secondary ck-rec-crop-toggle" aria-expanded="true" aria-controls="([^"]+)">Скрыть фото<\/button><div id="\1" class="ck-rec-crop-image"><img alt="Вырезка"\/><\/div><\/div>$/)
  })
  it('gives a row of the jobs list a status pill and the date, and folds the counters', () => {
    const html = renderToStaticMarkup(<JobSummary job={job()} compact />)
    expect(html).toMatch(/^<div class="ck-rec-summary ck-rec-summary-compact"><p class="ck-rec-status ck-rec-status-running ck-rec-pill">/)
    expect(html.indexOf('Создано:')).toBeLessThan(html.indexOf('<details class="ck-rec-more"><summary>Счётчики и время</summary>'))
    expect(html.indexOf('Найдено чеков')).toBeGreaterThan(html.indexOf('<details'))
    // The wide summary is unchanged.
    expect(renderToStaticMarkup(<JobSummary job={job()} />)).not.toMatch(/ck-rec-pill|<details/)
  })
})
