import { mutate } from './local.ts'
import { getLocalJson } from './recognition.ts'
import { array, bool, choice, isId, isISODateTime, nullable, object, text } from './schema.ts'
import type { Guard } from './schema.ts'
import type { LocalApiResult, RequestOptions } from './types.ts'

/** «Семья» (`/api/family/`, only with accounts). `is_me` — the person of the request. */
export type FamilyMember = { username: string; display_name: string; role: 'head' | 'member'; is_me: boolean }
export type FamilyInvite = { id: number; created_at: string; expires_at: string }
export type Family = {
  household: { id: number; name: string; members: FamilyMember[] } | null
  /** The family head; a user without a family heads their own data. */
  is_head: boolean
  /** Active invites; only the head gets them, without tokens. */
  invites: FamilyInvite[]
}
/** `POST members/`: the password is shown once and never again. */
export type NewMember = { member: FamilyMember; password: string }
/** `POST invites/`: the token travels only in this answer; `path` — the address to share. */
export type NewInvite = FamilyInvite & { token: string; path: string }

const isMember = object<FamilyMember>({ username: text, display_name: text, role: choice('head', 'member'), is_me: bool })
const isInvite = object<FamilyInvite>({ id: isId, created_at: isISODateTime, expires_at: isISODateTime })
export const isFamily: Guard<Family> = object<Family>({
  household: nullable(object<NonNullable<Family['household']>>({ id: isId, name: text, members: array(isMember) })),
  is_head: bool,
  invites: array(isInvite),
})
const isNewMember = object<NewMember>({ member: isMember, password: text })
const isNewInvite: Guard<NewInvite> = (value): value is NewInvite => isInvite(value)
  && object<{ token: string; path: string }>({ token: text, path: text })(value)
const isEmpty = (value: unknown): value is null => value === null

const send = <T>(path: string, body: unknown, guard: Guard<T>, options: RequestOptions, method: 'POST' | 'PATCH' | 'DELETE' = 'POST') =>
  mutate(path, body === undefined ? '{}' : JSON.stringify(body), guard, options, false, undefined, { method })

export function getFamily(options: RequestOptions = {}): Promise<LocalApiResult<Family>> {
  return getLocalJson('family/', {}, isFamily, options)
}
export function createFamily(name: string, options: RequestOptions = {}) { return send('family/', { name }, isFamily, options) }
export function renameFamily(name: string, options: RequestOptions = {}) { return send('family/', { name }, isFamily, options, 'PATCH') }
/** An empty `password` — the server generates one. */
export function addMember(input: { username: string; first_name: string; password: string }, options: RequestOptions = {}): Promise<LocalApiResult<NewMember>> {
  return send('family/members/', input, isNewMember, options)
}
export function removeMember(username: string, options: RequestOptions = {}) {
  return send(`family/members/${encodeURIComponent(username)}/`, undefined, isEmpty, options, 'DELETE')
}
export function transferHead(username: string, options: RequestOptions = {}) { return send('family/head/', { username }, isFamily, options) }
export function leaveFamily(options: RequestOptions = {}) { return send('family/leave/', undefined, isFamily, options) }
export function createInvite(options: RequestOptions = {}): Promise<LocalApiResult<NewInvite>> { return send('family/invites/', undefined, isNewInvite, options) }
export function revokeInvite(id: number, options: RequestOptions = {}) { return send(`family/invites/${id}/`, undefined, isEmpty, options, 'DELETE') }
export function joinFamily(token: string, options: RequestOptions = {}) { return send('family/join/', { token }, isFamily, options) }
