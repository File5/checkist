import type { FamilyAi, FamilyMember } from '../../api/family'
import type { AuthFailure } from '../../api/session'
import type { LocalApiResult } from '../../api/types'
import { glue } from '../../lib/text'
import type { Refusal } from '../auth/labels'
import { passwordRules, waitText } from '../auth/labels'

export type FamilyAction = 'create' | 'rename' | 'add' | 'remove' | 'head' | 'leave' | 'invite' | 'revoke' | 'join'
  | 'ai' | 'family-invite' | 'family-revoke'

export const familyTexts = {
  noFamily: 'Вы пока не в семье. Создайте семью — вы станете её главным и сможете добавить людей.',
  headOnly: 'Это может только главный в семье.',
  headMustTransfer: 'Сначала передайте роль главного другому члену семьи.',
  alreadyInFamily: 'Вы уже в семье. Чтобы перейти в другую, сначала выйдите из этой.',
  inviteInvalid: 'Приглашение недействительно: неверное, просрочено или уже принято.',
  throttled: 'Слишком много попыток. Повторите позже.',
  failed: 'Не удалось. Попробуйте ещё раз.',
  passwordOnce: 'Пароль показан один раз: скопируйте и передайте его человеку. Потом его не увидит никто.',
  inviteOnce: 'Ссылка действует 7 дней и один раз. Человек входит под своей учётной записью и открывает её.',
  staffOnly: 'Это может только администратор сервера.',
  familyInviteOnce: 'Ссылка действует 7 дней и один раз. По ней человек заведёт учётную запись и свою семью — и станет в ней главным.',
  familyInvites: 'Для человека без учётной записи: он заведёт её и свою семью. Видит только администратор сервера.',
  aiNote: 'Фото чеков и тексты трат обрабатывает внешняя модель.',
  aiHeadOnly: 'Включить или выключить может главный.',
}

/** «Сегодня использовано 3 из 50»: the numbers glued to their words. */
export const aiUsageText = (ai: FamilyAi) => `Сегодня использовано ${glue(ai.used_today, 'из', ai.daily_limit)}`

/** The text of a refused family action; field errors are shown next to the fields. */
export function familyFailure(action: FamilyAction, result: LocalApiResult<unknown>): string | null {
  if (result.kind !== 'error') return null
  const { status, fields } = result
  if (status === 403) return action === 'family-invite' || action === 'family-revoke' ? familyTexts.staffOnly : familyTexts.headOnly
  if (status === 429) return familyTexts.throttled
  if (status === 409) return action === 'create' || action === 'join' ? familyTexts.alreadyInFamily : familyTexts.headMustTransfer
  if (status === 400 && action === 'join' && !fields?.length) return familyTexts.inviteInvalid
  if (status === 400 && fields?.length) return fieldsText(fields)
  return familyTexts.failed
}

const FIELD_NAMES: Record<string, string> = { name: 'название', username: 'логин', first_name: 'имя', password: 'пароль' }

export function fieldsText(fields: string[]): string {
  return `Проверьте: ${fields.map((field) => FIELD_NAMES[field] ?? field).join(', ')}.`
}

export const roleText = (member: FamilyMember) => (member.role === 'head' ? 'главный' : 'член семьи')

/** «Лиза (liza) · главный»: the name to show, the username when it differs, the role. */
export function memberLine(member: FamilyMember): string {
  const name = member.display_name === member.username ? member.username : `${member.display_name} (${member.username})`
  return `${name} · ${roleText(member)}${member.is_me ? ' · это вы' : ''}`
}

/** The line under the name of a member: the login when it differs from the name, then «это вы» or «член семьи».
 * The head carries the mark «Главный» of its own, so the line does not repeat it. */
export function memberMeta(member: FamilyMember): string {
  const parts = [
    ...(member.display_name === member.username ? [] : [member.username]),
    ...(member.is_me ? ['это вы'] : member.role === 'member' ? ['член семьи'] : []),
  ]
  return parts.join(' · ')
}

/** The absolute invite address from the path of the server answer. */
export function inviteUrl(path: string, origin: string): string {
  return new URL(path, origin).toString()
}

/** «Новая семья» by an invite (`/family/new?token=…`): what the guest types. */
export type NewFamilyValues = { name: string; first_name: string; username: string; password: string }

export const newFamilyTexts = {
  noToken: 'Ссылка неполная. Откройте её из сообщения целиком или попросите новую.',
  invalid: 'Приглашение недействительно: ссылка неверная, просрочена или уже использована. Попросите новую.',
  signedIn: 'Ссылка создаёт новую учётную запись и семью. Чтобы создать их, выйдите — ссылка останется действительной.',
  checkFailed: 'Не удалось проверить приглашение. Проверьте соединение и повторите.',
  required: 'Заполните название семьи, логин и пароль.',
  usernameRule: 'латинские буквы, цифры и @ . + - _; логин может быть уже занят',
}

const NEW_FAMILY_FIELDS: Record<string, string> = { name: 'название семьи', username: 'логин', first_name: 'имя', password: 'пароль' }
const passwordOrder = Object.keys(passwordRules) as (keyof typeof passwordRules)[]

/** Refuses an empty required field before any request. The name is trimmed by the server. */
export function checkNewFamily(values: NewFamilyValues): Refusal | undefined {
  const fields = (['name', 'username', 'password'] as const).filter((field) => !values[field].trim())
  if (fields.length) return { message: newFamilyTexts.required, fields: [...fields] }
}

/** A refused `POST /api/auth/new-family/`: the text and the fields to mark; the server's own words never reach the screen. */
export function newFamilyRefusal(failure: AuthFailure): Refusal {
  switch (failure.reason) {
    case 'invite_invalid': return { message: newFamilyTexts.invalid }
    case 'already_signed_in': return { message: newFamilyTexts.signedIn }
    case 'invalid_parameter': {
      const fields = (failure.fields ?? []).filter((field) => field in NEW_FAMILY_FIELDS)
      if (!fields.length) return { message: 'Запрос отклонён: проверьте поля формы.' }
      const named = `Проверьте: ${fields.map((field) => NEW_FAMILY_FIELDS[field]).join(', ')}.`
      const details = [
        ...(fields.includes('username') ? [`Логин: ${newFamilyTexts.usernameRule}.`] : []),
        ...(fields.includes('password')
          ? (failure.passwordIssues?.length ? passwordOrder.filter((issue) => failure.passwordIssues!.includes(issue)) : passwordOrder)
            .map((issue) => `Пароль: ${passwordRules[issue]}.`)
          : []),
      ]
      return { message: named, fields, details }
    }
    case 'login_throttled': return { message: `Слишком много попыток. ${waitText(failure.retryAfter)}` }
    case 'csrf_failed': return { message: 'Токен безопасности устарел. Нажмите «Создать семью» ещё раз.' }
    case 'network': case 'timeout': return { message: 'Ответ сервера не получен. Если семья создалась, войдите с новым логином и паролем.' }
    default: return { message: 'Запрос не выполнен. Повторите позже.' }
  }
}
