import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LoginPage } from '../features/login'
import { ThemeToggle } from './ThemeToggle'
import { createThemeStore, defaultTheme, nextTheme, parseTheme, themeColors, themeLabel, themeStorageKey, useTheme } from './theme'
import type { Theme, ThemeEnvironment } from './theme'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

function environment(saved: string | null = null) {
  const state = { saved, applied: [] as Theme[], external: undefined as (() => void) | undefined, stopped: 0 }
  const env: ThemeEnvironment = {
    read: () => state.saved,
    write: (theme) => { state.saved = theme },
    apply: (theme) => { state.applied.push(theme) },
    listen: (listener) => {
      state.external = listener
      return () => { state.external = undefined; state.stopped += 1 }
    },
  }
  return { state, env }
}

describe('saved theme value', () => {
  it('reads only the two known values, anything else is the dark theme', () => {
    expect(parseTheme('light')).toBe('light')
    expect(parseTheme('dark')).toBe('dark')
    for (const value of [null, undefined, '', 'Light', ' light', 'system', 'auto', '1', 0, true, {}, ['light']]) {
      expect(parseTheme(value)).toBe('dark')
    }
    expect(defaultTheme).toBe('dark')
    expect(themeStorageKey).toBe('checkist.theme')
  })

  it('switches between the two themes and names the current one', () => {
    expect(nextTheme('dark')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
    expect(themeLabel('dark')).toBe('Тема: тёмная')
    expect(themeLabel('light')).toBe('Тема: светлая')
  })
})

describe('theme store', () => {
  it('starts dark on the first visit and with a garbage value, light only when it was saved', () => {
    expect(createThemeStore(environment().env).getSnapshot()).toBe('dark')
    expect(createThemeStore(environment('blue').env).getSnapshot()).toBe('dark')
    expect(createThemeStore(environment('light').env).getSnapshot()).toBe('light')
    expect(createThemeStore(environment('light').env).getServerSnapshot()).toBe('dark')
  })

  it('does not touch the environment until it is asked', () => {
    let calls = 0
    const count = () => { calls += 1; return null }
    createThemeStore({ read: count, write: count, apply: count, listen: () => { calls += 1; return () => {} } })
    expect(calls).toBe(0)
  })

  it('saves, applies and announces a switch', () => {
    const { state, env } = environment()
    const store = createThemeStore(env)
    let notified = 0
    const unsubscribe = store.subscribe(() => { notified += 1 })
    expect(state.applied).toEqual(['dark'])

    store.toggle()
    expect(store.getSnapshot()).toBe('light')
    expect(state.saved).toBe('light')
    expect(state.applied).toEqual(['dark', 'light'])
    expect(notified).toBe(1)

    store.toggle()
    expect(store.getSnapshot()).toBe('dark')
    expect(state.saved).toBe('dark')
    expect(notified).toBe(2)

    store.setTheme('dark')
    expect(notified).toBe(2)
    unsubscribe()
    store.toggle()
    expect(notified).toBe(2)
  })

  it('follows a change made in another tab while somebody is subscribed', () => {
    const { state, env } = environment()
    const store = createThemeStore(env)
    const seen: Theme[] = []
    const first = store.subscribe(() => seen.push(store.getSnapshot()))
    const second = store.subscribe(() => {})

    state.saved = 'light'
    state.external?.()
    expect(seen).toEqual(['light'])
    state.saved = 'nonsense'
    state.external?.()
    expect(seen).toEqual(['light', 'dark'])

    first()
    expect(state.stopped).toBe(0)
    expect(state.external).toBeDefined()
    second()
    expect(state.stopped).toBe(1)
  })

  it('survives a failing localStorage: reads dark, still switches for the open page', () => {
    const applied: Theme[] = []
    const refuse = () => { throw new DOMException('denied', 'SecurityError') }
    const store = createThemeStore({ read: refuse, write: refuse, apply: (theme) => { applied.push(theme) }, listen: refuse })
    expect(store.getSnapshot()).toBe('dark')
    let notified = 0
    expect(() => store.subscribe(() => { notified += 1 })).not.toThrow()
    expect(() => store.toggle()).not.toThrow()
    expect(store.getSnapshot()).toBe('light')
    expect(applied).toEqual(['dark', 'light'])
    expect(notified).toBe(1)
  })

  it('survives a document that cannot show the theme', () => {
    const store = createThemeStore({ read: () => 'light', write: () => {}, apply: () => { throw new ReferenceError('document is not defined') } })
    expect(() => store.subscribe(() => {})).not.toThrow()
    expect(() => store.toggle()).not.toThrow()
    expect(store.getSnapshot()).toBe('dark')
  })
})

describe('without a browser', () => {
  it('has no window and no document in this test run', () => {
    expect(typeof window).toBe('undefined')
    expect(typeof document).toBe('undefined')
  })

  it('renders the hook and the switch as the dark theme', () => {
    const Probe = () => useTheme().theme
    expect(renderToStaticMarkup(createElement(Probe))).toBe('dark')

    const page = renderToStaticMarkup(createElement(ThemeToggle))
    expect(page).toContain('<button type="button" class="ck-theme-toggle"')
    expect(page).toContain('Тема: тёмная')
    expect(page).not.toContain('aria-pressed')
    expect(page).toContain('aria-hidden="true"')

    const header = renderToStaticMarkup(createElement(ThemeToggle, { placement: 'header' }))
    expect(header).toContain('class="ck-theme-toggle ck-theme-toggle-header"')
    expect(header).toContain('Тема: тёмная')
  })

  it('switches the browser store without a browser: the choice lives in memory', () => {
    const Probe = () => {
      const { theme, toggle } = useTheme()
      if (theme === 'dark') expect(() => toggle()).not.toThrow()
      return theme
    }
    // The server snapshot stays dark whatever the store holds.
    expect(renderToStaticMarkup(createElement(Probe))).toBe('dark')
    expect(renderToStaticMarkup(createElement(ThemeToggle))).toContain('Тема: тёмная')
  })

  it('renders the login placeholder', () => {
    expect(renderToStaticMarkup(createElement(LoginPage))).toContain('class="ck-login"')
  })
})

describe('theme contract in the files', () => {
  const tokens = read('./tokens.css')
  const html = read('../../index.html')
  const block = (selector: string) => {
    const start = tokens.indexOf(`\n${selector} {`)
    expect(start, selector).toBeGreaterThan(-1)
    return tokens.slice(start, tokens.indexOf('\n}', start))
  }
  const names = (css: string) => [...css.matchAll(/^\s*(--ck-[a-z0-9-]+):/gm)].map((match) => match[1])
  const dark = block(':root')
  const light = block(':root[data-theme="light"]')

  it('keeps dark values in :root and overrides only colours for the light theme', () => {
    expect(dark).toContain('color-scheme: dark;')
    expect(light).toContain('color-scheme: light;')
    const darkNames = names(dark)
    const lightNames = names(light)
    expect(new Set(darkNames).size).toBe(darkNames.length)
    expect(new Set(lightNames).size).toBe(lightNames.length)
    expect(lightNames.filter((name) => !darkNames.includes(name))).toEqual([])
    // The header bar, the logo plate, radii and fonts are the same in both themes.
    expect(darkNames.filter((name) => !lightNames.includes(name))).toEqual([
      '--ck-header-bg', '--ck-header-text', '--ck-header-text-muted', '--ck-header-accent', '--ck-header-hover-bg', '--ck-header-border',
      '--ck-header-focus', '--ck-logo-bg', '--ck-radius-sm', '--ck-radius', '--ck-font-body', '--ck-font-display',
    ])
  })

  it('defines every token of the contract', () => {
    const required = [
      'bg', 'surface', 'surface-raised', 'text', 'text-muted', 'brand', 'brand-hover', 'brand-active', 'on-brand',
      'accent', 'on-accent', 'accent-text', 'accent-bg', 'link', 'link-hover', 'border', 'border-field', 'divider', 'focus',
      ...['error', 'success', 'warning', 'info', 'neutral'].flatMap((state) => [`${state}-text`, `${state}-bg`, `${state}-border`]),
      'disabled-bg', 'disabled-text', 'disabled-border', 'popover-border', 'popover-shadow', 'panel-shadow',
      'header-bg', 'header-text', 'header-accent', 'logo-bg', 'radius-sm', 'radius', 'font-body', 'font-display',
      ...Array.from({ length: 8 }, (_, index) => `series-${index + 1}`), 'series-other', 'series-special', 'plot-grid', 'plot-axis',
    ]
    expect(required.filter((name) => !names(dark).includes(`--ck-${name}`))).toEqual([])
    expect(dark).toContain('--ck-radius-sm: 4px;')
    expect(dark).toContain('--ck-radius: 6px;')
    expect(dark).toContain('--ck-logo-bg: #111111;')
    expect(dark).toContain('--ck-font-display: "Oswald", "Arial Narrow", "Roboto Condensed", "Segoe UI", sans-serif;')
    // Names kept by Charts.css must not be defined here: it points them at these tokens.
    expect(tokens).not.toMatch(/^\s*--ck-chart-/m)
  })

  it('agrees with theme.ts and index.html about the key and the page colours', () => {
    expect(dark).toContain(`--ck-bg: ${themeColors.dark};`)
    expect(light).toContain(`--ck-bg: ${themeColors.light};`)
    expect(html).toContain(`<meta name="theme-color" content="${themeColors.dark}" />`)
    expect(html).toContain(`localStorage.getItem('${themeStorageKey}') === 'light'`)
    expect(html).toContain(`'${themeColors.light}'`)
    expect(html).toContain('<title>Чекист</title>')
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />')
    const inline = html.slice(html.indexOf('<script>'), html.indexOf('</script>'))
    expect(inline).toContain('try {')
    expect(html.indexOf('<meta name="theme-color"')).toBeLessThan(html.indexOf('<script>'))
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<script type="module"'))
  })

  it('ships the heading font as a local file with its licence', () => {
    expect(tokens).toContain('font-display: swap;')
    expect(tokens).toContain('url("../assets/fonts/oswald-latin-cyrillic.woff2") format("woff2")')
    expect(tokens).not.toMatch(/url\(["']?https?:/)
    const font = readFileSync(new URL('../assets/fonts/oswald-latin-cyrillic.woff2', import.meta.url))
    expect(font.subarray(0, 4).toString('latin1')).toBe('wOF2')
    expect(read('../assets/fonts/Oswald-OFL.txt')).toContain('SIL Open Font License, Version 1.1')
  })

  it('styles the switch with tokens only', () => {
    const css = read('./ThemeToggle.css')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
    expect(css).toContain('min-height: 44px')
    expect(css).not.toContain('transition')
    expect([...css.matchAll(/\.(ck-[a-z-]+)/g)].every((match) => match[1].startsWith('ck-theme-'))).toBe(true)
  })
})
