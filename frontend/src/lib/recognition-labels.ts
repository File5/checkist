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
/** Internal causes that the server keeps behind code=invalid_value and names in reason. */
export type InternalReason =
  | 'optional_omitted' | 'operation_defaulted' | 'currency_inferred' | 'ambiguous_value' | 'country_unknown' | 'currency_unknown'
  | 'import_busy' | 'import_failed' | 'merchant_conflict' | 'merchant_tax_id_invalid' | 'product_package_invalid'
  | 'receipt_conflict' | 'receipt_invalid' | 'receipt_line_conflict' | 'receipt_structure_conflict' | 'store_ambiguous'
  | 'store_conflict' | 'tax_rate_invalid' | 'tax_rate_unconfirmed' | 'timestamp_ambiguous' | 'timestamp_conflict'
export type IssueReason = RecognitionCode | InternalReason | 'unknown'
export const reasonLabels: Record<IssueReason, string> = {
  ...issueLabels,
  optional_omitted: 'Необязательное поле не использовано', operation_defaulted: 'Тип операции определён автоматически',
  currency_inferred: 'Валюта определена по стране магазина', ambiguous_value: 'Значение читается неоднозначно',
  country_unknown: 'Страна магазина не определена', currency_unknown: 'Валюта не определена',
  import_busy: 'Сохранение было занято другой обработкой', import_failed: 'Не удалось сохранить чек',
  merchant_conflict: 'Данные продавца противоречат известным', merchant_tax_id_invalid: 'Налоговый номер продавца не прошёл проверку',
  product_package_invalid: 'Данные упаковки товара не использованы', receipt_conflict: 'Данные противоречат сохранённому чеку',
  receipt_invalid: 'Сохранённый чек не прошёл дополнительную проверку', receipt_line_conflict: 'Строка отличается от сохранённой',
  receipt_structure_conflict: 'Состав чека отличается от сохранённого', store_ambiguous: 'Найдено несколько подходящих магазинов',
  store_conflict: 'Данные магазина противоречат известным', tax_rate_invalid: 'Ставка налога некорректна',
  tax_rate_unconfirmed: 'Ставка налога не подтверждена', timestamp_ambiguous: 'Местное время покупки неоднозначно',
  timestamp_conflict: 'Дата и смещение времени противоречат друг другу', unknown: 'Замечание распознавания',
}
/** Area of an issue by context.attribute; receipt_metadata never names the private field. */
export const areaLabels: Record<string, string> = {
  quantity: 'Количество', name: 'Название', amount: 'Сумма', total: 'Итого', unit: 'Единица измерения',
  unit_price: 'Цена за единицу', currency: 'Валюта', purchased_on: 'Дата', local_time: 'Время',
  tax_rate: 'Ставка налога', tax_amount: 'Сумма налога', discount_amount: 'Скидка', discount_total: 'Скидка на чек',
  product: 'Товар', store: 'Магазин', merchant: 'Продавец', identity: 'Сопоставление чека',
  bbox: 'Границы чека', quad: 'Границы чека', clipped: 'Обрезанный чек', operation: 'Операция', prices_include_tax: 'Налог в ценах',
  rotation_degrees: 'Поворот чека', merchant_country_code: 'Страна продавца', merchant_brand_name: 'Название продавца',
  store_country_code: 'Страна магазина', store_name: 'Название магазина', store_address_raw: 'Адрес магазина', store_city: 'Город магазина',
  position: 'Номер строки', kind: 'Тип строки', parent_position: 'Связанная строка', tax_code: 'Код налога',
  net: 'Сумма без налога', tax: 'Сумма налога', gross: 'Сумма с налогом', line_position: 'Строка скидки',
  barcode: 'Штрихкод', store_item_code: 'Код магазина', is_excise: 'Подакцизный', is_marked: 'Маркированный',
  receipt_metadata: 'Реквизиты чека',
}
/** Area of an issue that concerns a whole entity or an attribute without its own label. */
export const entityLabels: Record<string, string> = { line: 'Строки', tax: 'Налоги', discount: 'Скидки', geometry: 'Границы чека' }
