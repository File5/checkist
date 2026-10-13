import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deleteManualSpend, deleteReceipt } from '../../api/receipts'
import type { Line, Receipt } from '../../api/receipts'
import { clearRecognitionCsrf } from '../../api/local'
import { publicFixture } from '../../api/recognition-test-support'
import type { Page } from '../../api/types'
import {
  askDelete, clearReceiptsNotice, deletedNotice, deleteFailureMessage, getReceiptsNotice, setReceiptsNotice, toggleWithPhoto,
} from './delete-receipt'
import { ReceiptDeleteActions } from './ReceiptDeleteActions'
import { ReceiptView } from './ReceiptPage'
import type { BlockRequest, ReceiptViewProps } from './ReceiptPage'
import { ReceiptsView } from './ReceiptsPage'

const fetchMock = vi.fn<typeof fetch>()
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status })
const csrf = () => json(publicFixture('csrf.json'))
beforeEach(() => { clearRecognitionCsrf(); fetchMock.mockReset(); vi.stubGlobal('fetch', fetchMock) })
afterEach(() => { clearRecognitionCsrf(); clearReceiptsNotice(); vi.unstubAllGlobals() })

const receipt = publicFixture('receipt.json') as Receipt
const lines = publicFixture('lines.json') as Page<Line>
const noop = () => {}
const loaded = <T,>(data: T): BlockRequest<T> => ({ state: { kind: 'ok', data }, retry: noop })
const emptyPage = <T,>(): Page<T> => ({ count: 0, page: 1, page_size: 50, pages: 0, results: [] })
const view = (header: Receipt): ReceiptViewProps => ({
  receiptId: header.id, header: loaded(header), lines: loaded(lines), images: loaded(emptyPage()), discounts: loaded(emptyPage()),
  taxes: loaded(emptyPage()), pages: { images: 1, lines: 1, discounts: 1, taxes: 1 }, onPage: noop,
})

