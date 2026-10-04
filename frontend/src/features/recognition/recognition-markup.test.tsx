import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { JobDetail } from '../../api/recognition'
import { jobStatuses } from '../../api/recognition-types'
import { isJobDetail, isReceiptImage } from '../../api/recognition-schema'
import { publicFixture } from '../../api/recognition-test-support'
import ActionButtons from './ActionButtons'
import JobSummary from './JobSummary'
import MediaImage from './MediaImage'
import ReceiptImages from './ReceiptImages'
import RequestBlock from './RequestBlock'
import { JobPage, JobsPage, UploadPage } from './index'
import { imageLabels, jobLabels } from './labels'

function job(): JobDetail { const value = publicFixture('job-running.json'); if (!isJobDetail(value)) throw new Error('Invalid fixture'); return value }
function image() { const value = publicFixture('receipt-image.json'); if (!isReceiptImage(value)) throw new Error('Invalid fixture'); return value }

describe('recognition SSR markup (interactive UI remains manual)', () => {
  it.each(jobStatuses)('displays status %s with no invented percentages', (status) => {
    const data = { ...job(), status, stage: 'recognize' as const, progress: { ...job().progress, current_position: 2, detected: 3 } }
    const html = renderToStaticMarkup(<JobSummary job={data} announce />)
    expect(html).toContain(jobLabels[status]); expect(html).toContain('чек 2 из 3')
    expect(html).toContain('aria-live="polite"'); expect(html).not.toContain('%')
    expect(html).toContain('UTC'); expect(html).toContain('Сохранено')
  })
  it('does not expose provider error messages', () => {
    const html = renderToStaticMarkup(<JobSummary job={{ ...job(), error: { code: 'provider_error', message: 'private provider message' }, stalled: true }} />)
    expect(html).toContain('Модель распознавания вернула ошибку'); expect(html).toContain('давно не обновлял')
    expect(html).not.toContain('private provider message')
  })
  it.each([[true, false], [false, true], [false, false]])('uses server actions cancel=%s retry=%s', (cancel, retry) => {
    const html = renderToStaticMarkup(<ActionButtons job={{ ...job(), actions: { can_cancel: cancel, can_retry: retry } }} state={{ kind: 'idle' }} run={vi.fn()} />)
    const buttons = html.match(/<button\b[^>]*>[^<]*<\/button>/g)!
    expect(buttons[0].includes('disabled')).toBe(!cancel); expect(buttons[1].includes('disabled')).toBe(!retry)
  })
  it('disables actions while submitting and cancel after acknowledgement without inventing cancelled', () => {
    const html = renderToStaticMarkup(<ActionButtons job={job()} state={{ kind: 'pending', id: 31, action: 'cancel' }} run={vi.fn()} />)
    expect(html.match(/disabled=""/g)).toHaveLength(2); expect(html).not.toContain('Отменено')
    const accepted = renderToStaticMarkup(<ActionButtons job={job()} state={{ kind: 'message', id: 31, message: 'Ждём сервер', cancelSubmitted: true }} run={vi.fn()} />)
    expect(accepted).toMatch(/disabled=""[^>]*>Отменить/)
  })
  it('shows incomplete recognized data, translated issue and linked receipts without provider text', () => {
    const data = image(); data.receipt_id = 71; data.issues[0].message = 'private issue message'
    const html = renderToStaticMarkup(<ReceiptImages images={[data]} />)
    expect(html).toContain('Требует проверки'); expect(html).toContain('Количество'); expect(html).toContain('запись 1')
    expect(html).toContain('Распознанные данные для проверки'); expect(html).toContain('МОЛОКО'); expect(html).toContain('Не прочитано')
    expect(html).toContain('4,52'); expect(html).toContain('1,29'); expect(html).toContain('href="/receipts/71"')
    expect(html).not.toContain('private issue message'); expect(html).not.toContain('черновик')
  })
  it.each(Object.keys(imageLabels) as (keyof typeof imageLabels)[])('displays crop %s with safe media', (status) => {
    const data = { ...image(), status, normalized_result: status === 'needs_review' ? image().normalized_result : null }
    const html = renderToStaticMarkup(<ReceiptImages images={[data]} />)
    expect(html).toContain(imageLabels[status]); expect(html).toContain('src="/media/crops/test/crop.png"')
  })
  it('renders empty cuts, absent media and deleted receipt separately', () => {
    expect(renderToStaticMarkup(<ReceiptImages images={[]} />)).toContain('Вырезок пока нет')
    expect(renderToStaticMarkup(<ReceiptImages images={[]} finished />)).toContain('Обработка закончена без вырезок')
    expect(renderToStaticMarkup(<MediaImage url="https://external.test/photo.png" alt="Фото" />)).not.toContain('<img')
    const data = { ...image(), image_url: null, receipt_deleted: true }
    const html = renderToStaticMarkup(<ReceiptImages images={[data]} />)
    expect(html).toContain('Изображение пока недоступно'); expect(html).toContain('чек удалён')
  })
  it('keeps the last snapshot visible with refresh failure and retry', () => {
    const html = renderToStaticMarkup(<RequestBlock title="Задание" id="test-job" state={{ kind: 'ok', data: job(), refreshing: false, refreshError: { kind: 'error', reason: 'network' } }} retry={vi.fn()}>{(data) => <JobSummary job={data} />}</RequestBlock>)
    expect(html).toContain('Не удалось обновить'); expect(html).toContain('Обрабатывается'); expect(html).toContain('Повторить обновление')
    expect(html).toContain('data-request-focus-target'); expect(html).toContain('data-request-retry')
  })
  it.each(['loading', 'error'] as const)('renders separate %s block without data', (kind) => {
    const state = kind === 'loading' ? { kind } : { kind, error: { kind: 'error' as const, reason: 'server' as const } }
    const html = renderToStaticMarkup(<RequestBlock title="Вырезки" id="test-images" state={state} retry={vi.fn()}>{() => <p>Private stale data</p>}</RequestBlock>)
    expect(html).toContain(kind === 'loading' ? 'Загружаем данные' : 'Повторить'); expect(html).not.toContain('Private stale data')
  })
  it('mounts stable I1 props, truthful initial loading and cloud warning with no own h1', () => {
    const upload = renderToStaticMarkup(<UploadPage />)
    expect(upload).toContain('Фото передаётся облачной модели'); expect(upload).toContain('.jpg,.jpeg,.png,.webp')
    expect(upload).toContain('Получаем лимиты'); expect(upload).not.toContain('<h1'); expect(upload).not.toContain('type="file" multiple')
    const jobs = renderToStaticMarkup(<JobsPage query={{ page: 3, status: 'failed' }} />)
    expect(jobs).toContain('Страница 3'); expect(jobs).toContain('selected=""')
    const detail = renderToStaticMarkup(<JobPage jobId={31} returnTo="/recognition/jobs?page=3" />)
    expect(detail).toContain('Задание №31'); expect(detail).toContain('href="/recognition/jobs?page=3"')
  })
})
