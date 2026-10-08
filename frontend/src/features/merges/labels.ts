import type { MergeConflictField, MergeDetectResult, MergeMemberBrief, MergeStatus } from '../../api/product-merges'
import type { LocalApiFailure } from '../../api/types'
import { formatQuantity } from '../../lib/format'
import { dateRange, glue } from '../../lib/text'
import { getSession, permissionDeniedText } from '../../session'

export const statusLabels: Record<MergeStatus, string> = {
  pending: 'Ожидает подтверждения', confirmed: 'Подтверждено', cancelled: 'Отменено',
}
export const fieldLabels: Record<MergeConflictField, string> = {
  generic: 'Обобщённый продукт', brand: 'Бренд', package: 'Фасовка', gtin: 'GTIN', model: 'Модель', attributes: 'Атрибуты',
}
const missing = 'Не указано'

export function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100
  const units = count % 10
  if (tens >= 11 && tens <= 14) return many
  return units === 1 ? one : units >= 2 && units <= 4 ? few : many
}
export function counted(count: number, one: string, few: string, many: string): string {
  return `${count.toLocaleString('ru-RU')} ${plural(count, one, few, many)}`
}
/** «18 покупок» with the number glued to its word: the screens of duplicates and of categories say counts this way. */
export function countedWhole(count: number, one: string, few: string, many: string): string {
  return glue(count.toLocaleString('ru-RU'), plural(count, one, few, many))
}
/** What the shared period helper puts between its two dates: each date goes into its own `<time>`, only the joint is text. */
export const periodJoint = dateRange('', '')
export const memberName = (member: Pick<MergeMemberBrief, 'name'>) => member.name.trim() || missing

/** Value of a disputed fact as the record holds it. A record carries no `attributes`. */
export function factValue(member: MergeMemberBrief, field: MergeConflictField): string {
  switch (field) {
    case 'generic': return member.classified ? member.generic.name.trim() || missing : 'Не разобрано'
    case 'brand': return member.brand?.name.trim() || missing
    case 'package': return member.package ? formatQuantity(member.package.quantity, member.package.unit) : missing
    case 'gtin': return member.gtin.trim() || missing
    case 'model': return member.model.trim() || missing
    case 'attributes': return 'атрибуты этой записи'
  }
}

/** Empty facts are left out of a record's cell; the generic product is always shown. */
export function hasFact(member: MergeMemberBrief, field: 'brand' | 'package' | 'gtin' | 'model'): boolean {
  return field === 'brand' ? Boolean(member.brand?.name.trim()) : field === 'package' ? member.package !== null : Boolean(member[field].trim())
}

export function detectText(result: MergeDetectResult): string {
  if (result.created === 0 && result.extended === 0) return 'Новых дублей не найдено.'
  return [
    result.created > 0 && `Создано групп: ${result.created.toLocaleString('ru-RU')}`,
    result.extended > 0 && `дополнено групп: ${result.extended.toLocaleString('ru-RU')}`,
  ].filter(Boolean).join(', ').replace(/^д/, 'Д') + '.'
}

/** Local translations only: a server message never reaches the screen. The text of a refused access depends on the session. */
export function errorText(error: LocalApiFailure, mutation = false): string {
  switch (error.reason) {
    case 'permission_denied': return permissionDeniedText(getSession())
    case 'csrf_failed': return 'Токен безопасности устарел. Обновите токен и повторите действие.'
    case 'not_found': return 'Группа не найдена. Возможно, ссылка устарела.'
    case 'page_out_of_range': return 'Такой страницы больше нет. Откройте первую страницу.'
    case 'merge_conflict': return error.fields?.includes('name')
      ? 'Подтверждение не выполнено: после слияния товар совпал бы с другим товаром каталога по названию, бренду и фасовке. Выберите другое название или другую оставляемую запись.'
      : error.fields?.includes('gtin')
        ? 'Подтверждение не выполнено: GTIN совпадает с другим товаром каталога. Выберите другое значение или другую оставляемую запись.'
        : 'У записей разные значения. Выберите значение для отмеченных полей и подтвердите слияние снова.'
    case 'merge_changed': return 'Состав группы изменился. Данные обновлены, выбор сброшен: проверьте группу и повторите действие.'
    case 'merge_resolved': return 'Слияние уже завершено. Показано актуальное состояние группы.'
    case 'merge_busy': return 'Каталог сейчас изменяется: идёт импорт чека или другое слияние. Ничего не сохранено, повторите действие позже.'
    case 'invalid_parameter': case 'invalid_request': return mutation
      ? 'Выбор больше не соответствует группе. Данные обновлены: проверьте записи и повторите действие.'
      : 'Запрос отклонён: проверьте параметры страницы.'
    case 'network': case 'timeout': return mutation
      ? 'Ответ сервера не получен. Действие могло выполниться: проверьте состояние группы перед повтором.'
      : 'Нет ответа сервера. Проверьте соединение и повторите запрос.'
    case 'database_unavailable': case 'server': return mutation
      ? 'Сервис временно недоступен. Действие могло выполниться: проверьте состояние группы перед повтором.'
      : 'Сервис временно недоступен. Повторите запрос позже.'
    case 'invalid_response': return 'Ответ сервера не соответствует ожидаемому формату. Повторите запрос позже.'
    default: return 'Запрос не выполнен. Повторите действие позже.'
  }
}