describe('deleting a photo receipt (Vitest/SSR, not browser visual acceptance)', () => {
  it('offers «Удалить чек» on a photo receipt and keeps «Изменить / Удалить» of a manual spend', () => {
    const photo = renderToStaticMarkup(<ReceiptView {...view(receipt)} />)
    // The tile says «Удалить»; its name is the whole phrase.
    expect(photo).toContain('<button type="button" class="receipt-secondary" aria-label="Удалить чек">Удалить</button>')
    // Единая форма траты (2026-10-13): чек с фото меняется той же формой.
    expect(photo).toContain('<a class="action-link receipt-primary" href="/receipts/71/edit">Изменить</a>')
    const manual = renderToStaticMarkup(<ReceiptView {...view({ ...receipt, source: 'manual', store: null })} />)
    expect(manual).not.toContain('Удалить чек')
    expect(manual).toContain('>Изменить</a>')
    // Nothing to delete until the receipt is loaded.
    const loading = renderToStaticMarkup(<ReceiptView {...view(receipt)} header={{ state: { kind: 'loading' }, retry: noop }} />)
    expect(loading).not.toContain('Удалить чек')
  })

  it('asks inline with «Удалить и фото» on by default, never with a browser dialog', () => {
    const html = renderToStaticMarkup(<ReceiptDeleteActions receiptId={71} initial={askDelete()} />)
    expect(html).toContain('role="group" aria-labelledby="receipt-delete-71"')
    expect(html).toContain('<p id="receipt-delete-71">Удалить этот чек? Строки чека удалятся, отменить удаление нельзя.</p>')
    expect(html).toContain('<label class="receipt-delete-photo"><input type="checkbox"')
    expect(html).toContain('<input type="checkbox" aria-describedby="receipt-delete-71-hint" checked=""/>Удалить и фото</label>')
    expect(html).toContain('Без отметки они останутся в «Обработке».')
    expect(html).toContain('class="expense-danger">Удалить чек</button>')
    expect(html).toContain('>Отмена</button>')
    expect(html).not.toContain('role="alert"')
    const unchecked = renderToStaticMarkup(<ReceiptDeleteActions receiptId={71} initial={{ kind: 'confirm', withPhoto: false }} />)
    expect(unchecked).not.toContain('checked=""')
    for (const file of ['./ReceiptDeleteActions.tsx', './delete-receipt.ts']) {
      expect(readFileSync(new URL(file, import.meta.url), 'utf8')).not.toMatch(/\b(confirm|alert)\(/)
    }
  })

  it('locks the buttons and the checkbox while deleting and shows a refusal next to them', () => {
    const deleting = renderToStaticMarkup(<ReceiptDeleteActions receiptId={71} initial={{ kind: 'deleting', withPhoto: true }} />)
    expect(deleting).toContain('disabled="">Удаляем…</button>')
    expect(deleting).toContain('disabled="">Отмена</button>')
    expect(deleting).toContain('<input type="checkbox" disabled="" aria-describedby="receipt-delete-71-hint" checked=""/>')
    const failed = renderToStaticMarkup(<ReceiptDeleteActions receiptId={71} initial={{ kind: 'failed', withPhoto: true, message: 'Сбой.' }} />)
    expect(failed).toContain('<p class="expense-failure" role="alert">Сбой.</p>')
    expect(failed).toContain('checked=""')
    expect(failed).toContain('>Удалить чек</button>')
  })

  it('keeps the choice of the checkbox and words the refusals of the server', () => {
    expect(askDelete()).toEqual({ kind: 'confirm', withPhoto: true })
    expect(toggleWithPhoto(askDelete(), false)).toEqual({ kind: 'confirm', withPhoto: false })
    expect(toggleWithPhoto({ kind: 'failed', withPhoto: true, message: 'x' }, false)).toEqual({ kind: 'confirm', withPhoto: false })
    expect(toggleWithPhoto({ kind: 'deleting', withPhoto: true }, false)).toEqual({ kind: 'deleting', withPhoto: true })
    expect(deleteFailureMessage({ kind: 'error', reason: 'job_active', status: 409 })).toContain('ещё распознаётся')
    expect(deleteFailureMessage({ kind: 'error', reason: 'photo_shared', status: 409 })).toContain('Снимите отметку «Удалить и фото»')
    expect(deleteFailureMessage({ kind: 'error', reason: 'network' })).toBe('Не удалось связаться с сервером. Проверьте соединение и повторите попытку.')
    expect(deletedNotice(true)).toBe('Чек удалён вместе с фото.')
    expect(deletedNotice(false)).toBe('Чек удалён. Фото и его задание остались в «Обработке».')
  })

  it('shows the notice once on «Траты»', () => {
    setReceiptsNotice('Чек удалён вместе с фото.')
    expect(getReceiptsNotice()).toBe('Чек удалён вместе с фото.')
    const html = renderToStaticMarkup(<ReceiptsView query={{ page: 1 }} state={{ kind: 'ok', data: emptyPage() }} retry={noop} notice={getReceiptsNotice()} />)
    expect(html).toContain('<div class="receipts-page spends-page"><p class="expense-notice" role="status">Чек удалён вместе с фото.</p>')
    clearReceiptsNotice()
    expect(getReceiptsNotice()).toBeUndefined()
    expect(renderToStaticMarkup(<ReceiptsView query={{ page: 1 }} state={{ kind: 'ok', data: emptyPage() }} retry={noop} />)).not.toContain('expense-notice')
  })
})

describe('DELETE /api/receipts/{id}/ on the wire', () => {
  it('sends ?with_photo=1 only when the photo goes too and reads the refusals', async () => {
    fetchMock.mockResolvedValueOnce(csrf())
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }))
      .mockResolvedValueOnce(json({ error: { code: 'photo_shared', message: 'private server text' } }, 409))
      .mockResolvedValueOnce(json({ error: { code: 'job_active', message: 'private server text' } }, 409))
    expect(await deleteReceipt(71, { withPhoto: true })).toEqual({ kind: 'ok', data: null })
    expect(fetchMock.mock.calls[1][0]).toBe('/api/receipts/71/?with_photo=1')
    expect(fetchMock.mock.calls[1][1]?.method).toBe('DELETE')
    expect(fetchMock.mock.calls[1][1]?.body).toBeUndefined()
    expect(await deleteReceipt(71)).toEqual({ kind: 'ok', data: null })
    expect(fetchMock.mock.calls[2][0]).toBe('/api/receipts/71/')
    expect(await deleteManualSpend(90)).toEqual({ kind: 'ok', data: null })
    expect(fetchMock.mock.calls[3][0]).toBe('/api/receipts/90/')
    expect(await deleteReceipt(71, { withPhoto: true })).toEqual({ kind: 'error', reason: 'photo_shared', status: 409 })
    expect(await deleteReceipt(71)).toEqual({ kind: 'error', reason: 'job_active', status: 409 })
  })
})
