// public/sw.js run in Node with a fake `self`, `caches` and `fetch`: its routing and its strategies.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { API_CACHE, CLEAR_MESSAGE } from './service-worker'
import { OFFLINE_HEADER } from './status'

const ORIGIN = 'https://checkist.test'
const source = readFileSync(new URL('../../public/sw.js', import.meta.url), 'utf8')
const abs = (url: string) => new URL(url, ORIGIN).href
type Fetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
type Listener = (event: unknown) => void
type SwApi = {
  route: (request: { url: string; method: string; mode?: string; headers?: Headers }, origin: string) => string
  assetUrls: (html: string) => string[]
  nestedAssetUrls: (text: string) => string[]
  shellVersion: (html: string) => string
  API_CACHE: string; SHELL_PREFIX: string; SHELL_URL: string; OFFLINE_HEADER: string; CLEAR_MESSAGE: string; FRESH_HEADER: string
}

class FakeCache {
  entries = new Map<string, Response>()
  constructor(private readonly fetcher: Fetch) {}
  key = (request: RequestInfo | URL) => typeof request === 'string' ? abs(request) : request instanceof URL ? request.href : request.url
  async match(request: RequestInfo) { return this.entries.get(this.key(request))?.clone() }
  async put(request: RequestInfo, response: Response) { this.entries.set(this.key(request), response) }
  async add(url: string) { await this.addAll([url]) }
  async addAll(urls: string[]) {
    for (const url of urls) {
      const response = await this.fetcher(abs(url))
      if (!response.ok) throw new TypeError('addAll failed')
      this.entries.set(abs(url), response)
    }
  }
}
class FakeCaches {
  stores = new Map<string, FakeCache>()
  constructor(private readonly fetcher: Fetch) {}
  async open(name: string) {
    if (!this.stores.has(name)) this.stores.set(name, new FakeCache(this.fetcher))
    return this.stores.get(name)!
  }
  async has(name: string) { return this.stores.has(name) }
  async delete(name: string) { return this.stores.delete(name) }
  async keys() { return [...this.stores.keys()] }
  async match(request: RequestInfo) {
    for (const cache of this.stores.values()) {
      const found = await cache.match(request)
      if (found) return found
    }
    return undefined
  }
}

function loadSw(fetcher: Fetch) {
  const listeners: Record<string, Listener> = {}
  const caches = new FakeCaches(fetcher)
  const self = {
    addEventListener: (type: string, listener: Listener) => { listeners[type] = listener },
    location: { origin: ORIGIN },
    skipWaiting: vi.fn(async () => undefined),
    clients: { claim: vi.fn(async () => undefined) },
    checkistSw: undefined as unknown as SwApi,
  }
  new Function('self', 'caches', 'fetch', source)(self, caches, fetcher)
  return { api: self.checkistSw, listeners, caches, self }
}

class FakeEvent {
  response?: Promise<Response>
  waits: Promise<unknown>[] = []
  constructor(readonly request: { url: string; method: string; mode?: string; headers: Headers }, readonly data?: unknown) {}
  respondWith(response: Promise<Response>) { this.response = response }
  waitUntil(promise: Promise<unknown>) { this.waits.push(promise) }
  async settled() {
    const response = await this.response
    await new Promise((resolve) => setTimeout(resolve, 0))
    await Promise.all(this.waits)
    await Promise.all(this.waits)
    return response
  }
}
const request = (url: string, init: { method?: string; mode?: string; headers?: Record<string, string> } = {}) => ({
  url: abs(url), method: init.method ?? 'GET', mode: init.mode ?? 'cors', headers: new Headers(init.headers),
})
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
const html = (entry: string) => `<!doctype html><html><head><script type="module" crossorigin src="/assets/${entry}.js"></script>`
  + `<link rel="stylesheet" crossorigin href="/assets/${entry}.css"></head><body><div id="root"></div></body></html>`
