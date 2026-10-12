import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isRecognitionCsrf } from '../../api/recognition-schema'
import { publicFixture } from '../../api/recognition-test-support'
import UploadPage, { UploadProgress } from './UploadPage'
import { uploadLabels } from './labels'
import type { RequestState } from './polling'

const mocked = vi.hoisted(() => ({ states: [] as unknown[] }))
vi.mock('./useRequest', () => ({ useRequest: () => ({
  state: mocked.states.shift() ?? { kind: 'loading' },
  request: { pause: vi.fn(), resume: vi.fn(), setData: vi.fn(), refresh: vi.fn(), queueRefresh: vi.fn(), subscribe: vi.fn(), getSnapshot: vi.fn() },
}) }))
beforeEach(() => { mocked.states = [] })

const csrf = () => { const value = publicFixture('csrf.json'); if (!isRecognitionCsrf(value)) throw new Error('Invalid fixture'); return value }
const render = (state?: RequestState<unknown>) => { mocked.states = state ? [state] : []; return renderToStaticMarkup(<UploadPage />) }
const ready = () => render({ kind: 'ok', data: csrf(), refreshing: false })
const tags = (html: string, name: string) => html.match(new RegExp(`<${name}\\b[^>]*>`, 'g')) ?? []
const button = (html: string, label: string) => new RegExp(`<button\\b[^>]*>${label}</button>`).exec(html)?.[0] ?? ''

describe('upload screen markup (SSR)', () => {
  it('lists PDF among the formats and says how many pages it may have', () => {
    const html = ready()
    expect(html).toContain('Форматы: JPEG, PNG, WEBP, HEIC, HEIF, PDF.')
    expect(html).toContain('PDF — до 3 страниц')
  })
  it('has three file fields: the camera one with capture, the gallery one without, the file one with types and extensions, one photo each', () => {
    const fields = tags(ready(), 'input')
    expect(fields).toHaveLength(3)
    const [camera, gallery, file] = fields
    expect(camera).toContain('id="recognition-camera"'); expect(camera).toContain('accept="image/*"'); expect(camera).not.toContain('pdf'); expect(camera).toContain('capture="environment"')
    // The field of useQuickShot('gallery'), the one mechanism of «Из галереи» («＋» menu, «Главная», this page):
    // the photo library, the camera and Files of the phone; its file comes back through onQuickShot and is sent by itself.
    expect(gallery).toContain('class="ck-quick-shot-input"'); expect(gallery).toContain('accept="image/*,.heic,.heif,application/pdf"'); expect(gallery).not.toContain('capture')
    expect(file).toContain('id="recognition-file"'); expect(file).toContain('accept="image/jpeg,image/png,image/webp,image/heic,image/heif,application/pdf,.jpg,.jpeg,.png,.webp,.heic,.heif,.pdf"')
    expect(file).not.toContain('capture')
    for (const field of fields) {
      expect(field).toContain('type="file"'); expect(field).not.toContain('multiple')
      // Pressed by its button only: out of the Tab order and of the accessibility tree.
      if (field !== gallery) expect(field).toContain('class="ck-upload-input"')
      expect(field).toContain('tabindex="-1"'); expect(field).toContain('aria-hidden="true"')
      expect(field).not.toMatch(/\sdisabled/)
    }
  })
  it('offers «Снять чек», «Из галереи» and «Выбрать файл» as ordinary buttons of one group, described by the cloud warning', () => {
    const html = ready()
    const group = /<div class="ck-rec-actions ck-upload-pick" role="group" aria-label="Выбор фото">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ''
    expect(tags(group, 'button')).toHaveLength(3)
    const camera = button(group, 'Снять чек'); const gallery = button(group, 'Из галереи'); const file = button(group, 'Выбрать файл')
    expect(camera).toContain('class="ck-upload-camera"'); expect(gallery).toContain('class="ck-upload-gallery ck-upload-secondary"'); expect(file).toContain('class="ck-upload-secondary"')
    for (const item of [camera, gallery, file]) {
      expect(item).toContain('type="button"'); expect(item).toContain('aria-describedby="recognition-cloud-warning"'); expect(item).not.toContain('disabled')
    }
    expect(html).toContain('id="recognition-cloud-warning"')
    expect(html).not.toContain('id="recognition-pick-wait"')
  })
  it.each([
    ['loading', undefined, uploadLabels.conditionsLoading],
    ['failed', { kind: 'error', error: { kind: 'error', reason: 'network' } } as RequestState<unknown>, uploadLabels.conditionsFailed],
  ])('disables both picking buttons and both fields while the conditions are %s, and says why', (_name, state, note) => {
    const html = render(state)
    for (const label of ['Снять чек', 'Из галереи', 'Выбрать файл']) {
      const item = button(html, label)
      expect(item).toContain('disabled=""'); expect(item).toContain('aria-describedby="recognition-cloud-warning recognition-pick-wait"')
    }
    // The gallery field of useQuickShot has no `disabled`: its button is the one that waits.
    for (const field of tags(html, 'input').filter((tag) => !tag.includes('ck-quick-shot-input'))) expect(field).toContain('disabled=""')
    expect(html).toContain(`<p id="recognition-pick-wait" class="ck-rec-note">${note}</p>`)
    expect(button(html, 'Загрузить фото')).toContain('disabled=""')
  })
  it('puts the form above the conditions and wraps the main action into the pinned bar', () => {
    const html = ready()
    expect(html.indexOf('id="recognition-file-title"')).toBeGreaterThan(-1)
    expect(html.indexOf('id="recognition-file-title"')).toBeLessThan(html.indexOf('id="recognition-limits-title"'))
    const bar = /<div class="ck-rec-actions ck-action-bar">([\s\S]*?)<\/div>/.exec(html)?.[1] ?? ''
    // Only buttons in the bar; without a photo there is nothing to send or to stop.
    expect(bar).toBe('<button type="submit" disabled="">Загрузить фото</button>')
    expect(html).not.toContain('Отменить отправку'); expect(html).not.toContain('<progress')
    expect(html).toContain('<div role="status" aria-live="polite" class="ck-upload-stage"></div>')
  })
  it('puts the stage above its bar and the picking buttons low, right above the main action', () => {
    const html = ready()
    const order = ['class="ck-upload-stage"', 'aria-label="Выбор фото"', 'id="recognition-cloud-warning"', 'class="ck-rec-actions ck-action-bar"'].map((part) => html.indexOf(part))
    for (const index of order) expect(index).toBeGreaterThan(-1)
    expect([...order].sort((a, b) => a - b)).toEqual(order)
  })
  it('keeps the conditions open on a wide screen: the disclosure belongs to a phone only', () => {
    const html = ready()
    expect(html).not.toContain('<details'); expect(html).toContain('<h2 id="recognition-limits-title" tabindex="-1" data-request-focus-target="true">Условия загрузки</h2>')
  })
  it('shows the bytes sent as a progress with a name and one unbreakable value, outside any live region', () => {
    const html = renderToStaticMarkup(<UploadProgress sent={2_202_010} total={5_557_453} />)
    expect(html).toBe('<div class="ck-upload-progress"><progress aria-label="Отправка фото" max="5557453" value="2202010"></progress>'
      + '<p>Отправлено <span class="ck-upload-value">2,1 из 5,3 МиБ</span></p></div>')
    expect(renderToStaticMarkup(<UploadProgress sent={9} total={5} />)).toContain('max="5" value="5"')
  })
})
