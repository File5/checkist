import { getLocalJson, mutate } from './local.ts'
import { amount, bool, currency, nonNegativeInteger, nullable, object, text } from './schema.ts'
import type { Guard } from './schema.ts'
import type { CurrencyCode, Decimal, LocalApiResult, RequestOptions } from './types.ts'

/** The five reasons of a notification; each person switches them for themself. */
export const pushKinds = ['recurring', 'limits', 'weekly', 'monthly', 'large'] as const
export type PushKind = typeof pushKinds[number]
export type PushSettings = Record<PushKind, boolean> & {
  /** «Крупная трата другого члена семьи» from this amount, in the family's base currency. */
  large_threshold: Decimal
}
/** `GET /api/push/`: whether the server has VAPID keys (`configured`), the key a browser subscribes with, how many devices
 * of this person are subscribed, and their switches. */
export type PushState = {
  configured: boolean; public_key: string | null; devices: number; base_currency: CurrencyCode; settings: PushSettings
}
/** The subscription of a browser as `PushSubscription.toJSON()` gives it. */
export type PushSubscriptionBody = { endpoint: string; keys: { p256dh: string; auth: string }; expirationTime?: number | null }

const isSettings = object<PushSettings>({
  recurring: bool, limits: bool, weekly: bool, monthly: bool, large: bool, large_threshold: amount,
})
export const isPushState: Guard<PushState> = object<PushState>({
  configured: bool, public_key: nullable(text), devices: nonNegativeInteger, base_currency: currency, settings: isSettings,
})
const isTestAnswer: Guard<PushState & { sent: number }> = (value): value is PushState & { sent: number } =>
  isPushState(value) && nonNegativeInteger((value as Record<string, unknown>).sent)

const send = <T>(path: string, body: unknown, guard: Guard<T>, options: RequestOptions, method: 'POST' | 'PATCH' = 'POST') =>
  mutate(path, body === undefined ? '' : JSON.stringify(body), guard, options, false, undefined, { method })

export function getPush(options: RequestOptions = {}): Promise<LocalApiResult<PushState>> {
  return getLocalJson('push/', {}, isPushState, options)
}
/** Switches and the threshold; the answer is the whole state. */
export function savePush(input: Partial<PushSettings>, options: RequestOptions = {}): Promise<LocalApiResult<PushState>> {
  return send('push/', input, isPushState, options, 'PATCH')
}
/** This device starts receiving; `409 push_not_configured` without keys on the server. */
export function subscribePush(subscription: PushSubscriptionBody, options: RequestOptions = {}): Promise<LocalApiResult<PushState>> {
  return send('push/subscribe/', subscription, isPushState, options)
}
export function unsubscribePush(endpoint: string, options: RequestOptions = {}): Promise<LocalApiResult<PushState>> {
  return send('push/unsubscribe/', { endpoint }, isPushState, options)
}
/** A test notification to every device of the person at once; `sent` — how many push services took it. */
export function testPush(options: RequestOptions = {}): Promise<LocalApiResult<PushState & { sent: number }>> {
  return send('push/test/', undefined, isTestAnswer, options)
}
