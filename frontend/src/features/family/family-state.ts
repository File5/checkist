import type { FamilyMember } from '../../api/family'
import type { LocalApiResult } from '../../api/types'

export type FamilyAction = 'create' | 'rename' | 'add' | 'remove' | 'head' | 'leave' | 'invite' | 'revoke' | 'join'

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
}

/** The text of a refused family action; field errors are shown next to the fields. */
export function familyFailure(action: FamilyAction, result: LocalApiResult<unknown>): string | null {
  if (result.kind !== 'error') return null
  const { status, fields } = result
  if (status === 403) return familyTexts.headOnly
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
