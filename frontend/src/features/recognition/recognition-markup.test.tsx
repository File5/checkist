import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it, vi } from 'vitest'
import type { JobDetail } from '../../api/recognition'
import { jobStatuses } from '../../api/recognition-types'
import { isJobDetail, isReceiptImage } from '../../api/recognition-schema'
import { issue, publicFixture, taxEvidenceMissingIssues } from '../../api/recognition-test-support'
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
    expect(html).toContain('Требует проверки'); expect(html).toContain('<h4>Причины проверки</h4>')
    expect(html).toContain('Не удалось прочитать обязательное поле · Количество'); expect(html).toContain('Строки: 1')
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
  it('keeps successful imports with nonblocking issues successful and offers a return to the receipt', () => {
    // The server gives error only to needs_review/failed crops; an imported crop keeps the same cause as a warning.
    const data = { ...image(), status: 'imported' as const, normalized_result: null, issues: image().issues.map((item) => ({ ...item, severity: 'warning' as const })) }
    const html = renderToStaticMarkup(<ReceiptImages images={[data]} />)
    expect(html).toContain('Чек сохранён')
    expect(html).toContain('Замечания распознавания')
    expect(html).not.toContain('Причины проверки')
    const page = renderToStaticMarkup(<JobPage jobId={31} returnTo="/receipts/71" />)
    expect(page).toContain('href="/receipts/71">К чеку')
  })
  it('groups 29 omissions of an imported crop into three collapsed native disclosures', () => {
    const issues = taxEvidenceMissingIssues().map((item) => ({ ...item, message: 'private issue message' }))
    const html = renderToStaticMarkup(<ReceiptImages images={[{ ...image(), status: 'imported', receipt_id: 71, normalized_result: null, issues }]} />)
    expect(html).toContain('Чек сохранён'); expect(html).toContain('<h4>Замечания распознавания</h4>')
    expect(html.match(/<summary>[^<]*<\/summary>/g)).toEqual([
      '<summary>НДС не использован в 25 строках</summary>', '<summary>Пропущены 2 налоговых итога</summary>', '<summary>Не прочитаны 2 реквизита</summary>'])
    expect(html.match(/<details/g)).toHaveLength(3); expect(html).not.toContain('<details open')
    expect(html).toContain('Распознавание не подтвердило чтение ставки, поэтому ставка не сохранена. Остальные данные строк сохранены.')
    expect(html).toContain(`Строки: ${Array.from({ length: 25 }, (_, index) => index + 1).join(', ')}`)
    expect(html).toContain('Налоговый итог не сохранён: ставка не подтверждена или суммы не сходятся.'); expect(html).toContain('Налоговые итоги №: 1, 2')
    expect(html).toContain('Необязательные реквизиты чека не прочитаны уверенно и не сохранены. Значения не показываются.')
    expect(html).not.toContain('Причины проверки'); expect(html).not.toContain('Некорректное значение')
    expect(html).not.toContain('private issue message'); expect(html).not.toContain('Значение не прошло проверку')
    expect(html).not.toContain('aria-live'); expect(html).not.toContain('Распознанные данные для проверки')
  })
  it('shows line rates, tax totals and requisites in one order for a reversed answer with a foreign group between them', () => {
    const clipped = issue('clipped', 'warning', { entity: 'geometry', attribute: 'clipped' }, { code: 'clipped', field: '/clipped' })
    const [first, ...rest] = taxEvidenceMissingIssues().reverse()
    const html = renderToStaticMarkup(<ReceiptImages images={[{ ...image(), status: 'imported', normalized_result: null, issues: [first, clipped, ...rest] }]} />)
    expect(html.match(/<summary>[^<]*<\/summary>|<p class="rec-issues-title">[^<]*<\/p>/g)).toEqual([
      '<summary>НДС не использован в 25 строках</summary>', '<summary>Пропущены 2 налоговых итога</summary>', '<summary>Не прочитаны 2 реквизита</summary>',
      '<p class="rec-issues-title">Часть чека обрезана · Обрезанный чек</p>'])
    expect(html).toContain(`Строки: ${Array.from({ length: 25 }, (_, index) => index + 1).join(', ')}`); expect(html).toContain('Налоговые итоги №: 1, 2')
  })
  it('keeps review causes always visible and apart from collapsed notes, with unchanged review data', () => {
    const data = image()
    data.issues = [issue('optional_omitted', 'warning', { attribute: 'receipt_metadata' }), ...data.issues,
      issue('total_mismatch', 'error', { attribute: 'total' }, { code: 'total_mismatch', field: '/total', message: 'private issue message' }),
      issue('operation_defaulted', 'info', { attribute: 'operation' })]
    const html = renderToStaticMarkup(<ReceiptImages images={[data]} />)
    const [causes, notes] = html.split('<h4>Замечания распознавания</h4>')
    expect(causes).toContain('<h4>Причины проверки</h4>'); expect(causes).not.toContain('<details')
    expect(causes).toContain('Не удалось прочитать обязательное поле · Количество'); expect(causes).toContain('Сумма строк не совпадает с итогом · Итого')
    expect(notes).toContain('<details><summary>Не прочитан 1 реквизит</summary>'); expect(notes).toContain('Тип операции определён автоматически · Операция')
    expect(notes.indexOf('Не прочитан 1 реквизит')).toBeLessThan(notes.indexOf('Тип операции определён автоматически'))
    expect(notes).toContain('<details class="ck-rec-review" open=""><summary>Распознанные данные для проверки</summary>'); expect(notes).toContain('МОЛОКО')
    expect(html).not.toContain('private issue message'); expect(html).not.toContain('<form')
    const failed = renderToStaticMarkup(<ReceiptImages images={[{ ...data, status: 'failed', normalized_result: null }]} />)
    expect(failed).toContain('<h4>Причины ошибки</h4>'); expect(failed).not.toContain('Причины проверки')
  })
  it('groups an answer of an old server by its code, field and crop status', () => {
    const old = [0, 1, 2].map((index) => ({ code: 'invalid_value' as const, field: `/lines/${index}/tax_rate`, message: 'private issue message' }))
    const imported = renderToStaticMarkup(<ReceiptImages images={[{ ...image(), status: 'imported', normalized_result: null, issues: old }]} />)
    expect(imported).toContain('<h4>Замечания распознавания</h4>'); expect(imported).not.toContain('Причины проверки')
    expect(imported).toContain('<summary>Замечание распознавания · Ставка налога (3)</summary>'); expect(imported).toContain('Строки распознавания №: 1, 2, 3')
    const review = renderToStaticMarkup(<ReceiptImages images={[{ ...image(), issues: old }]} />)
    expect(review).toContain('<h4>Причины проверки</h4>'); expect(review).not.toContain('<h4>Замечания распознавания</h4>')
    expect(review).toContain('Замечание распознавания · Ставка налога (3)')
    for (const html of [imported, review]) { expect(html).not.toContain('private issue message'); expect(html).not.toContain('Некорректное значение') }
  })
  it('renders no issue block for a crop without issues', () => {
    const html = renderToStaticMarkup(<ReceiptImages images={[{ ...image(), status: 'imported', normalized_result: null, issues: [] }]} />)
    expect(html).not.toContain('rec-issues'); expect(html).not.toContain('Замечания распознавания')
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