const page = (body: string) => new Response(body, { status: 200, headers: { 'Content-Type': 'text/html' } })

afterEach(() => { vi.useRealTimers() })

describe('sw.js routing', () => {
  const { api } = loadSw(async () => new Response(''))
  const route = (url: string, init?: Parameters<typeof request>[1]) => api.route(request(url, init), ORIGIN)

  it('sends each address to its strategy', () => {
    expect(route('/catalog', { mode: 'navigate' })).toBe('navigation')
    expect(route('/', { mode: 'navigate' })).toBe('navigation')
    expect(route('/receipts/12?page=2', { mode: 'navigate' })).toBe('navigation')
    expect(route('/assets/index-abc.js')).toBe('asset')
    expect(route('/api/receipts/?page=1')).toBe('api')
    expect(route('/api/me/')).toBe('api')
    expect(route('/api/stats/spending/?date_from=2026-01-01')).toBe('api')
  })

  it('never touches writes, sign-in, tokens, health, photos, admin and other origins', () => {
    expect(route('/api/receipts/manual/', { method: 'POST' })).toBe('bypass')
    expect(route('/api/receipts/5/', { method: 'PATCH' })).toBe('bypass')
    expect(route('/api/receipts/5/', { method: 'DELETE' })).toBe('bypass')
    expect(route('/api/auth/csrf/')).toBe('bypass')
    expect(route('/api/auth/login/', { method: 'POST' })).toBe('bypass')
    expect(route('/api/recognition/csrf/')).toBe('bypass')
    expect(route('/api/health/')).toBe('bypass')
    expect(route('/media/receipts/1.jpg')).toBe('bypass')
    expect(route('/admin/', { mode: 'navigate' })).toBe('bypass')
    expect(route('/media/receipts/1.jpg', { mode: 'navigate' })).toBe('bypass')
    expect(route('/static/admin/css/base.css')).toBe('bypass')
    expect(route('/manifest.json')).toBe('bypass')
    expect(route('/sw.js')).toBe('bypass')
    expect(api.route({ ...request('/assets/x.js'), url: 'https://cdn.example/assets/x.js' }, ORIGIN)).toBe('bypass')
    expect(route('/api/receipts/', { headers: { 'X-Checkist-Fresh': '1' } })).toBe('bypass')
  })

  it('shares its names with the page', () => {
    expect(api.API_CACHE).toBe(API_CACHE)
    expect(api.CLEAR_MESSAGE).toBe(CLEAR_MESSAGE)
    expect(api.OFFLINE_HEADER).toBe(OFFLINE_HEADER)
  })

  it('reads the assets of index.html and names the shell after its content', () => {
    const index = html('index-AAA') + '<link rel="icon" href="/favicon.svg"><link rel="modulepreload" href="/assets/vendor-B.js">'
    expect(api.assetUrls(index)).toEqual(['/assets/index-AAA.js', '/assets/index-AAA.css', '/assets/vendor-B.js'])
    expect(api.shellVersion(index)).toBe(api.shellVersion(index))
    expect(api.shellVersion(index)).not.toBe(api.shellVersion(html('index-BBB')))
    expect(api.shellVersion(index)).toMatch(/^[0-9a-f]{8}$/)
  })
})

