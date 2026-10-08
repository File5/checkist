import type { AuthFailure, PasswordIssue } from '../../api/session'

/** What a form shows after a refusal. Local translations only: a server message never reaches the screen. */
export type Refusal = { message: string; fields?: string[]; details?: string[] }

export const sessionExpiredText = 'Сеанс завершён. Войдите снова.'
export const moderatorOnlyText = 'Раздел доступен модератору каталога'
export const passwordChangedText = 'Пароль изменён. Вход на других устройствах завершён.'

/** The rules of the server's validators, in the order of `AUTH_PASSWORD_VALIDATORS`. */
export const passwordRules: Record<PasswordIssue, string> = {
  too_similar: 'не должен быть похож на имя пользователя',
  too_short: 'не короче 8 символов',
  too_common: 'не должен быть распространённым паролем',
  entirely_numeric: 'не должен состоять только из цифр',
}
const ruleOrder = Object.keys(passwordRules) as PasswordIssue[]

function plural(count: number, one: string, few: string, many: string): string {
  const tens = count % 100
  const units = count % 10
  if (tens >= 11 && tens <= 14) return many
  return units === 1 ? one : units >= 2 && units <= 4 ? few : many
}

/** Seconds of the server's delay as whole minutes, rounded up: «через 15 минут». */
export function waitText(retryAfter: number | undefined): string {
  if (retryAfter === undefined) return 'Повторите позже.'
  const minutes = Math.max(1, Math.ceil(retryAfter / 60))
  return `Повторите через ${minutes.toLocaleString('ru-RU')} ${plural(minutes, 'минуту', 'минуты', 'минут')}.`
}

function commonText(failure: AuthFailure): string {
  switch (failure.reason) {
    case 'server': return 'Сервис временно недоступен. Повторите позже.'
    case 'invalid_response': return 'Ответ сервера не соответствует ожидаемому формату. Повторите позже.'
    case 'not_found': return 'Вход по паролю на этом сервере не используется. Обновите страницу.'
    default: return 'Запрос не выполнен. Повторите позже.'
  }
}

export function loginRefusal(failure: AuthFailure): Refusal {
  switch (failure.reason) {
    // One text for an unknown name, a wrong password and a switched off account.
    case 'invalid_credentials': return { message: 'Неверное имя пользователя или пароль.' }
    case 'login_throttled': return { message: `Слишком много попыток входа. ${waitText(failure.retryAfter)}` }
    case 'invalid_parameter': case 'invalid_request': return { message: 'Запрос отклонён: проверьте имя пользователя и пароль.' }
    case 'csrf_failed': return { message: 'Токен безопасности устарел. Вход не выполнен: нажмите «Войти» ещё раз.' }
    case 'network': case 'timeout': return { message: 'Нет ответа сервера. Проверьте соединение и повторите вход.' }
    default: return { message: commonText(failure) }
  }
}

export function logoutRefusal(failure: AuthFailure): Refusal {
  switch (failure.reason) {
    case 'csrf_failed': return { message: 'Токен безопасности устарел. Выход не выполнен: нажмите «Выйти» ещё раз.' }
    case 'network': case 'timeout': return { message: 'Ответ сервера не получен. Выход мог выполниться: обновите страницу и проверьте.' }
    default: return { message: commonText(failure) }
  }
}

export function passwordRefusal(failure: AuthFailure): Refusal {
  switch (failure.reason) {
    case 'invalid_parameter': {
      const fields = (failure.fields ?? []).filter((field) => field === 'current_password' || field === 'new_password')
      if (fields.includes('new_password')) {
        // Without the server's codes all four rules are listed: the cause is one of them.
        const issues = failure.passwordIssues?.length ? ruleOrder.filter((issue) => failure.passwordIssues!.includes(issue)) : ruleOrder
        return {
          message: fields.includes('current_password') ? 'Текущий пароль неверный, новый пароль не подходит. Новый пароль:' : 'Новый пароль не подходит. Пароль:',
          fields, details: issues.map((issue) => passwordRules[issue]),
        }
      }
      if (fields.includes('current_password')) return { message: 'Текущий пароль неверный.', fields }
      return { message: 'Запрос отклонён: проверьте оба пароля.' }
    }
    case 'invalid_request': return { message: 'Запрос отклонён: проверьте оба пароля.' }
    case 'login_throttled': return { message: `Слишком много попыток с неверным паролем. ${waitText(failure.retryAfter)}` }
    case 'csrf_failed': return { message: 'Токен безопасности устарел. Пароль не изменён: нажмите «Сменить пароль» ещё раз.' }
    case 'network': case 'timeout': return { message: 'Ответ сервера не получен. Пароль мог измениться: если прежний пароль не подойдёт, войдите с новым.' }
    default: return { message: commonText(failure) }
  }
}
