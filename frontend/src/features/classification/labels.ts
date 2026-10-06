import type {
  Classification, ClassificationCategory, ClassificationProduct, ClassificationState, ClassificationStatus,
} from '../../api/product-classifications'
import type { BaseUnit, LocalApiFailure } from '../../api/types'
import { formatQuantity } from '../../lib/format'
import type { ClassificationQuery } from '../../navigation'
import { counted } from '../merges/labels'

export const missing = 'Не указано'
export const unitLabels: Record<BaseUnit, string> = { kg: 'кг', l: 'л', pcs: 'шт' }
export const named = (value: { name: string }) => value.name.trim() || missing
export const pathSeparator = ' → '

const statusLabels: Record<ClassificationStatus, string> = {
  pending: 'Ожидает подтверждения', confirmed: 'Подтверждено', rejected: 'Отклонено', superseded: 'Заменено',
}
const resolutionLabels: Record<string, string> = {
  'confirmed/confirmed': 'Подтверждено', 'confirmed/other': 'Выбран другой обобщённый продукт',
  'rejected/rejected': 'Отклонено', 'rejected/cancelled': 'Отменено командой',
  'superseded/changed': 'Заменено: обобщённый продукт изменён вручную', 'superseded/merged': 'Заменено: товар объединён с другим',
  'superseded/product_removed': 'Заменено: товар удалён',
}
/** State of a record in words: the way it was decided, not only the status. */
export function statusLabel(record: Pick<Classification, 'status' | 'resolution'>): string {
  return resolutionLabels[`${record.status}/${record.resolution}`] ?? statusLabels[record.status]
}

export const filters: { value: NonNullable<ClassificationQuery['status']> | ''; label: string }[] = [
  { value: '', label: 'Ожидают' }, { value: 'confirmed', label: 'Подтверждённые' }, { value: 'rejected', label: 'Отклонённые' },
  { value: 'superseded', label: 'Заменённые' }, { value: 'all', label: 'Все' },
]

export function categoryText(category: Pick<ClassificationCategory, 'path'> | { path: { name: string }[] } | null): string {
  return category && category.path.length ? category.path.map(named).join(pathSeparator) : 'Категория не указана'
}
export const productsCount = (count: number) => counted(count, 'товар', 'товара', 'товаров')
/** Brand and package of a product; empty facts are left out. */
export function productFacts(product: Pick<ClassificationProduct, 'brand' | 'package'>): string {
  return [
    product.brand?.name.trim() && `Бренд: ${product.brand.name.trim()}`,
    product.package && `Фасовка: ${formatQuantity(product.package.quantity, product.package.unit)}`,
  ].filter(Boolean).join(' · ')
}

/** Local texts of a failed run. The server message is never shown. */
const runErrors: Record<string, string> = {
  auth_required: 'требуется вход в сервис модели', network_unavailable: 'сеть сервиса модели недоступна',
  rate_limited: 'сервис модели временно ограничил запросы', provider_unavailable: 'сервис модели недоступен',
  configuration_error: 'настройки сервиса модели требуют проверки', invalid_input: 'запрос к модели не прошёл проверку',
  invalid_output: 'ответ модели не прошёл проверку', timeout: 'время ожидания ответа модели истекло',
  worker_lost: 'обработчик перестал отвечать', input_too_large: 'каталог слишком велик для одного запроса к модели',
}
const number = (value: number) => value.toLocaleString('ru-RU')

/** One line about the run to show and the worker. An unknown worker state adds nothing about the worker. */
export function runText({ run, executor }: Pick<ClassificationState, 'run' | 'executor'>): { text: string; warning: boolean } | undefined {
  if (!run) return undefined
  const { progress } = run
  switch (run.status) {
    case 'queued': switch (executor.state) {
      case 'absent': return { text: 'Запуск в очереди. Воркер распознавания не запущен: запуск начнётся, когда воркер запустят.', warning: true }
      case 'busy': return { text: 'Запуск в очереди. Воркер занят другим заданием.', warning: false }
      case 'idle': return { text: 'Запуск в очереди и начнётся в ближайшие секунды.', warning: false }
      default: return { text: 'Запуск в очереди.', warning: false }
    }
    case 'running': return { text: `Модель предлагает категории: обработано ${number(progress.processed)} из ${number(progress.requested)}.`, warning: false }
    case 'succeeded': return {
      text: `Запуск завершён: предложено ${number(progress.applied)}, не распознано ${number(progress.unknown)}, пропущено ${number(progress.skipped)}.`
        + (run.remaining > 0 ? ` Без предложения осталось ${number(run.remaining)}: запустите ещё раз.` : ''),
      warning: false,
    }
    case 'failed': {
      const cause = run.error && Object.hasOwn(runErrors, run.error.code) ? `: ${runErrors[run.error.code]}` : ''
      return { text: `Запуск завершился ошибкой${cause}. Уже предложенные категории сохранены.`, warning: true }
    }
    case 'cancelled': return { text: 'Запуск отменён.', warning: false }
  }
}

/** After these the server may have saved the action: the record is read again before any new attempt. */
export function uncertain(error: LocalApiFailure): boolean {
  return ['network', 'timeout', 'server', 'database_unavailable', 'invalid_response'].includes(error.reason)
}

export const apiOffText = 'Локальный API выключен или недоступен с этого адреса. Запустите сервер с ALLOW_LOCAL_RECOGNITION_API=1 и откройте приложение с этого компьютера.'

/** Local translations only: a server message never reaches the screen. `choose` — the refusal of «Выбрать другой». */
export function errorText(error: LocalApiFailure, context: 'read' | 'action' | 'choose' = 'read'): string {
  const mutation = context !== 'read'
  switch (error.reason) {
    case 'permission_denied': return apiOffText
    case 'csrf_failed': return 'Токен безопасности устарел. Повторите действие.'
    case 'classification_busy': return 'Каталог сейчас изменяется: идёт импорт чека, слияние дублей или другое действие. Ничего не сохранено.'
    case 'classification_changed': return 'Предложение изменилось. Данные обновлены: проверьте запись и повторите действие.'
    case 'classification_resolved': return 'Предложение уже решено. Показано актуальное состояние.'
    case 'not_found': return mutation ? 'Запись не найдена. Список обновлён.' : 'Запись не найдена. Возможно, ссылка устарела.'
    case 'page_out_of_range': return 'Такой страницы больше нет. Откройте первую страницу.'
    case 'invalid_parameter': case 'invalid_request': return context === 'choose'
      ? 'Этот обобщённый продукт больше недоступен. Выберите другой.'
      : mutation ? 'Запрос отклонён. Данные обновлены: проверьте запись и повторите действие.' : 'Запрос отклонён: проверьте параметры страницы.'
    case 'network': case 'timeout': case 'server': case 'database_unavailable': return mutation
      ? 'Ответ сервера не получен. Действие могло выполниться: проверьте состояние записи перед повтором.'
      : error.reason === 'network' || error.reason === 'timeout'
        ? 'Нет ответа сервера. Проверьте соединение и повторите запрос.' : 'Сервис временно недоступен. Повторите запрос позже.'
    case 'invalid_response': return mutation
      ? 'Ответ сервера не соответствует ожидаемому формату. Действие могло выполниться: проверьте состояние записи перед повтором.'
      : 'Ответ сервера не соответствует ожидаемому формату. Повторите запрос позже.'
    default: return 'Запрос не выполнен. Повторите действие позже.'
  }
}