describe('sw.js strategies', () => {
  it('finds fonts and images named inside scripts and styles', () => {
    const { api } = loadSw(async () => new Response(''))
    expect(api.nestedAssetUrls('@font-face{src:url(/assets/oswald-X1.woff2)}a{b:url(/assets/oswald-X1.woff2)}'))
      .toEqual(['/assets/oswald-X1.woff2'])
    expect(api.nestedAssetUrls('var a=`/assets/emblem-96-B7.webp`,b="/assets/";import("/assets/chunk-Q.js")'))
      .toEqual(['/assets/emblem-96-B7.webp', '/assets/chunk-Q.js'])
  })

  it('install pre-caches index.html with its assets and takes over at once', async () => {
    const fetcher = vi.fn<Fetch>(async (input) => String(input).endsWith('/') ? page(html('index-A'))
      : String(input).endsWith('.css') ? new Response('@font-face{src:url(/assets/font-F.woff2)}a{b:url(/assets/gone.png)}')
        : String(input).endsWith('gone.png') ? new Response('', { status: 404 }) : new Response('asset'))
    const { listeners, caches, self, api } = loadSw(fetcher)
    const event = new FakeEvent(request('/'))
    listeners.install(event)
    await Promise.all(event.waits)
    const [name] = await caches.keys()
    expect(name).toBe(api.SHELL_PREFIX + api.shellVersion(html('index-A')))
    const shell = caches.stores.get(name)!
    expect([...shell.entries.keys()].sort())
      .toEqual([abs('/assets/font-F.woff2'), abs('/assets/index-A.css'), abs('/assets/index-A.js'), abs('/index.html')])
    expect(self.skipWaiting).toHaveBeenCalled()
  })

  it('a navigation online stores the new index.html and drops the old shell', async () => {
    let entry = 'index-A'
    const fetcher = vi.fn<Fetch>(async (input) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      return url.includes('/assets/') ? new Response('asset') : page(html(entry))
    })
    const { listeners, caches, api } = loadSw(fetcher)
    const install = new FakeEvent(request('/'))
    listeners.install(install)
    await Promise.all(install.waits)
    entry = 'index-B'
    const navigation = new FakeEvent(request('/catalog', { mode: 'navigate' }))
    listeners.fetch(navigation)
    const response = await navigation.settled()
    expect(await response!.text()).toContain('index-B')
    expect(await caches.keys()).toEqual([api.SHELL_PREFIX + api.shellVersion(html('index-B'))])
  })

  it('a navigation without network gets the cached index.html', async () => {
    let online = true
    const { listeners } = loadSw(async (input) => {
      if (!online) throw new TypeError('offline')
      return String(input).includes('/assets/') ? new Response('asset') : page(html('index-A'))
    })
    const install = new FakeEvent(request('/'))
    listeners.install(install)
    await Promise.all(install.waits)
    online = false
    const navigation = new FakeEvent(request('/receipts', { mode: 'navigate' }))
    listeners.fetch(navigation)
    expect(await (await navigation.settled())!.text()).toContain('index-A')
  })

  it('a slow navigation gets the cached page after 3 s', async () => {
    let slow = false
    const { listeners } = loadSw(async (input) => {
      if (slow) return new Promise<Response>(() => undefined)
      return String(input).includes('/assets/') ? new Response('asset') : page(html('index-A'))
    })
    const install = new FakeEvent(request('/'))
    listeners.install(install)
    await Promise.all(install.waits)
    slow = true
    vi.useFakeTimers()
    const navigation = new FakeEvent(request('/stats', { mode: 'navigate' }))
    listeners.fetch(navigation)
    let answered: Response | undefined
    void navigation.response!.then((response) => { answered = response })
    await vi.advanceTimersByTimeAsync(2900)
    expect(answered).toBeUndefined()
    await vi.advanceTimersByTimeAsync(200)
    expect(await answered!.text()).toContain('index-A')
  })

  it('assets come from the cache first', async () => {
    const fetcher = vi.fn<Fetch>(async (input) => String(input).includes('/assets/') ? new Response('asset') : page(html('index-A')))
    const { listeners } = loadSw(fetcher)
    const install = new FakeEvent(request('/'))
    listeners.install(install)
    await Promise.all(install.waits)
    fetcher.mockClear()
    const asset = new FakeEvent(request('/assets/index-A.js'))
    listeners.fetch(asset)
    expect(await (await asset.settled())!.text()).toBe('asset')
    expect(fetcher).not.toHaveBeenCalled()
  })

  it('an API read is kept and given back marked when the network is gone', async () => {
    let online = true
    const { listeners, caches } = loadSw(async () => {
      if (!online) throw new TypeError('offline')
      return json({ results: [1] })
    })
    const first = new FakeEvent(request('/api/receipts/?page=1'))
    listeners.fetch(first)
    const fresh = await first.settled()
    expect(fresh!.headers.get(OFFLINE_HEADER)).toBeNull()
    expect(caches.stores.get(API_CACHE)!.entries.size).toBe(1)

    online = false
    const again = new FakeEvent(request('/api/receipts/?page=1'))
    listeners.fetch(again)
    const cached = await again.settled()
    expect(cached!.headers.get(OFFLINE_HEADER)).toBe('1')
    expect(await cached!.json()).toEqual({ results: [1] })

    // Another address was never read: the failure goes to the page.
    const other = new FakeEvent(request('/api/receipts/?page=2'))
    listeners.fetch(other)
    await expect(other.response).rejects.toThrow('offline')
  })

  it('never keeps a refusal, and a 401 forgets every kept answer', async () => {
    let status = 200
    const { listeners, caches } = loadSw(async () => json({ ok: true }, status))
    const ok = new FakeEvent(request('/api/receipts/'))
    listeners.fetch(ok)
    await ok.settled()
    expect(caches.stores.get(API_CACHE)!.entries.size).toBe(1)

    status = 404
    const missing = new FakeEvent(request('/api/receipts/99/'))
    listeners.fetch(missing)
    await missing.settled()
    expect(caches.stores.get(API_CACHE)!.entries.size).toBe(1)

    status = 401
    const ended = new FakeEvent(request('/api/me/'))
    listeners.fetch(ended)
    expect((await ended.settled())!.status).toBe(401)
    expect(caches.stores.has(API_CACHE)).toBe(false)
  })

  it('sign-out, sign-in and the message of the page forget the kept answers', async () => {
    const { listeners, caches } = loadSw(async () => json({ ok: true }))
    const fill = async () => {
      const event = new FakeEvent(request('/api/me/'))
      listeners.fetch(event)
      await event.settled()
      expect(caches.stores.has(API_CACHE)).toBe(true)
    }
    await fill()
    const logout = new FakeEvent(request('/api/auth/logout/', { method: 'POST' }))
    listeners.fetch(logout)
    expect(logout.response).toBeUndefined()
    await Promise.all(logout.waits)
    expect(caches.stores.has(API_CACHE)).toBe(false)

    await fill()
    const login = new FakeEvent(request('/api/auth/login/', { method: 'POST' }))
    listeners.fetch(login)
    await Promise.all(login.waits)
    expect(caches.stores.has(API_CACHE)).toBe(false)

    await fill()
    const message = new FakeEvent(request('/'), { type: CLEAR_MESSAGE })
    listeners.message(message)
    await Promise.all(message.waits)
    expect(caches.stores.has(API_CACHE)).toBe(false)
  })

  it('photos and writes are left to the browser', () => {
    const { listeners } = loadSw(async () => new Response(''))
    for (const event of [new FakeEvent(request('/media/a.jpg')), new FakeEvent(request('/api/receipts/manual/', { method: 'POST' }))]) {
      listeners.fetch(event)
      expect(event.response).toBeUndefined()
    }
  })

  it('activate drops caches of another schema and keeps its own', async () => {
    const { listeners, caches, api, self } = loadSw(async () => new Response(''))
    for (const name of ['checkist-api-v0', 'checkist-shell-old', api.SHELL_PREFIX + 'abc', API_CACHE, 'other-app']) await caches.open(name)
    const event = new FakeEvent(request('/'))
    listeners.activate(event)
    await Promise.all(event.waits)
    expect((await caches.keys()).sort()).toEqual([API_CACHE, api.SHELL_PREFIX + 'abc', 'other-app'].sort())
    expect(self.clients.claim).toHaveBeenCalled()
  })
})
