import { useCallback, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { getReceipt, getReceiptDiscounts, getReceiptLines, getReceiptTaxes } from '../../api/receipts'
import type { Discount, Line, Receipt, Tax } from '../../api/receipts'
import { getReceiptImages } from '../../api/recognition'
import type { ReceiptImage } from '../../api/recognition'
import type { Page } from '../../api/types'
import RequestState from '../../components/RequestState'
import { numbered } from '../../lib/text'
import { ManualSpendActions } from '../expense/ManualSpendActions'
import { clearExpenseNotice, getExpenseNotice } from '../expense/expense-form'
import { Link } from '../../navigation'
import { useSession } from '../../session'
import type { ReceiptPageProps } from '../../pages/types'
import { ReceiptBlock, ReceiptPagination } from './ReceiptBlock'
import { ReceiptDeleteActions } from './ReceiptDeleteActions'
import { ReceiptHideAction } from './ReceiptHideAction'
import { ReceiptPhoto } from './ReceiptPhoto'
import { useNarrow } from '../../lib/cards'
import { ReceiptDiscounts, ReceiptHeader, ReceiptImages, ReceiptLines, ReceiptTaxes } from './ReceiptContent'
import { lineCategories } from './line-facts'
import type { ReceiptRequestState } from './request'
import { ownerShown } from './state'
import { useReceiptRequest } from './useReceiptRequest'
import './Receipts.css'

export type BlockRequest<T> = { state: ReceiptRequestState<T>; retry: () => void }
type DetailPages = { images: number; lines: number; discounts: number; taxes: number }
export type ReceiptViewProps = ReceiptPageProps & {
  header: BlockRequest<Receipt>; images: BlockRequest<Page<ReceiptImage>>; lines: BlockRequest<Page<Line>>
  discounts: BlockRequest<Page<Discount>>; taxes: BlockRequest<Page<Tax>>
  pages: DetailPages; onPage: (block: keyof DetailPages, page: number) => void
  /** «Добавил: имя» in the header: the user is a member of a family. */
  showOwner?: boolean
  /** Shown once after a manual spend was saved on its form. */
  notice?: string
  /** A phone: the photo as a thumbnail in the header, the deletion asked in a sheet. */
  narrow?: boolean
}

function PagedBlock<T>({ title, request, empty, page, onPage, children, id }: {
  title: string; request: BlockRequest<Page<T>>; empty: string; page: number; onPage: (page: number) => void; children: ReactNode; id: string
}) {
  const { state, retry } = request
  // The count stands quietly at the right of the heading; the page line only when there is more than one page.
  const aside = state.kind === 'ok' && state.data.count > 0
    ? <span className="receipt-block-count"><span className="receipt-visually-hidden">Всего: </span>{state.data.count.toLocaleString('ru-RU')}</span> : undefined
  return <ReceiptBlock title={title} id={id} state={state} retry={retry} aside={aside}
    recovery={state.kind === 'error' && state.reason === 'page_out_of_range' && page > 1
      ? <button type="button" onClick={() => onPage(1)}>На первую страницу</button> : undefined}>
    {state.kind === 'ok' && (state.data.results.length === 0 ? <RequestState kind="empty" message={empty} /> : <>
      {state.data.pages > 1 && <p className="receipt-note" role="status">Страница {state.data.page.toLocaleString('ru-RU')} из {state.data.pages.toLocaleString('ru-RU')}</p>}
      {children}
      <ReceiptPagination page={state.data.page} pages={state.data.pages} onPage={onPage} label={`Страницы: ${title.toLocaleLowerCase('ru-RU')}`} />
    </>)}
  </ReceiptBlock>
}

/** Where the link back leads on a wide screen; a phone has «назад» in its top bar. */
const backLabel = (returnTo?: string) => returnTo?.startsWith('/recognition/jobs/') ? 'К заданию'
  : returnTo === '/' || returnTo?.startsWith('/?') ? 'На главную' : 'К тратам'

export function ReceiptView({ receiptId, returnTo, header, images, lines, discounts, taxes, pages, onPage, notice, showOwner = false, narrow = false }: ReceiptViewProps) {
  const receipt = header.state.kind === 'ok' ? header.state.data : undefined
  const visibleLines = lines.state.kind === 'ok' ? lines.state.data.results : []
  // A spend entered by hand has no photo, discounts or taxes: only its lines are shown.
  const manual = receipt?.source === 'manual'
  const actions = receipt && (manual ? <ManualSpendActions receiptId={receiptId} narrow={narrow} />
    : <ReceiptDeleteActions receiptId={receiptId} narrow={narrow} />)
  const hide = receipt && <ReceiptHideAction receiptId={receiptId} hidden={receipt.hidden === true} onChanged={header.retry} />
  const photo = narrow && receipt && !manual ? <ReceiptPhoto receiptId={receiptId} thumb={receipt.preview_thumb_url} image={receipt.preview_image_url}
    download={images.state.kind === 'ok' ? images.state.data.results[0]?.download_url : undefined} /> : undefined
  return <div className="receipts-page receipt-screen">
    {notice && <p className="expense-notice" role="status">{notice}</p>}
    {!narrow && <p className="receipt-back"><Link className="action-link" to={returnTo ?? '/receipts'}>{backLabel(returnTo)}</Link></p>}
    {/* The header card: the number of the receipt small above the place, the hero total, the facts, then the actions. */}
    <ReceiptBlock title={numbered(manual ? 'Трата' : 'Чек', receiptId)} className="receipt-hero" state={header.state} retry={header.retry}>
      {receipt && <ReceiptHeader receipt={receipt} showOwner={showOwner} photo={photo} categories={lineCategories(visibleLines)} />}
      {receipt && <div className="receipt-toolbar">{actions}{hide}</div>}
    </ReceiptBlock>
    {!manual && <PagedBlock title="Изображения чека" id="receipt-images" request={images} empty="У этого чека нет изображений."
      page={pages.images} onPage={(page) => onPage('images', page)}>
      {images.state.kind === 'ok' && <ReceiptImages images={images.state.data.results} receiptId={receiptId} />}
    </PagedBlock>}
    <PagedBlock title={manual ? 'Позиции траты' : 'Строки чека'} id="receipt-lines" request={lines} empty="В этом чеке нет строк."
      page={pages.lines} onPage={(page) => onPage('lines', page)}>
      {lines.state.kind === 'ok' && <ReceiptLines lines={lines.state.data.results} currency={receipt?.currency} manual={manual} />}
    </PagedBlock>
    {!manual && <PagedBlock title="Скидки" id="receipt-discounts" request={discounts} empty="Отдельные скидки в чеке не указаны."
      page={pages.discounts} onPage={(page) => onPage('discounts', page)}>
      {discounts.state.kind === 'ok' && <ReceiptDiscounts discounts={discounts.state.data.results} lines={visibleLines} currency={receipt?.currency} />}
    </PagedBlock>}
    {!manual && <PagedBlock title="Налоги" id="receipt-taxes" request={taxes} empty="Налоги в чеке не указаны."
      page={pages.taxes} onPage={(page) => onPage('taxes', page)}>
      {taxes.state.kind === 'ok' && <ReceiptTaxes taxes={taxes.state.data.results} currency={receipt?.currency} />}
    </PagedBlock>}
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
  const showOwner = ownerShown(useSession())
  const narrow = useNarrow()
  // Read once into the state; the module copy is cleared so that a later visit shows no stale notice.
  const [notice] = useState(() => getExpenseNotice(receiptId))
  useEffect(clearExpenseNotice, [])
  return <ReceiptView narrow={narrow} showOwner={showOwner} notice={notice} receiptId={receiptId} returnTo={returnTo} header={header} images={images} lines={lines} discounts={discounts} taxes={taxes}
    pages={pages} onPage={(block, page) => setPages((previous) => ({ ...previous, [block]: page }))} />
}

export default function ReceiptPage(props: ReceiptPageProps) {
  return <ReceiptScreen key={props.receiptId} {...props} />
}
