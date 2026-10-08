import { useCallback, useState } from 'react'
import type { ReactNode } from 'react'
import { getReceipt, getReceiptDiscounts, getReceiptLines, getReceiptTaxes } from '../../api/receipts'
import type { Discount, Line, Receipt, Tax } from '../../api/receipts'
import { getReceiptImages } from '../../api/recognition'
import type { ReceiptImage } from '../../api/recognition'
import type { Page } from '../../api/types'
import RequestState from '../../components/RequestState'
import { numbered } from '../../lib/text'
import { Link } from '../../navigation'
import type { ReceiptPageProps } from '../../pages/types'
import { ReceiptBlock, ReceiptPagination } from './ReceiptBlock'
import { ReceiptDiscounts, ReceiptHeader, ReceiptImages, ReceiptLines, ReceiptTaxes } from './ReceiptContent'
import type { ReceiptRequestState } from './request'
import { useReceiptRequest } from './useReceiptRequest'
import './Receipts.css'

export type BlockRequest<T> = { state: ReceiptRequestState<T>; retry: () => void }
type DetailPages = { images: number; lines: number; discounts: number; taxes: number }
export type ReceiptViewProps = ReceiptPageProps & {
  header: BlockRequest<Receipt>; images: BlockRequest<Page<ReceiptImage>>; lines: BlockRequest<Page<Line>>
  discounts: BlockRequest<Page<Discount>>; taxes: BlockRequest<Page<Tax>>
  pages: DetailPages; onPage: (block: keyof DetailPages, page: number) => void
}

function PagedBlock<T>({ title, request, empty, page, onPage, children, id }: {
  title: string; request: BlockRequest<Page<T>>; empty: string; page: number; onPage: (page: number) => void; children: ReactNode; id: string
}) {
  const { state, retry } = request
  return <ReceiptBlock title={title} id={id} state={state} retry={retry}
    recovery={state.kind === 'error' && state.reason === 'page_out_of_range' && page > 1
      ? <button type="button" onClick={() => onPage(1)}>На первую страницу</button> : undefined}>
    {state.kind === 'ok' && (state.data.results.length === 0 ? <RequestState kind="empty" message={empty} /> : <>
      <p className="receipt-note" role="status">Всего: {state.data.count.toLocaleString('ru-RU')} · Страница {state.data.page.toLocaleString('ru-RU')} из {state.data.pages.toLocaleString('ru-RU')}</p>
      {children}
      <ReceiptPagination page={state.data.page} pages={state.data.pages} onPage={onPage} label={`Страницы: ${title.toLocaleLowerCase('ru-RU')}`} />
    </>)}
  </ReceiptBlock>
}

export function ReceiptView({ receiptId, returnTo, header, images, lines, discounts, taxes, pages, onPage }: ReceiptViewProps) {
  const receipt = header.state.kind === 'ok' ? header.state.data : undefined
  const visibleLines = lines.state.kind === 'ok' ? lines.state.data.results : []
  return <div className="receipts-page">
    <div className="receipt-actions">
      <Link className="action-link" to={returnTo ?? '/receipts'}>{returnTo?.startsWith('/recognition/jobs/') ? 'К заданию' : 'К чекам'}</Link>
      <Link className="action-link" to="/receipts/upload">Загрузить фото</Link>
      <Link className="action-link" to="/recognition/jobs">Обработка</Link>
    </div>
    <ReceiptBlock title={numbered('Страница чека', receiptId)} state={header.state} retry={header.retry}>
      {receipt && <ReceiptHeader receipt={receipt} />}
    </ReceiptBlock>
    <PagedBlock title="Изображения чека" id="receipt-images" request={images} empty="У этого чека нет изображений."
      page={pages.images} onPage={(page) => onPage('images', page)}>
      {images.state.kind === 'ok' && <ReceiptImages images={images.state.data.results} receiptId={receiptId} />}
    </PagedBlock>
    <PagedBlock title="Строки чека" id="receipt-lines" request={lines} empty="В этом чеке нет строк."
      page={pages.lines} onPage={(page) => onPage('lines', page)}>
      {lines.state.kind === 'ok' && <ReceiptLines lines={lines.state.data.results} currency={receipt?.currency} />}
    </PagedBlock>
    <PagedBlock title="Скидки" id="receipt-discounts" request={discounts} empty="Отдельные скидки в чеке не указаны."
      page={pages.discounts} onPage={(page) => onPage('discounts', page)}>
      {discounts.state.kind === 'ok' && <ReceiptDiscounts discounts={discounts.state.data.results} lines={visibleLines} currency={receipt?.currency} />}
    </PagedBlock>
    <PagedBlock title="Налоги" id="receipt-taxes" request={taxes} empty="Налоги в чеке не указаны."
      page={pages.taxes} onPage={(page) => onPage('taxes', page)}>
      {taxes.state.kind === 'ok' && <ReceiptTaxes taxes={taxes.state.data.results} currency={receipt?.currency} />}
    </PagedBlock>
  </div>
}

function ReceiptScreen({ receiptId, returnTo }: ReceiptPageProps) {
  const [pages, setPages] = useState<DetailPages>({ images: 1, lines: 1, discounts: 1, taxes: 1 })
  const loadHeader = useCallback((signal: AbortSignal) => getReceipt(receiptId, { signal }), [receiptId])
  const loadImages = useCallback((signal: AbortSignal) => getReceiptImages({ receipt: receiptId, page: pages.images }, { signal }), [receiptId, pages.images])
  const loadLines = useCallback((signal: AbortSignal) => getReceiptLines(receiptId, { page: pages.lines }, { signal }), [receiptId, pages.lines])
  const loadDiscounts = useCallback((signal: AbortSignal) => getReceiptDiscounts(receiptId, { page: pages.discounts }, { signal }), [receiptId, pages.discounts])
  const loadTaxes = useCallback((signal: AbortSignal) => getReceiptTaxes(receiptId, { page: pages.taxes }, { signal }), [receiptId, pages.taxes])
  const header = useReceiptRequest(loadHeader)
  const images = useReceiptRequest(loadImages)
  const lines = useReceiptRequest(loadLines)
  const discounts = useReceiptRequest(loadDiscounts)
  const taxes = useReceiptRequest(loadTaxes)
  return <ReceiptView receiptId={receiptId} returnTo={returnTo} header={header} images={images} lines={lines} discounts={discounts} taxes={taxes}
    pages={pages} onPage={(block, page) => setPages((previous) => ({ ...previous, [block]: page }))} />
}

export default function ReceiptPage(props: ReceiptPageProps) {
  return <ReceiptScreen key={props.receiptId} {...props} />
}
