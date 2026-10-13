/** The page side of `public/sw.js`: registration, the reload after a deploy, and forgetting the cached API answers.
 *
 * Update rule (simplest robust one, no «обновить» bar):
 *  - a deploy changes index.html; the service worker fetches navigations from the network first, so the next online
 *    open shows the new version;
 *  - an app kept in memory (iPhone resumes it without loading) compares, on start and whenever it becomes visible, the
 *    entry script of the server's index.html with its own and reloads itself once when they differ — not on the forms
 *    `/receipts/new`, `/receipts/{id}/edit`, `/receipts/upload`, where it waits for the next return;
 *  - a new `sw.js` takes over at once (`skipWaiting` + `clients.claim`); the page that was already controlled reloads once.
 */
import { forgetAnswers } from '../api/answer-cache.ts'

export const CLEAR_MESSAGE = 'checkist:clear-api'
export const API_CACHE = 'checkist-api-v1'
const RELOAD_KEY = 'checkist.reloadedAt'
const RELOAD_PAUSE_MS = 60_000

/** The entry script of a page: `/assets/index-<hash>.js`; `undefined` — not a built page (dev server). */
export function entryScript(html: string): string | undefined {
  const match = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["'](\/assets\/[^"']+\.js)["']/.exec(html)
    ?? /<script\b[^>]*\bsrc=["'](\/assets\/[^"']+\.js)["'][^>]*\btype=["']module["']/.exec(html)
  return match?.[1]
}

/** Is the server's page another build than the running one? Unknown either side — no. */
export function isNewBuild(running: string | undefined, serverHtml: string): boolean {
  const fresh = entryScript(serverHtml)
  return running !== undefined && fresh !== undefined && fresh !== running
}

/** Forms whose typed text a reload would lose. */
export function reloadWaits(pathname: string): boolean {
  return pathname === '/receipts/new' || pathname === '/receipts/upload' || /^\/receipts\/[0-9]+\/edit\/?$/.test(pathname)
}

/** At most one automatic reload a minute: a page served from the cache twice in a row never loops. */
function reloadOnce(): void {
  try {
    const last = Number(sessionStorage.getItem(RELOAD_KEY) ?? 0)
    if (Date.now() - last < RELOAD_PAUSE_MS) return
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()))
  } catch {
    // Without sessionStorage the pause is not kept; the reload still happens once per call.
  }
  location.reload()
}

function runningEntry(): string | undefined {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src*="/assets/"]')
  return script ? new URL(script.src, location.href).pathname : undefined
}

async function checkBuild(): Promise<void> {
  if (navigator.onLine === false || reloadWaits(location.pathname)) return
  const running = runningEntry()
  if (!running) return
  try {
    // Not a navigation: the service worker passes it to the network untouched.
    const response = await fetch('/', { cache: 'no-store', credentials: 'same-origin', headers: { Accept: 'text/html' } })
    if (!response.ok) return
    if (isNewBuild(running, await response.text())) reloadOnce()
  } catch {
    // No network: the running version is the one on the phone.
  }
}

/** Only in a production build and where the browser has service workers. */
export function registerServiceWorker(): void {
  if (!('serviceWorker' in navigator)) return
  const controlled = Boolean(navigator.serviceWorker.controller)
  navigator.serviceWorker.addEventListener('controllerchange', () => { if (controlled && !reloadWaits(location.pathname)) reloadOnce() })
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch(() => undefined)
    void checkBuild()
  })
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return
    void navigator.serviceWorker.getRegistration().then((registration) => registration?.update()).catch(() => undefined)
    void checkBuild()
  })
}

/** Sign-in, sign-out, another person: the API answers kept on the phone, and in the memory of this page
 * (`api/answer-cache.ts`), belong to nobody now. */
export function forgetCachedAnswers(): void {
  forgetAnswers()
  try {
    if (typeof caches !== 'undefined') void caches.delete(API_CACHE).catch(() => undefined)
    if (typeof navigator !== 'undefined' && 'serviceWorker' in navigator) {
      navigator.serviceWorker.controller?.postMessage({ type: CLEAR_MESSAGE })
    }
  } catch {
    // No cache storage here: nothing was kept.
  }
}
