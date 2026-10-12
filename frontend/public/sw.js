/* Checkist service worker: the app opens without network, a deploy is picked up on the next online open.
 * Plain script, no build step: `public/` is copied into `dist/` as is. Its decisions are unit-tested by loading
 * this file with a fake `self` (src/offline/sw.test.ts); keep every global it uses a parameter of that test.
 *
 * Strategies (`route`):
 *  - navigation (HTML) — network first, the cached index.html after 3 s or on failure;
 *  - /assets/*         — cache first: hashed names never change;
 *  - /api/* GET        — network first (6 s), on failure the last 200 answer with `X-Checkist-Offline: 1`;
 *  - everything else   — not touched: POST/PATCH/DELETE, a GET with `X-Checkist-Fresh: 1`, /api/auth/*, any …/csrf/, /api/health*, /media/*, /admin, /static.
 *
 * Pre-cache: index.html, the files it names, and the fonts/images named inside those scripts and styles.
 * Versions: the shell cache is named after a hash of index.html (`checkist-shell-<hash>`). Every successful online
 * navigation re-reads index.html; a new hash pre-caches the assets it references and drops the older shell caches.
 * A deploy therefore needs no change of this file. `CACHE_SCHEMA` is bumped only when this file changes the layout
 * of its caches; `activate` deletes every `checkist-*` cache of another schema.
 */
const CACHE_SCHEMA = 'v1'
const SHELL_PREFIX = `checkist-shell-${CACHE_SCHEMA}-`
const API_CACHE = `checkist-api-${CACHE_SCHEMA}`
const SHELL_URL = '/index.html'
const NAVIGATION_TIMEOUT_MS = 3000
const API_TIMEOUT_MS = 6000
const OFFLINE_HEADER = 'X-Checkist-Offline'
const CLEAR_MESSAGE = 'checkist:clear-api'
const FRESH_HEADER = 'X-Checkist-Fresh'

/** Which strategy serves a request: 'navigation' | 'asset' | 'api' | 'bypass'. */
function route(request, origin) {
  let url
  try { url = new URL(request.url) } catch { return 'bypass' }
  if (url.origin !== origin) return 'bypass'
  const path = url.pathname
  const server = path.startsWith('/api/') || path === '/admin' || path.startsWith('/admin/')
    || path.startsWith('/media/') || path.startsWith('/static/') || path === '/robots.txt'
  if (request.method !== 'GET') return 'bypass'
  // A read that must not be answered from the phone (the duplicate check of a pending spend).
  if (request.headers && request.headers.get && request.headers.get(FRESH_HEADER) === '1') return 'bypass'
  if (request.mode === 'navigate') return server ? 'bypass' : 'navigation'
  if (path.startsWith('/assets/')) return 'asset'
  if (path.startsWith('/api/')) {
    // Tokens and sign-in must be fresh; a cached «healthy» would lie about the services.
    if (path.startsWith('/api/auth/') || path.endsWith('/csrf/') || path.startsWith('/api/health')) return 'bypass'
    return 'api'
  }
  return 'bypass'
}

/** `/assets/…` addresses referenced by index.html (scripts, styles, preloads). */
function assetUrls(html) {
  const found = new Set()
  for (const match of String(html).matchAll(/(?:src|href)\s*=\s*["'](\/assets\/[^"'?#]+)["']/g)) found.add(match[1])
  return [...found]
}

/** `/assets/…` files named inside a built script or style sheet: fonts, images, lazy chunks. */
function nestedAssetUrls(text) {
  return [...new Set(String(text).match(/\/assets\/[\w.-]+\.(?:js|css|woff2?|webp|png|jpe?g|svg)\b/g) || [])]
}

/** FNV-1a of the page: the version of the shell. Same page — same name. */
function shellVersion(html) {
  let hash = 0x811c9dc5
  const text = String(html)
  for (let index = 0; index < text.length; index++) {
    hash ^= text.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193) >>> 0
  }
  return hash.toString(16).padStart(8, '0')
}

function markOffline(response) {
  const headers = new Headers(response.headers)
  headers.set(OFFLINE_HEADER, '1')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

async function shellCaches() {
  return (await caches.keys()).filter((name) => name.startsWith(SHELL_PREFIX))
}

/** Store this index.html and its assets under its version, then drop older shells. A failed copy keeps the old one. */
async function refreshShell(response) {
  const html = await response.text()
  const name = SHELL_PREFIX + shellVersion(html)
  if (!(await caches.has(name))) {
    const cache = await caches.open(name)
    try {
      const direct = assetUrls(html)
      await cache.addAll(direct)
      // Fonts and images are named by the scripts and styles, not by the page: keep them too.
      const nested = new Set()
      for (const url of direct) {
        const copy = await cache.match(url)
        if (copy) for (const inner of nestedAssetUrls(await copy.text())) if (!direct.includes(inner)) nested.add(inner)
      }
      // A name found by mistake must not cost the whole shell: each of them is optional.
      await Promise.all([...nested].map((url) => cache.add(url).catch(() => undefined)))
      await cache.put(SHELL_URL, new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } }))
    } catch {
      await caches.delete(name)
      return
    }
  }
  for (const other of await shellCaches()) if (other !== name) await caches.delete(other)
}

