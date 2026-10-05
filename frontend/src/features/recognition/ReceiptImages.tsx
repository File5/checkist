import type { ReceiptImage } from '../../api/recognition'
import RequestState from '../../components/RequestState'
import { Link } from '../../navigation'
import { imageLabels, issueLabels } from './labels'
import MediaImage from './MediaImage'
import ReviewResult from './ReviewResult'

const fieldNames: Record<string, string> = {
  quantity: 'Количество', raw_name: 'Название', name: 'Название', amount: 'Сумма', total: 'Итого', unit: 'Единица измерения',
  unit_price: 'Цена за единицу', currency: 'Валюта', currency_code: 'Валюта', purchased_on: 'Дата', local_time: 'Время',
  tax_rate: 'Ставка налога', tax_amount: 'Сумма налога', discount_amount: 'Скидка', discount_total: 'Скидка на чек',
  product: 'Товар', store: 'Магазин', merchant: 'Продавец', identity: 'Сопоставление чека', geometry: 'Границы чека',
  bbox: 'Границы чека', quad: 'Границы чека', clipped: 'Обрезанный чек', operation: 'Операция', prices_include_tax: 'Налог в ценах',
}
function issueField(field: string) {
  if (field === '/') return ''
  const parts = field.slice(1).split('/')
  const group = { lines: 'Строки', discounts: 'Скидки', taxes: 'Налоги' }[parts[0] as 'lines' | 'discounts' | 'taxes']
  if (group) return `${group}${parts[1] !== undefined ? ` · запись ${Number(parts[1]) + 1}` : ''}${parts[2] ? ` · ${fieldNames[parts[2]] ?? 'Поле'}` : ''}`
  return fieldNames[parts.at(-1) ?? ''] ?? 'Поле чека'
}
export default function ReceiptImages({ images, finished = false }: { images: ReceiptImage[]; finished?: boolean }) {
  if (images.length === 0) return <RequestState kind="empty" message={finished ? 'Обработка закончена без вырезок чеков. Посмотрите статус и причины задания.' : 'Вырезок пока нет. Они появятся после поиска чеков на фото.'} />
  return <ol className="ck-rec-list">{[...images].sort((a, b) => a.position - b.position).map((item) => <li className="ck-rec-card" key={item.id}>
    <h3>Чек {item.position} · {imageLabels[item.status]}</h3>
    <MediaImage url={item.image_url} alt={`Вырезка чека ${item.position}`} />
    {item.clipped && <p className="ck-rec-warning">Часть чека обрезана.</p>}
    {item.issues.length > 0 && <><h4>{['imported', 'reused', 'updated'].includes(item.status) ? 'Замечания распознавания' : 'Причины проверки'}</h4><ul>{item.issues.map((issue, index) => <li key={index}>{issueLabels[issue.code]}{issueField(issue.field) && ` · ${issueField(issue.field)}`}</li>)}</ul></>}
    {item.receipt_id !== null && <Link className="action-link" to={{ kind: 'receipt', receiptId: item.receipt_id }}>Открыть чек №{item.receipt_id}</Link>}
    {item.receipt_deleted && <p>Ранее сохранённый чек удалён.</p>}
    {item.status === 'needs_review' && <ReviewResult result={item.normalized_result} />}
  </li>)}</ol>
}
