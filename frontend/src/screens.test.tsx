import { readFileSync } from 'node:fs'
import { Suspense } from 'react'
import type { ComponentType } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Route } from './navigation'

/** A fresh copy of screens.ts (and of the count of requests it reads): nothing of it loaded or warmed yet. */
async function fresh() {
  vi.resetModules()
  const screens = await import('./screens')
  const activity = await import('./api/activity')
  return { screens, activity }
}
const waiting = (Screen: ComponentType<Record<string, never>>) =>
  renderToStaticMarkup(<Suspense fallback={<i>ждём часть</i>}><Screen /></Suspense>)

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

describe('screens in parts of the build (src/screens.ts)', () => {
  it('gives every route a screen of the shell, except the three the shell draws itself', async () => {
    const { screens } = await fresh()
    const drawn = Object.entries(screens.routeScreens).filter(([, screen]) => !screen).map(([kind]) => kind)
    expect(drawn.sort()).toEqual(['invalid-query', 'login', 'not-found'] satisfies Route['kind'][])
  })

  it('resolves every screen to a component of its module', async () => {
    const { screens } = await fresh()
    const all = Object.entries(screens).filter(([, value]) => typeof value === 'object' && value !== null && 'preload' in value)
    expect(all.length).toBeGreaterThanOrEqual(35)
    for (const [name, screen] of all) {
      const component = await (screen as { preload: () => Promise<unknown> }).preload()
      expect(typeof component, name).toBe('function')
    }
  })

  it('shows the fallback while a script is on its way, and the screen at once when it was loaded before', async () => {
    const { screens } = await fresh()
    expect(waiting(screens.StoresPage)).toBe('<i>ждём часть</i>')
    const { screens: again } = await fresh()
    await again.StoresPage.preload()
    const html = waiting(again.StoresPage)
    expect(html).not.toContain('ждём часть')
    expect(html).toContain('Загружаем магазины…')
  })

  it('loads every screen for the tests of the shell (preloadScreens)', async () => {
    const { screens } = await fresh()
    await screens.preloadScreens()
    expect(waiting(screens.GoalsPage)).not.toContain('ждём часть')
    expect(waiting(screens.HealthPage)).not.toContain('ждём часть')
  })

  it('turns a script that did not come into ScreenLoadError, and fetches it again on the next attempt', async () => {
    vi.resetModules()
    let fail = true
    vi.doMock('./features/stores', async (original) => {
      if (fail) throw new Error('Failed to fetch dynamically imported module')
      return original()
    })
    const screens = await import('./screens')
    const error = await screens.StoresPage.preload().catch((reason: unknown) => reason)
    expect(error).toBeInstanceOf(screens.ScreenLoadError)
    expect((error as Error).message).toContain('StoresPage')
    fail = false
    expect(typeof await screens.StoresPage.preload()).toBe('function')
    vi.doUnmock('./features/stores')
    vi.resetModules()
  })
})

describe('the warm-up of the other screens (warmScreens)', () => {
  function browser(idle: (callback: () => void) => void, saveData = false) {
    vi.stubGlobal('window', { requestIdleCallback: idle, setTimeout, clearTimeout })
    vi.stubGlobal('navigator', { connection: { saveData } })
  }

  it('waits for the first screen and for the network to be quiet, then loads every screen on an idle moment', async () => {
    const { screens, activity } = await fresh()
    const idle: (() => void)[] = []
    browser((callback) => idle.push(callback))
    let first!: () => void
    activity.begin()
    screens.warmScreens(new Promise<void>((resolve) => { first = resolve }))
    first()
    await Promise.resolve()
    await Promise.resolve()
    expect(idle).toHaveLength(0)
    activity.end()
    expect(idle).toHaveLength(1)
    idle[0]()
    await vi.waitFor(() => expect(waiting(screens.GoalsPage)).not.toContain('ждём часть'))
  })

  it('does not wait for a network that never quiets down longer than the limit', async () => {
    vi.useFakeTimers()
    const { screens, activity } = await fresh()
    const idle: (() => void)[] = []
    browser((callback) => idle.push(callback))
    activity.begin()
    screens.warmScreens(Promise.resolve())
    await vi.advanceTimersByTimeAsync(screens.WARM_QUIET_LIMIT_MS - 1)
    expect(idle).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(idle).toHaveLength(1)
    activity.end()
  })

  it('warms once per page, and never with «Экономия трафика»', async () => {
    const { screens } = await fresh()
    const idle: (() => void)[] = []
    browser((callback) => idle.push(callback), true)
    screens.warmScreens(Promise.resolve())
    screens.warmScreens(Promise.resolve())
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(idle).toHaveLength(0)
    expect(waiting(screens.GoalsPage)).toBe('<i>ждём часть</i>')
  })
})

describe('App.tsx takes its screens from screens.ts (text of the file)', () => {
  const app = readFileSync(new URL('./App.tsx', import.meta.url), 'utf8')
  const imports = [...app.matchAll(/^import (?!type )[^'\n]*from '(\.\/(?:features|pages)\/[^']+)'/gm)].map((match) => match[1])

  it('imports no screen statically: only the sign-in and the small helpers of the shell', () => {
    expect(imports.sort()).toEqual(['./features/auth/LoginPage', './features/auth/auth-state', './features/auth/labels', './features/stats/stats-memory'])
  })

  it('wraps the page and the guest screen of a new family in Suspense with a skeleton', () => {
    expect(app.match(/<Suspense fallback={<ScreenFallback kind={route\.kind} \/>}>/g)).toHaveLength(2)
    expect(app).toContain("from './screens'")
  })
})
