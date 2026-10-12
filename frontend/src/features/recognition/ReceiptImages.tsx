import { useEffect, useId, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import type { ReceiptImage, ReceiptImageDetail } from '../../api/recognition'
import { focusOwnerAttribute } from '../../components/local-request-focus'
import RecognitionIssues from '../../components/RecognitionIssues'
import RequestState from '../../components/RequestState'
import { formatObservedAt } from '../../lib/format'
import { glue, numbered } from '../../lib/text'
import { useNarrow } from '../../lib/cards'
import { Link } from '../../navigation'
import { imageLabels } from './labels'
import { reviewCropAttribute } from './review-crop'
import MediaImage, { DownloadOriginal } from './MediaImage'
import ReviewResult from './ReviewResult'
import { rememberConfirmed } from './review-actions'
import type { ConfirmedCrops } from './review-actions'
import { useReviewFocus } from './useReviewActions'
import { cropToggleLabel } from './mobile-state'
import type { ReviewControl } from './useReviewActions'

/** A phone: the crop that is being checked stays pinned at the top of its card while the form scrolls under it.
 * Pinch-zoom stays with the browser; «Скрыть фото» folds it to leave the screen to the form. */
export function CropPin({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(true)
  const id = useId()
  return <div className="ck-rec-crop-pin">
    <button type="button" className="ck-review-secondary ck-rec-crop-toggle" aria-expanded={shown} aria-controls={id} onClick={() => setShown(!shown)}>{cropToggleLabel(shown)}</button>
    <div id={id} className="ck-rec-crop-image" hidden={!shown}>{children}</div>
  </div>
}

const noReview: ReviewControl = { state: { kind: 'idle' }, run: async () => undefined }

function ImageCard({ item, confirmed, finished, busy, review, remember, result }: {
  item: ReceiptImage; confirmed: ReceiptImageDetail | undefined; finished: boolean; busy: boolean; review: ReviewControl; remember: () => void; result: RefObject<HTMLParagraphElement | null>
}) {
  const action = review.state
  const addressed = action.kind !== 'idle' && action.imageId === item.id
  // The answer of the confirmation is shown at once and until the list read that follows brings the same crop,
  // also when that read waits for the confirmation of another crop.
  const shown = confirmed && item.status === 'needs_review' ? confirmed : item
  const linked = shown.confirmed_at !== null && (shown.status === 'reused' || shown.status === 'updated')
  // While the form is shown, a refusal is printed in the form, next to the pressed button; the card states everything else.
  const message = addressed && (action.kind === 'done' || action.kind === 'failed') && shown.status !== 'needs_review' ? action.message : ''
  const card = useRef<HTMLLIElement>(null)
  const narrow = useNarrow()
  const lastStatus = useRef(shown.status)
  // A reread after a refusal may replace the form by the saved state: focus that was inside the form goes to the message of the card.
  useEffect(() => {
    const left = lastStatus.current === 'needs_review' && shown.status !== 'needs_review'
    lastStatus.current = shown.status
    if (left && addressed && (!document.activeElement || document.activeElement === document.body)) card.current?.querySelector<HTMLElement>('.ck-rec-result')?.focus()
  }, [shown.status, addressed])
  return <li className="ck-rec-card" ref={card} {...{ [focusOwnerAttribute]: '' }} {...(shown.status === 'needs_review' ? { [reviewCropAttribute]: '', tabIndex: -1 } : {})}>
    <h3><span className="ck-rec-pair">{glue('Чек', shown.position)}</span> · {imageLabels[shown.status]}</h3>
    {narrow && shown.status === 'needs_review'
      ? <CropPin><MediaImage url={shown.image_url} display={shown.display_url} size={shown} alt={`Вырезка чека ${shown.position}`} /></CropPin>
      : <MediaImage url={shown.image_url} display={shown.display_url} size={shown} alt={`Вырезка чека ${shown.position}`} />}
    <DownloadOriginal url={shown.download_url} />
    {shown.clipped && <p className="ck-rec-warning">Часть чека обрезана.</p>}
    <p ref={addressed ? result : undefined} tabIndex={-1} role="status" className={`ck-rec-result${message && action.kind === 'failed' ? ' ck-rec-result-failed' : ''}`}>{message}</p>
    {shown.confirmed_at !== null && <p className="ck-rec-confirmed">Подтверждено вручную: <time dateTime={shown.confirmed_at}>{formatObservedAt(shown.confirmed_at)}</time></p>}
    {linked && <p className="ck-rec-warning">Чек уже был сохранён раньше: вырезка привязана к нему. Заполненные значения этого чека не изменены — исправления к ним не применены. Расхождения перечислены в замечаниях.</p>}
    {shown.status === 'needs_review'
      ? <ReviewResult image={shown} finished={finished} busy={busy} review={review} remember={remember} />
      : <RecognitionIssues issues={shown.issues} status={shown.status} />}
    {shown.receipt_id !== null && <Link className="action-link" to={{ kind: 'receipt', receiptId: shown.receipt_id }}>Открыть {numbered('чек', shown.receipt_id)}</Link>}
    {shown.receipt_deleted && <p>Ранее сохранённый чек удалён.</p>}
  </li>
}

export default function ReceiptImages({ images, finished = false, busy = false, review = noReview }: {
  images: ReceiptImage[]; finished?: boolean
  /** Another action of the job screen is in flight: only one mutation at a time. */
  busy?: boolean; review?: ReviewControl
}) {
  const focus = useReviewFocus<HTMLParagraphElement>(review.state)
  const [saved, setSaved] = useState<ConfirmedCrops>(new Map())
  const confirmed = rememberConfirmed(saved, review.state)
  if (confirmed !== saved) setSaved(confirmed)
  if (images.length === 0) return <RequestState kind="empty" message={finished ? 'Обработка закончена без вырезок чеков. Посмотрите статус и причины задания.' : 'Вырезок пока нет. Они появятся после поиска чеков на фото.'} />
  return <ol className="ck-rec-list">{[...images].sort((a, b) => a.position - b.position).map((item) =>
    <ImageCard key={item.id} item={item} confirmed={confirmed.get(item.id)} finished={finished} busy={busy} review={review} remember={focus.remember} result={focus.result} />)}</ol>
}
