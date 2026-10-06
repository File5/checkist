import { renderToStaticMarkup } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isJobDetail, isPhoto, isReceiptImage, isRecognitionCsrf } from '../../api/recognition-schema'
import { publicFixture } from '../../api/recognition-test-support'
import { JobPage, JobsPage, UploadPage } from './index'
import type { RequestState } from './polling'

const mocked = vi.hoisted(() => ({ states: [] as RequestState<unknown>[] }))
vi.mock('./useRequest', () => ({ useRequest: () => ({ state: mocked.states.shift() ?? { kind: 'loading' }, request: { pause: vi.fn(), resume: vi.fn(), setData: vi.fn(), refresh: vi.fn(), queueRefresh: vi.fn() } }) }))
const fixture = <T,>(name: string, guard: (value: unknown) => value is T) => {
  const value = publicFixture(name); if (!guard(value)) throw new Error('Invalid fixture'); return value
}
const success = <T,>(data: T): RequestState<T> => ({ kind: 'ok', data, refreshing: false })
beforeEach(() => { mocked.states = [] })

describe('page block states with public API data (SSR)', () => {
  it('shows real limits and the queue warning, never the CSRF token', () => {
    const csrf = fixture('csrf.json', isRecognitionCsrf)
    mocked.states = [success(csrf)]
    const html = renderToStaticMarkup(<UploadPage />)
    expect(html).toContain('20 МиБ'); expect(html).toContain('40 000 000'); expect(html).toContain('JPEG, PNG, WEBP')
    expect(html).toContain('ждать в очереди'); expect(html).not.toContain(csrf.csrf_token)
    expect(html).toContain('Фото передаётся облачной модели')
  })
  it('shows a recoverable limits error without allowing upload', () => {
    mocked.states = [{ kind: 'error', error: { kind: 'error', reason: 'permission_denied' } }]
    const html = renderToStaticMarkup(<UploadPage />)
    expect(html).toContain('Локальный сервис недоступен'); expect(html).toContain('Повторить')
    expect(html).toMatch(/type="submit"[^>]*disabled=""/)
  })
  it('renders page links that preserve status and photo and detail links for shell focus return', () => {
    const job = fixture('job-running.json', isJobDetail)
    mocked.states = [success({ count: 3, page: 2, page_size: 1, pages: 3, results: [job] })]
    const html = renderToStaticMarkup(<JobsPage query={{ page: 2, page_size: 1, status: 'running', photo: job.photo_id }} />)
    expect(html).toContain('href="/recognition/jobs/31"'); expect(html).toContain('Фото №11')
    expect(html).toMatch(/href="\/recognition\/jobs\?[^"]*status=running[^"]*"/)
    expect(html).toContain('photo=11'); expect(html).toContain('page_size=1'); expect(html).toContain('aria-current="page"')
    expect(html).toContain('Обрабатывается'); expect(html).toContain('Отменить')
  })
  it('distinguishes no uploads from an empty filtered list', () => {
    const page = { count: 0, page: 1, page_size: 50, pages: 0, results: [] }
    mocked.states = [success(page)]
    expect(renderToStaticMarkup(<JobsPage query={{ page: 1 }} />)).toContain('Фото ещё не загружались')
    mocked.states = [success(page)]
    const filtered = renderToStaticMarkup(<JobsPage query={{ page: 1, status: 'failed' }} />)
    expect(filtered).toContain('По выбранным фильтрам заданий нет'); expect(filtered).toContain('Сбросить фильтры')
  })
  it('offers the first page after page_out_of_range, preserving filters', () => {
    mocked.states = [{ kind: 'error', error: { kind: 'error', reason: 'page_out_of_range' } }]
    const html = renderToStaticMarkup(<JobsPage query={{ page: 100, status: 'failed' }} />)
    expect(html).toContain('На первую страницу'); expect(html).toContain('href="/recognition/jobs?status=failed"')
  })
  it('keeps job and photo available when the crop block fails', () => {
    mocked.states = [success(fixture('job.json', isJobDetail)), success(fixture('photo.json', isPhoto)), { kind: 'error', error: { kind: 'error', reason: 'network' } }]
    const html = renderToStaticMarkup(<JobPage jobId={31} />)
    expect(html).toContain('Завершено частично'); expect(html).toContain('src="/media/originals/test/source.png"')
    expect(html).toContain('Вырезки чеков (2)'); expect(html).toContain('Нет ответа сервера'); expect(html).toContain('Повторить')
  })
  it('keeps review crops available when the source photo fails', () => {
    mocked.states = [success(fixture('job.json', isJobDetail)), { kind: 'error', error: { kind: 'error', reason: 'storage_unavailable' } }, success({ results: [fixture('receipt-image.json', isReceiptImage)] })]
    const html = renderToStaticMarkup(<JobPage jobId={31} />)
    expect(html).toContain('Сервис временно недоступен'); expect(html).toContain('Требует проверки')
    expect(html).toContain('Исправление и подтверждение'); expect(html).toContain('value="МОЛОКО"')
    // job.json is finished: the confirmation is offered, with no draft promised.
    expect(html).toMatch(/<button type="button" data-review-confirm="true" aria-describedby="[^"]+">Подтвердить и сохранить чек<\/button>/)
  })
  it('shows cancel_requested separately from cancelled with disabled cancel and keeps processing updates visible', () => {
    mocked.states = [success(fixture('job-cancel-requested.json', isJobDetail)), { kind: 'loading' }, { kind: 'loading' }]
    const html = renderToStaticMarkup(<JobPage jobId={31} />)
    expect(html).toContain('Отмена запрошена'); expect(html).toContain('Ждём подтверждения отмены')
    expect(html).toMatch(/disabled=""[^>]*>Отменить/); expect(html).not.toContain('ck-rec-status-cancelled')
    expect(html.match(/Загружаем данные/g)).toHaveLength(2)
  })
})
