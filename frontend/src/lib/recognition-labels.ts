import type { RecognitionCode, ReceiptImageStatus } from '../api/recognition'

export const imageLabels: Record<ReceiptImageStatus, string> = {
  pending: 'Ожидает обработки', running: 'Распознаётся', imported: 'Чек сохранён', reused: 'Найден существующий чек',
  updated: 'Чек дополнен', needs_review: 'Требует проверки', failed: 'Ошибка распознавания', cancelled: 'Отменено',
}
export const issueLabels: Record<RecognitionCode, string> = {
  missing_required: 'Не удалось прочитать обязательное поле', invalid_value: 'Некорректное значение',
  total_mismatch: 'Сумма строк не совпадает с итогом', tax_mismatch: 'Налоги не совпадают с итогом',
  timezone_unknown: 'Часовой пояс магазина неизвестен', time_ambiguous: 'Время покупки неоднозначно',
  weak_identity: 'Недостаточно данных для надёжного сопоставления чека', identity_conflict: 'Данные противоречат существующему чеку',
  product_unmatched: 'Товар не сопоставлен', product_ambiguous: 'Найдено несколько похожих товаров', product_conflict: 'Данные товара противоречивы',
  geometry_requires_review: 'Границы чека требуют проверки', clipped: 'Часть чека обрезана', overlap: 'Чеки перекрываются',
  timeout: 'Время обработки истекло', worker_lost: 'Связь с воркером потеряна', storage_unavailable: 'Хранилище изображений недоступно',
  provider_error: 'Модель распознавания вернула ошибку', invalid_output: 'Ответ модели не удалось разобрать', auth_required: 'Оператору нужно войти в сервис распознавания',
  rate_limited: 'Сервис распознавания ограничил запросы', provider_unavailable: 'Сервис распознавания недоступен', network_unavailable: 'Воркер не может подключиться к сети',
  configuration_error: 'Оператору нужно проверить настройки воркера', invalid_input: 'Изображение не подходит для обработки', cancelled: 'Обработка отменена',
  no_receipts: 'Чеки на фото не найдены', too_many_receipts: 'На фото слишком много чеков',
}
