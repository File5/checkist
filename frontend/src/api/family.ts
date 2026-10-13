import { mutate } from './local.ts'
import { getLocalJson } from './recognition.ts'
import { array, bool, choice, isId, isISODateTime, nullable, object, text } from './schema.ts'
import type { Guard } from './schema.ts'
import type { LocalApiResult, RequestOptions } from './types.ts'

/** «Семья» (`/api/family/`, only with accounts). `is_me` — the person of the request. */
export type FamilyMember = { username: string; display_name: string; role: 'head' | 'member'; is_me: boolean }
export type FamilyInvite = { id: number; created_at: string; expires_at: string }
/** ИИ of the family: photos and texts go to an external model; the head switches it, the server owner sets the limit.
 * `daily_limit: null` — no limit (families from before the invites of new families): requests are counted, never refused. */
export type FamilyAi = { enabled: boolean; daily_limit: number | null; used_today: number; resets_at: string }
export type Family = {
  household: { id: number; name: string; members: FamilyMember[] } | null
  /** The family head; a user without a family heads their own data. */
  is_head: boolean
  /** Active invites; only the head gets them, without tokens. */
  invites: FamilyInvite[]
  /** `null` without a family (nothing is counted then). Missing from an older server. */
  ai?: FamilyAi | null
  /** The server owner (`is_staff`) invites new families. Missing from an older server. */
  can_invite_families?: boolean
  /** Active invites of new families; only the server owner gets them, without tokens. */
  family_invites?: FamilyInvite[]
}
/** `POST members/`: the password is shown once and never again. */
export type NewMember = { member: FamilyMember; password: string }
/** `POST invites/`: the token travels only in this answer; `path` — the address to share. */
export type NewInvite = FamilyInvite & { token: string; path: string }

const isMember = object<FamilyMember>({ username: text, display_name: text, role: choice('head', 'member'), is_me: bool })
const isInvite = object<FamilyInvite>({ id: isId, created_at: isISODateTime, expires_at: isISODateTime })
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0
const isAi = object<FamilyAi>({ enabled: bool, daily_limit: nullable(count), used_today: count, resets_at: isISODateTime })
/** A field an older server leaves out: missing passes, anything else must pass `check`. */
const optional = (value: unknown, key: string, check: (item: unknown) => boolean) => !Object.hasOwn(value as object, key)
  || check((value as Record<string, unknown>)[key])
const isFamilyShape = object<Omit<Family, 'ai' | 'can_invite_families' | 'family_invites'>>({
  household: nullable(object<NonNullable<Family['household']>>({ id: isId, name: text, members: array(isMember) })),
  is_head: bool,
  invites: array(isInvite),
})
export const isFamily: Guard<Family> = (value): value is Family => isFamilyShape(value)
  && optional(value, 'ai', nullable(isAi)) && optional(value, 'can_invite_families', bool)
  && optional(value, 'family_invites', array(isInvite))
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
/** The head switches ИИ of the family; the answer is the family. */
export function setFamilyAi(enabled: boolean, options: RequestOptions = {}) { return send('family/ai/', { enabled }, isFamily, options, 'PATCH') }
/** The server owner: an invite of a new family; `path` — `/family/new?token=…`, the token travels only in this answer. */
export function createFamilyInvite(options: RequestOptions = {}): Promise<LocalApiResult<NewInvite>> {
  return send('family/new-invites/', undefined, isNewInvite, options)
}
export function revokeFamilyInvite(id: number, options: RequestOptions = {}) {
  return send(`family/new-invites/${id}/`, undefined, isEmpty, options, 'DELETE')
}
