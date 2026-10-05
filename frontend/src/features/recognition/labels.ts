import type { Job, JobStage, JobStatus, RecognitionCode, ReceiptImageStatus } from '../../api/recognition'
import type { LocalApiFailure } from '../../api/types'

export const jobLabels: Record<JobStatus, string> = {
  queued: 'В очереди', running: 'Обрабатывается', cancel_requested: 'Отмена запрошена',
  cancelled: 'Отменено', succeeded: 'Завершено', partial_succeeded: 'Завершено частично', failed: 'Ошибка обработки',
}
export const stageLabels: Record<JobStage, string> = {
  waiting: 'Ожидание воркера', prepare: 'Подготовка фото', detect: 'Поиск чеков', crop: 'Вырезка чеков',
  recognize: 'Распознавание', validate: 'Проверка данных', import: 'Сохранение чека', finished: 'Обработка закончена',
}
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
export function isActive(job: Pick<Job, 'status'>) { return ['queued', 'running', 'cancel_requested'].includes(job.status) }
export function acceptJob(previous: Job, next: Job) { return previous.id === next.id && next.version >= previous.version }
export function stageText(job: Job) {
  const { current_position: position, detected } = job.progress
  return `${stageLabels[job.stage]}${position === null ? '' : ` · чек ${position.toLocaleString('ru-RU')}${detected === null ? '' : ` из ${detected.toLocaleString('ru-RU')}`}`}`
}
export const executorWarning = 'Активный воркер не обнаружен. Задание будет ждать в очереди до запуска обработки; доступность простаивающего воркера неизвестна.'
export function errorText(error: LocalApiFailure, mutation = false): string {
  switch (error.reason) {
    case 'unsupported_format': case 'unsupported_media_type': return 'Формат не поддерживается. HEIC и другие форматы сохраните в JPEG или PNG и выберите файл заново.'
    case 'upload_too_large': return 'Файл слишком большой. Уменьшите его размер до лимита сервера.'
    case 'image_too_large': return 'Разрешение фото превышает лимит сервера. Уменьшите изображение.'
    case 'invalid_image': return 'Изображение повреждено, пусто или содержит несколько кадров. Сохраните одно фото в JPEG или PNG.'
    case 'csrf_failed': return 'Токен безопасности устарел. Обновите токен и повторите действие.'
    case 'permission_denied': return 'Локальный сервис недоступен с этого адреса или выключен. Проверьте запуск QA API и разрешение локального доступа.'
    case 'not_found': return 'Запись не найдена. Возможно, она была удалена.'
    case 'page_out_of_range': return 'Такой страницы больше нет. Откройте первую страницу.'
    case 'job_active': return 'Для этого фото уже идёт обработка. Откройте список заданий этого фото.'
    case 'job_terminal': return 'Задание уже завершилось. Отменить его нельзя.'
    case 'retry_not_allowed': return 'Повтор сейчас недоступен.'
    case 'network': case 'timeout': return mutation
      ? 'Ответ сервера не получен. Действие могло выполниться: проверьте задание или список обработки перед повтором.'
      : 'Нет ответа сервера. Проверьте соединение и повторите запрос.'
    case 'storage_unavailable': case 'database_unavailable': case 'server': return mutation
      ? 'Сервис временно недоступен. Фото или действие могли сохраниться: проверьте обработку перед повтором.'
      : 'Сервис временно недоступен. Повторите запрос позже.'
    case 'invalid_response': return 'Ответ сервера не соответствует ожидаемому формату. Проверьте состояние обработки и повторите запрос.'
    default: return 'Запрос не выполнен. Проверьте данные и повторите действие.'
  }
}
