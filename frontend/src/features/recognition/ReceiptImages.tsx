import type { ReceiptImage } from '../../api/recognition'
import RecognitionIssues from '../../components/RecognitionIssues'
import RequestState from '../../components/RequestState'
import { Link } from '../../navigation'
import { imageLabels } from './labels'
import MediaImage from './MediaImage'
import ReviewResult from './ReviewResult'

export default function ReceiptImages({ images, finished = false }: { images: ReceiptImage[]; finished?: boolean }) {
  if (images.length === 0) return <RequestState kind="empty" message={finished ? 'Обработка закончена без вырезок чеков. Посмотрите статус и причины задания.' : 'Вырезок пока нет. Они появятся после поиска чеков на фото.'} />
  return <ol className="ck-rec-list">{[...images].sort((a, b) => a.position - b.position).map((item) => <li className="ck-rec-card" key={item.id}>
    <h3>Чек {item.position} · {imageLabels[item.status]}</h3>
    <MediaImage url={item.image_url} alt={`Вырезка чека ${item.position}`} />
    {item.clipped && <p className="ck-rec-warning">Часть чека обрезана.</p>}
    <RecognitionIssues issues={item.issues} status={item.status} />
    {item.receipt_id !== null && <Link className="action-link" to={{ kind: 'receipt', receiptId: item.receipt_id }}>Открыть чек №{item.receipt_id}</Link>}
    {item.receipt_deleted && <p>Ранее сохранённый чек удалён.</p>}
    {item.status === 'needs_review' && <ReviewResult result={item.normalized_result} />}
  </li>)}</ol>
}
