import type { ExecutorState, Job, JobStage, JobStatus } from '../../api/recognition'
import type { LocalApiFailure } from '../../api/types'
import { glue } from '../../lib/text'
import { getSession, permissionDeniedText } from '../../session'

export const jobLabels: Record<JobStatus, string> = {
  queued: 'В очереди', running: 'Обрабатывается', cancel_requested: 'Отмена запрошена',
  cancelled: 'Отменено', succeeded: 'Завершено', partial_succeeded: 'Завершено частично', failed: 'Ошибка обработки',
}
export const stageLabels: Record<JobStage, string> = {
  waiting: 'Ожидание воркера', prepare: 'Подготовка фото', detect: 'Поиск чеков', crop: 'Вырезка чеков',
  recognize: 'Распознавание', validate: 'Проверка данных', import: 'Сохранение чека', finished: 'Обработка закончена',
}
export { imageLabels, issueLabels } from '../../lib/recognition-labels'
export function isActive(job: Pick<Job, 'status'>) { return ['queued', 'running', 'cancel_requested'].includes(job.status) }
export function acceptJob(previous: Job, next: Job) { return previous.id === next.id && next.version >= previous.version }
export function stageText(job: Job) {
  const { current_position: position, detected } = job.progress
  return `${stageLabels[job.stage]}${position === null ? '' : ` · ${glue('чек', position.toLocaleString('ru-RU'), ...(detected === null ? [] : ['из', detected.toLocaleString('ru-RU')]))}`}`
}
export type ExecutorNote = { text: string; warning: boolean }
const executorAbsent: ExecutorNote = { text: 'Воркер распознавания не запущен. Задание будет ждать в очереди, пока воркер не запустят.', warning: true }
const uploadExecutorNotes: Partial<Record<ExecutorState, ExecutorNote>> = {
  idle: { text: 'Воркер распознавания запущен и ждёт заданий.', warning: false },
  busy: { text: 'Воркер распознавания сейчас обрабатывает задание. Новое фото встанет в очередь.', warning: false },
  absent: executorAbsent,
}
const queuedExecutorNotes: Partial<Record<ExecutorState, ExecutorNote>> = {
  busy: { text: 'Воркер занят другим заданием. Это задание начнётся после него.', warning: false },
  absent: executorAbsent,
}
/** Upload page line. Unknown (older server or a future state) claims nothing. */
export function uploadExecutorNote(state: ExecutorState) { return uploadExecutorNotes[state] }
/** Job page line: only the current snapshot of a queued job; a stalled job has its own text. */
export function jobExecutorNote(job: Pick<Job, 'status' | 'executor'>) { return job.status === 'queued' ? queuedExecutorNotes[job.executor.state] : undefined }
export function isExecutorAbsent(data: { executor: { state: ExecutorState } }) { return data.executor.state === 'absent' }
/** With accounts a refused access is a missing right, not a switched off local service. */
const accountsSession = () => { const session = getSession(); return session.kind === 'user' && session.mode === 'accounts' }
export function errorText(error: LocalApiFailure, mutation = false): string {
  switch (error.reason) {
    case 'unsupported_format': case 'unsupported_media_type': return 'Формат не поддерживается. HEIC и другие форматы сохраните в JPEG или PNG и выберите файл заново.'
    case 'upload_too_large': return 'Файл слишком большой. Уменьшите его размер до лимита сервера.'
    case 'image_too_large': return 'Разрешение фото превышает лимит сервера. Уменьшите изображение.'
    case 'invalid_image': return 'Изображение повреждено, пусто или содержит несколько кадров. Сохраните одно фото в JPEG или PNG.'
    case 'csrf_failed': return 'Токен безопасности устарел. Обновите токен и повторите действие.'
    case 'permission_denied': return accountsSession() ? permissionDeniedText(getSession())
      : 'Локальный сервис недоступен с этого адреса или выключен. Проверьте запуск QA API и разрешение локального доступа.'
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
/** Texts of the upload screen: picking, reduction, sending and its stop. */
export const uploadLabels = {
  pick: 'Выбрать файл', camera: 'Снять чек', cancel: 'Отменить отправку',
  submit: 'Загрузить фото', retry: 'Повторить загрузку', sending: 'Отправляем фото…', reducing: 'Уменьшаем фото…',
  progress: 'Отправка фото',
  stageReducing: 'Уменьшаем фото перед отправкой. Это может занять несколько секунд.',
  stageUploading: 'Отправляем файл. Дождитесь ответа сервера; распознавание начнётся отдельно.',
  stageWaiting: 'Фото отправлено. Ждём ответ сервера.',
  cancelled: 'Отправка остановлена. Если фото успело дойти, задание появится в „Обработке“.',
  cancelledReducing: 'Подготовка фото остановлена. Фото не отправлялось.',
  reduceFailed: 'Не удалось уменьшить фото на этом устройстве. Снимите чек с меньшим разрешением камеры и выберите фото заново.',
  conditionsLoading: 'Кнопки выбора станут доступны, когда загрузятся условия загрузки.',
  conditionsFailed: 'Условия загрузки не получены: выбор фото недоступен. Повторите запрос в блоке «Условия загрузки».',
}
/** «4096 × 3072»: one value, never split. */
export function sizeText({ width, height }: { width: number; height: number }) {
  return glue(width.toLocaleString('ru-RU', { useGrouping: false }), '×', height.toLocaleString('ru-RU', { useGrouping: false }))
}
/** Refusals of a crop confirmation. The server message is never shown; nothing is replayed automatically. */
export function reviewErrorText(error: LocalApiFailure): string {
  switch (error.reason) {
    case 'review_invalid': return 'Исправленные данные не прошли проверку, чек не сохранён. Причины обновлены, поля отмечены: исправьте их и подтвердите снова.'
    case 'invalid_parameter': return 'Сервер не принял часть значений, чек не сохранён. Проверьте отмеченные поля и подтвердите снова.'
    case 'invalid_request': return 'Сервер не принял запрос, чек не сохранён. Обновите страницу: несохранённые правки при этом будут потеряны.'
    case 'review_resolved': return 'Этот результат уже подтверждён с другими данными. Ваши правки не сохранены; показываем актуальное состояние.'
    case 'review_unavailable': return 'Подтверждение для этой вырезки недоступно: она уже обработана иначе либо её чек удалён. Показываем актуальное состояние.'
    case 'review_busy': return 'Данные сейчас изменяются другой операцией, чек не сохранён. Проверьте задание и повторите подтверждение позже.'
    case 'job_active': return 'Задание ещё не завершено, чек не сохранён. Подтверждение станет доступно после окончания обработки.'
    case 'not_found': return 'Вырезка не найдена: возможно, она была удалена. Показываем актуальное состояние.'
    case 'network': case 'timeout': return 'Ответ сервера не получен. Действие могло выполниться: проверьте задание перед повтором.'
    case 'storage_unavailable': case 'database_unavailable': case 'server': case 'invalid_response':
      return 'Сервис ответил ошибкой. Действие могло выполниться: проверьте задание перед повтором.'
    default: return errorText(error, true)
  }
}
/** Refusals that say nothing new about the saved state: the form stays as it is, without another read. */
export function reviewKeepsState(error: LocalApiFailure): boolean {
  return ['review_invalid', 'invalid_parameter', 'invalid_request', 'csrf_failed', 'permission_denied'].includes(error.reason)
}