async function cachedShell() {
  for (const name of await shellCaches()) {
    const cached = await (await caches.open(name)).match(SHELL_URL)
    if (cached) return cached
  }
  return undefined
}

/** The network answer, or `fallback()` once the network failed or took longer than `timeoutMs`.
 * Without a fallback the network is awaited to its end. */
function networkOr(network, fallback, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (response) => { if (!settled) { settled = true; resolve(response) } }
    const timer = setTimeout(() => {
      fallback().then((cached) => { if (cached) finish(cached) }, () => undefined)
    }, timeoutMs)
    network.then((response) => { clearTimeout(timer); finish(response) }, (error) => {
      clearTimeout(timer)
      if (settled) return
      fallback().then((cached) => {
        if (settled) return
        if (cached) finish(cached)
        else { settled = true; reject(error) }
      }, () => { if (!settled) { settled = true; reject(error) } })
    })
  })
}

function handleNavigation(event) {
  let copy
  const network = fetch(event.request).then((response) => {
    const type = response.headers.get('Content-Type') || ''
    if (response.ok && type.includes('text/html')) copy = response.clone()
    return response
  })
  event.waitUntil(network.then(() => copy && refreshShell(copy)).catch(() => undefined))
  return networkOr(network, cachedShell, NAVIGATION_TIMEOUT_MS)
}

async function handleAsset(event) {
  const cached = await caches.match(event.request, { ignoreVary: true })
  if (cached) return cached
  const response = await fetch(event.request)
  if (response.ok) {
    const [latest] = (await shellCaches()).slice(-1)
    if (latest) {
      const copy = response.clone()
      event.waitUntil((await caches.open(latest)).put(event.request, copy).catch(() => undefined))
    }
  }
  return response
}

async function clearApi() {
  await caches.delete(API_CACHE)
}

function handleApi(event) {
  const network = fetch(event.request).then((response) => {
    if (response.status === 200) {
      const copy = response.clone()
      event.waitUntil(caches.open(API_CACHE).then((cache) => cache.put(event.request, copy)).catch(() => undefined))
    } else if (response.status === 401) {
      // The session ended: nothing of the previous person stays on this phone.
      event.waitUntil(clearApi().catch(() => undefined))
    }
    return response
  })
  const fallback = async () => {
    const cache = await caches.open(API_CACHE)
    const cached = await cache.match(event.request, { ignoreVary: true })
    return cached ? markOffline(cached) : undefined
  }
  return networkOr(network, fallback, API_TIMEOUT_MS)
}

function onFetch(event) {
  const request = event.request
  const path = (() => { try { return new URL(request.url).pathname } catch { return '' } })()
  // Sign-in and sign-out: the cached answers belong to the previous session whatever the result.
  if (request.method === 'POST' && (path === '/api/auth/logout/' || path === '/api/auth/login/')) {
    event.waitUntil(clearApi().catch(() => undefined))
    return
  }
  switch (route(request, self.location.origin)) {
    case 'navigation': event.respondWith(handleNavigation(event)); return
    case 'asset': event.respondWith(handleAsset(event)); return
    case 'api': event.respondWith(handleApi(event)); return
    default: return
  }
}

function onInstall(event) {
  event.waitUntil(fetch('/', { cache: 'reload' })
    .then((response) => response.ok ? refreshShell(response) : undefined)
    .catch(() => undefined)
    .then(() => self.skipWaiting()))
}

function onActivate(event) {
  event.waitUntil(caches.keys()
    .then((names) => Promise.all(names
      .filter((name) => name.startsWith('checkist-') && !name.startsWith(SHELL_PREFIX) && name !== API_CACHE)
      .map((name) => caches.delete(name))))
    .then(() => self.clients.claim()))
}

function onMessage(event) {
  if (event.data && event.data.type === CLEAR_MESSAGE) event.waitUntil(clearApi())
}

self.addEventListener('install', onInstall)
self.addEventListener('activate', onActivate)
self.addEventListener('fetch', onFetch)
self.addEventListener('message', onMessage)

// For the unit test only: the decisions above, without a browser.
self.checkistSw = { route, assetUrls, nestedAssetUrls, shellVersion, refreshShell, API_CACHE, SHELL_PREFIX, SHELL_URL, OFFLINE_HEADER, CLEAR_MESSAGE, FRESH_HEADER }
