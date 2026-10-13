/** This browser and Push API: whether it can receive, and the subscription of this device.
 *
 * The service worker (`public/sw.js`) is registered only in a production build, so the dev server never subscribes.
 * On iPhone (iOS 16.4+) push reaches only an app opened from the home screen: in Safari it is `install`.
 */
import type { PushSubscriptionBody } from '../../api/push'

/** `ready` — can subscribe; `install` — iPhone/iPad in Safari, add to the home screen first; `unsupported` — no Push API. */
export type PushSupport = 'ready' | 'install' | 'unsupported'
export type DeviceInfo = {
  userAgent: string; platform?: string; maxTouchPoints?: number
  standalone: boolean; serviceWorker: boolean; pushManager: boolean; notification: boolean
}

export function pushSupport(device: DeviceInfo): PushSupport {
  const ios = /iPad|iPhone|iPod/.test(device.userAgent) || (device.platform === 'MacIntel' && (device.maxTouchPoints ?? 0) > 1)
  if (ios && !device.standalone) return 'install'
  return device.serviceWorker && device.pushManager && device.notification ? 'ready' : 'unsupported'
}

export function readDevice(): DeviceInfo {
  const nav = navigator as Navigator & { standalone?: boolean }
  return {
    userAgent: nav.userAgent, platform: nav.platform, maxTouchPoints: nav.maxTouchPoints,
    standalone: nav.standalone === true || window.matchMedia?.('(display-mode: standalone)').matches === true,
    serviceWorker: 'serviceWorker' in nav, pushManager: 'PushManager' in window, notification: 'Notification' in window,
  }
}

/** The VAPID public key (base64url) as Push API wants it. */
export function serverKey(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = base64url.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(base64url.length / 4) * 4, '=')
  return Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))
}

function sameKey(buffer: ArrayBuffer | null, key: Uint8Array): boolean {
  const bytes = buffer ? new Uint8Array(buffer) : null
  return bytes !== null && bytes.length === key.length && bytes.every((byte, index) => byte === key[index])
}

/** Why this device was not subscribed: the person refused, or the app has no service worker (not installed yet). */
export class DeviceRefusal extends Error {
  constructor(readonly reason: 'denied' | 'no-worker') { super(reason) }
}

const registration = () => navigator.serviceWorker.getRegistration('/')

/** The subscription of this device, if any. */
export async function deviceSubscription(): Promise<PushSubscription | null> {
  const found = await registration()
  return found ? found.pushManager.getSubscription() : null
}

/** Asks the permission (the first call inside the tap: Safari wants the gesture) and subscribes with the server key;
 * a subscription made with another key (the server's keys were replaced) is renewed. */
export async function subscribeDevice(publicKey: string): Promise<PushSubscriptionBody> {
  const permission = await Notification.requestPermission()
  if (permission !== 'granted') throw new DeviceRefusal('denied')
  const found = await registration()
  if (!found) throw new DeviceRefusal('no-worker')
  const key = serverKey(publicKey)
  let subscription = await found.pushManager.getSubscription()
  if (subscription && !sameKey(subscription.options.applicationServerKey, key)) {
    await subscription.unsubscribe()
    subscription = null
  }
  subscription ??= await found.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key })
  return subscription.toJSON() as PushSubscriptionBody
}

/** Stops this device; the endpoint it had, or `null` — it was not subscribed. */
export async function unsubscribeDevice(): Promise<string | null> {
  const subscription = await deviceSubscription()
  if (!subscription) return null
  await subscription.unsubscribe()
  return subscription.endpoint
}
