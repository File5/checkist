import { readFileSync } from 'node:fs'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { requestJson } from '../api/http'
import { OfflineBannerView } from './OfflineBanner'
import { newPending } from './pending'
import { PendingSpendsView, pendingSavedText, photosOnlineText } from './PendingSpends'
import { entryScript, isNewBuild, reloadWaits } from './service-worker'
import { getOfflineStatus, offlineMessage, OFFLINE_HEADER, reportApiAnswer, resetOfflineStatus } from './status'

const noop = () => {}
const spend = (patch: Partial<ReturnType<typeof newPending>> = {}) => ({
  ...newPending({ currency: 'KZT', purchased_on: '2026-10-12', store_name: 'Кофейня', note: '', category: 2, total: '450', lines: [] },
    'anna', new Date('2026-10-12T10:00:00Z'), 'one'),
  ...patch,
})

afterEach(() => { resetOfflineStatus(); vi.unstubAllGlobals() })

describe('offline banner', () => {
  it('is absent while the network and the answers are fresh', () => {
    expect(offlineMessage({ online: true, served: false })).toBeUndefined()
    expect(renderToStaticMarkup(<OfflineBannerView status={{ online: true, served: false }} />)).toBe('')
  })

  it('says «Нет сети» and what still works', () => {
    const markup = renderToStaticMarkup(<OfflineBannerView status={{ online: false, served: false }} />)
    expect(markup).toContain('class="offline-banner"')
    expect(markup).toContain('role="status"')
    expect(markup).toContain('<strong>Нет сети.</strong>')
    expect(markup).toContain('фото можно отправить только при сети')
    expect(markup).not.toContain('Показаны сохранённые данные')
  })

  it('says the data is the saved one when the API answered from the phone', () => {
    expect(renderToStaticMarkup(<OfflineBannerView status={{ online: false, served: true }} />)).toContain('Показаны сохранённые данные.')
    const reachable = renderToStaticMarkup(<OfflineBannerView status={{ online: true, served: true }} />)
    expect(reachable).toContain('<strong>Сервер недоступен.</strong>')
    expect(reachable).toContain('Показаны сохранённые данные.')
  })

  it('uses only tokens of the warning state and sets no font size', () => {
    const css = readFileSync(new URL('./Offline.css', import.meta.url), 'utf8')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i)
    expect(css).not.toMatch(/font-size\s*:/)
    expect(css).toContain('var(--ck-warning-bg)')
    expect(css).toContain('var(--ck-warning-text)')
  })
})

describe('the transport reports answers of the service worker', () => {
  it('a marked answer raises «served», a fresh one clears it', async () => {
    const answer = (offline: boolean) => new Response('{"ok":true}', {
      status: 200, headers: offline ? { [OFFLINE_HEADER]: '1' } : {},
    })
    const fetchMock = vi.fn(async () => answer(true))
    vi.stubGlobal('fetch', fetchMock)
    const ok = (value: unknown): value is { ok: boolean } => typeof value === 'object' && value !== null
    await requestJson('receipts/', {}, ok, { baseUrl: '/api' })
    expect(getOfflineStatus().served).toBe(true)
    fetchMock.mockImplementation(async () => answer(false))
    await requestJson('receipts/', {}, ok, { baseUrl: '/api' })
    expect(getOfflineStatus().served).toBe(false)
  })

  it('an answer without headers (test doubles) changes nothing', () => {
    reportApiAnswer(false)
    expect(getOfflineStatus()).toEqual({ online: true, served: false })
  })
})

describe('pending spends on «Чеки»', () => {
  const view = (items: ReturnType<typeof spend>[], extra: { syncing?: boolean; note?: string } = {}) => renderToStaticMarkup(
    <PendingSpendsView state={{ items, syncing: extra.syncing ?? false, note: extra.note }} onSend={noop} onFix={noop} onDelete={noop} />)

  it('shows nothing without waiting spends', () => {
    expect(view([])).toBe('')
  })

  it('lists each spend with its actions and the send button', () => {
    const markup = view([spend(), spend({ id: 'two', body: { ...spend().body, store_name: null, note: 'такси', total: '1200.5' } })])
    expect(markup).toContain('Ждут отправки: 2')
    expect(markup).toContain(pendingSavedText)
    expect(markup).toContain(photosOnlineText)
    expect(markup).toContain('Кофейня')
    expect(markup).toContain('такси')
    expect(markup).toContain('<time dateTime="2026-10-12">12.10.2026</time>')
    expect(markup).toMatch(/>450.₸</)
    expect(markup).toMatch(/>1.201.₸</)
    expect(markup.match(/>Исправить</g)).toHaveLength(2)
    expect(markup.match(/>Удалить</g)).toHaveLength(2)
    expect(markup).toContain('>Отправить сейчас</button>')
  })

  it('shows the refusal of the server at its spend and the run in progress', () => {
    const markup = view([spend({ error: 'Проверьте отмеченные поля.' })], { syncing: true, note: 'Сервер пока недоступен — отправим, когда появится сеть.' })
    expect(markup).toContain('role="alert">Не отправлено: Проверьте отмеченные поля.</p>')
    expect(markup).toContain('disabled="">Отправляем…</button>')
    expect(markup).toContain('role="status">Сервер пока недоступен')
  })
})

describe('new build after a deploy', () => {
  const page = (entry: string) => `<!doctype html><head><script type="module" crossorigin src="/assets/${entry}.js"></script></head>`

  it('reads the entry script of a built page only', () => {
    expect(entryScript(page('index-AAA'))).toBe('/assets/index-AAA.js')
    expect(entryScript('<script src="/assets/x.js" type="module"></script>')).toBe('/assets/x.js')
    expect(entryScript('<script type="module" src="/src/main.tsx"></script>')).toBeUndefined()
  })

  it('reloads only for another build', () => {
    expect(isNewBuild('/assets/index-AAA.js', page('index-BBB'))).toBe(true)
    expect(isNewBuild('/assets/index-AAA.js', page('index-AAA'))).toBe(false)
    expect(isNewBuild(undefined, page('index-BBB'))).toBe(false)
    expect(isNewBuild('/assets/index-AAA.js', '<html>maintenance</html>')).toBe(false)
  })

  it('never reloads a form with typed text', () => {
    expect(reloadWaits('/receipts/new')).toBe(true)
    expect(reloadWaits('/receipts/12/edit')).toBe(true)
    expect(reloadWaits('/receipts/upload')).toBe(true)
    expect(reloadWaits('/receipts')).toBe(false)
    expect(reloadWaits('/catalog')).toBe(false)
  })
})

describe('index.html and main.tsx', () => {
  it('main.tsx registers the service worker only in a production build', () => {
    const main = readFileSync(new URL('../main.tsx', import.meta.url), 'utf8')
    expect(main).toMatch(/if \(import\.meta\.env\.PROD\) registerServiceWorker\(\)/)
    const register = readFileSync(new URL('./service-worker.ts', import.meta.url), 'utf8')
    expect(register).toContain("if (!('serviceWorker' in navigator)) return")
    expect(register).toContain("register('/sw.js', { scope: '/' })")
  })
})
