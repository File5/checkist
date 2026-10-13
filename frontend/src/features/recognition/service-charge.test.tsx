import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { ReceiptImageDetail } from '../../api/recognition'
import { isReceiptImageDetail } from '../../api/recognition-schema'
import { publicFixture } from '../../api/recognition-test-support'
import ReviewForm from './ReviewForm'
import { createReview, reviewReducer } from './review-state'
import type { ReviewState } from './review-state'
import { isServiceCharge } from './service-charge'

function image(): ReceiptImageDetail { const value = publicFixture('receipt-image.json'); if (!isReceiptImageDetail(value)) throw new Error('Invalid fixture'); return value }
const start = () => createReview(image().normalized_result, image().issues)
const form = (state: ReviewState) => renderToStaticMarkup(
  <ReviewForm imageId={42} state={state} dispatch={vi.fn()} countries={[]} pending={false} onConfirm={vi.fn()} />)
const HINT = '<p class="ck-rec-note">Будет учтено как: Обслуживание и чаевые</p>'

describe('service charge hint of the review form', () => {
  it.each(['Обслуживание 10%', 'ОБСЛУЖ. 10 %', 'Сервисный сбор', 'Чаевые', 'Service charge 12.5%', 'Tips', 'Servis ücreti', 'Қызмет көрсету 10%'])(
    'recognizes «%s» of kind «Услуга»', (name) => {
      expect(isServiceCharge('service', name)).toBe(true)
    })

  it('ignores other services and every other kind', () => {
    expect(isServiceCharge('service', 'Доставка')).toBe(false)
    expect(isServiceCharge('service', 'Пакет')).toBe(false)
    expect(isServiceCharge('product', 'Обслуживание 10%')).toBe(false)
    expect(isServiceCharge('', 'Чаевые')).toBe(false)
  })

  it('shows the category read-only under such a line only', () => {
    const state = start()
    expect(form(state)).not.toContain('Будет учтено как')
    const [first] = state.lines
    const service = reviewReducer(state, { type: 'line', key: first.key, patch: { kind: 'service', name: 'Обслуживание 10%' } })
    const html = form(service)
    expect(html.match(/Будет учтено как/g)).toHaveLength(1)
    expect(html).toContain(HINT)
    // Not a control: nothing of it is sent with the confirmation.
    expect(html).not.toMatch(/<(input|select)[^>]*Обслуживание и чаевые/)
    const product = reviewReducer(service, { type: 'line', key: first.key, patch: { kind: 'product' } })
    expect(form(product)).not.toContain('Будет учтено как')
  })
})
