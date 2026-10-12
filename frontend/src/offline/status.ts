/** Is the network there, and did the last API answer come from the phone? No React and no imports: `http.ts` depends on it.
 * `served` — the service worker answered from its cache (`X-Checkist-Offline: 1`); a fresh answer clears it.
 */
export type OfflineStatus = { online: boolean; served: boolean }

export const OFFLINE_HEADER = 'X-Checkist-Offline'

const browserOnline = () => typeof navigator === 'undefined' || navigator.onLine !== false
let status: OfflineStatus = { online: browserOnline(), served: false }
const listeners = new Set<() => void>()
let watching = false

function set(next: OfflineStatus): void {
  if (next.online === status.online && next.served === status.served) return
  status = next
  for (const listener of [...listeners]) listener()
}

function watch(): void {
  if (watching || typeof window === 'undefined') return
  watching = true
  window.addEventListener('online', () => set({ ...status, online: true }))
  window.addEventListener('offline', () => set({ ...status, online: false }))
}

export function getOfflineStatus(): OfflineStatus {
  return status
}
export function subscribeOfflineStatus(listener: () => void): () => void {
  watch()
  if (status.online !== browserOnline()) set({ ...status, online: browserOnline() })
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Every answer of the API reports whether it came from the cache of the service worker. */
export function reportApiAnswer(fromCache: boolean): void {
  set({ ...status, served: fromCache })
}

/** What the banner says; `undefined` — nothing to say. */
export function offlineMessage(current: OfflineStatus): { title: string; detail: string } | undefined {
  if (current.online && !current.served) return undefined
  return {
    title: current.online ? 'Сервер недоступен' : 'Нет сети',
    detail: `${current.served ? 'Показаны сохранённые данные. ' : ''}Траты сохраним на телефоне и отправим позже; фото можно отправить только при сети.`,
  }
}

/** Back to the state of a fresh page. For tests only. */
export function resetOfflineStatus(next: Partial<OfflineStatus> = {}): void {
  status = { online: true, served: false, ...next }
}
