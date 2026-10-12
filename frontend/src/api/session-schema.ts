import { array, bool, choice, isId, nullable, object, text } from './schema.ts'
import type { Check, Guard } from './schema.ts'
import type { AuthCsrf, Household, Me, PasswordIssue } from './session.ts'
import { isPerson } from '../lib/people.ts'

/** Django's token is 64 letters and digits. Never render or store this value outside the adapters. */
const csrfToken: Check = (value) => typeof value === 'string' && /^[A-Za-z0-9_]{1,128}$/.test(value)
/** Django limits a username to 150 characters; it is shown as text, never as markup. */
const username: Check = (value) => typeof value === 'string' && value.length > 0 && value.length <= 150

export const isAuthCsrf = object<AuthCsrf>({ csrf_token: csrfToken })
/** A field an older server leaves out: missing passes, anything else must pass `check`. */
const optional = (value: unknown, key: string, check: Check) => !Object.hasOwn(value as object, key) || check((value as Record<string, unknown>)[key])
const isUser = object<Omit<Me['user'], 'display_name'>>({ id: isId, username, is_staff: bool })
const isHousehold = object<Omit<Household, 'people'>>({ id: isId, name: text, members: array(username) })
const isMeShape = object<Me>({
  mode: choice('accounts', 'local_single'),
  user: (value) => isUser(value) && optional(value, 'display_name', text),
  household: nullable((value) => isHousehold(value) && optional(value, 'people', array(isPerson))),
  permissions: object<Me['permissions']>({ moderate_catalog: bool }),
  csrf_token: csrfToken,
})
export const isMe: Guard<Me> = (value): value is Me => isMeShape(value)

export const PASSWORD_ISSUES = ['too_short', 'too_common', 'entirely_numeric', 'too_similar'] as const
/** Codes travel next to `error`; every code is known and none repeats. */
export const isPasswordIssues: Guard<PasswordIssue[]> = (value): value is PasswordIssue[] => Array.isArray(value)
  && value.every((code: unknown) => (PASSWORD_ISSUES as readonly unknown[]).includes(code))
  && new Set(value).size === value.length
/** Seconds until the next sign-in attempt; the server never answers zero. */
export const isRetryAfter: Guard<number> = (value): value is number => Number.isSafeInteger(value) && (value as number) > 0
