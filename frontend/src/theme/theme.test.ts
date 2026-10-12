import { readFileSync } from 'node:fs'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { LoginPage } from '../features/auth'
import { ThemeToggle } from './ThemeToggle'
import { createThemeStore, defaultTheme, lightSchemeQuery, nextTheme, parseTheme, themeColors, themeLabel, themeStorageKey, useTheme } from './theme'
import type { Theme, ThemeEnvironment } from './theme'

const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8')

function environment(saved: string | null = null, system?: Theme) {
  const state = { saved, system, applied: [] as Theme[], external: undefined as (() => void) | undefined, stopped: 0 }
  const env: ThemeEnvironment = {
    read: () => state.saved,
    system: () => state.system ?? 'dark',
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
  it('reads only the two known values as a choice; anything else is the theme of the system', () => {
    for (const system of ['dark', 'light'] as Theme[]) {
      expect(parseTheme('light', system)).toBe('light')
      expect(parseTheme('dark', system)).toBe('dark')
      for (const value of [null, undefined, '', 'Light', ' light', 'system', 'auto', '1', 0, true, {}, ['light']]) {
        expect(parseTheme(value, system)).toBe(system)
      }
    }
    // Without a system preference: the dark theme.
    expect(parseTheme(null)).toBe('dark')
    expect(defaultTheme).toBe('dark')
    expect(themeStorageKey).toBe('checkist.theme')
    expect(lightSchemeQuery).toBe('(prefers-color-scheme: light)')
  })

  it('switches between the two themes and names the current one', () => {
    expect(nextTheme('dark')).toBe('light')
    expect(nextTheme('light')).toBe('dark')
    expect(themeLabel('dark')).toBe('Тема: тёмная')
    expect(themeLabel('light')).toBe('Тема: светлая')
  })
})

describe('theme store', () => {
  it('follows the system on the first visit and with a garbage value; a saved choice wins', () => {
    expect(createThemeStore(environment().env).getSnapshot()).toBe('dark')
    expect(createThemeStore(environment(null, 'light').env).getSnapshot()).toBe('light')
    expect(createThemeStore(environment('blue', 'light').env).getSnapshot()).toBe('light')
    expect(createThemeStore(environment('blue').env).getSnapshot()).toBe('dark')
    expect(createThemeStore(environment('light').env).getSnapshot()).toBe('light')
    expect(createThemeStore(environment('dark', 'light').env).getSnapshot()).toBe('dark')
    expect(createThemeStore(environment('light', 'dark').env).getSnapshot()).toBe('light')
    expect(createThemeStore(environment('light').env).getServerSnapshot()).toBe('dark')
    // An environment without the system preference (an old browser, a test): the dark theme.
    expect(createThemeStore({ read: () => null, write: () => {}, apply: () => {} }).getSnapshot()).toBe('dark')
  })

  it('follows a change of the system theme while the person has not chosen, and not after the choice', () => {
    const { state, env } = environment(null, 'dark')
    const store = createThemeStore(env)
    const seen: Theme[] = []
    const unsubscribe = store.subscribe(() => seen.push(store.getSnapshot()))
    state.system = 'light'
    state.external?.()
    expect(seen).toEqual(['light'])
    store.setTheme('dark')
    expect(state.saved).toBe('dark')
    state.system = 'light'
    state.external?.()
    expect(store.getSnapshot()).toBe('dark')
    unsubscribe()
  })

  it('still follows the system when the storage refuses to be read, and a failing system query reads dark', () => {
    const refuse = () => { throw new DOMException('denied', 'SecurityError') }
    expect(createThemeStore({ read: refuse, write: () => {}, apply: () => {}, system: () => 'light' }).getSnapshot()).toBe('light')
    expect(createThemeStore({ read: () => null, write: () => {}, apply: () => {}, system: refuse }).getSnapshot()).toBe('dark')
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
    const store = createThemeStore({ read: refuse, write: refuse, apply: (theme) => { applied.push(theme) }, listen: refuse, system: refuse })
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

  it('renders the sign-in screen with the page theme switch', () => {
    const html = renderToStaticMarkup(createElement(LoginPage, { expired: false }))
    expect(html).toContain('class="ck-login"')
    expect(html.match(/class="ck-theme-toggle"/g)).toHaveLength(1)
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
    // The logo plate, radii and fonts are the same in both themes; the header takes the colours of each theme.
    expect(darkNames.filter((name) => !lightNames.includes(name))).toEqual([
      '--ck-logo-bg', '--ck-radius-sm', '--ck-radius', '--ck-radius-button', '--ck-radius-pill', '--ck-font-body', '--ck-font-display',
      // Mobile design 2026-10-12: the fonts of figures, the text scale, the teeth of the tape and the fades of a chip row.
      '--ck-font-figures', '--ck-font-display-figures',
      '--ck-text-xs', '--ck-text-sm', '--ck-text-base', '--ck-text-lg', '--ck-text-xl', '--ck-text-hero', '--ck-tape-tooth', '--ck-fade-size',
      '--ck-bottom-nav-height', '--ck-safe-bottom', '--ck-bottom-occupied', '--ck-action-bar-room',
      '--ck-z-action-bar', '--ck-z-top-bar', '--ck-z-bottom-nav', '--ck-z-menu-sheet', '--ck-z-sheet', '--ck-z-skip-link',
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
      'bottom-nav-height', 'safe-bottom', 'bottom-occupied', 'action-bar-room', 'z-action-bar', 'z-bottom-nav', 'z-menu-sheet', 'z-skip-link',
      'radius-button', 'radius-pill', 'header-text-muted', 'header-hover-bg', 'header-border', 'header-focus',
    ]
    expect(required.filter((name) => !names(dark).includes(`--ck-${name}`))).toEqual([])
    expect(dark).toContain('--ck-radius-sm: 12px;')
    expect(dark).toContain('--ck-radius: 20px;')
    expect(dark).toContain('--ck-radius-button: 16px;')
    expect(dark).toContain('--ck-radius-pill: 999px;')
    expect(dark).toContain('--ck-logo-bg: #0f0f0e;')
    expect(dark).toContain('--ck-font-body: "Manrope", system-ui, -apple-system, "Segoe UI", sans-serif;')
    expect(dark).toContain('--ck-font-display: "Manrope", system-ui, -apple-system, "Segoe UI", sans-serif;')
    // Names kept by Charts.css must not be defined here: it points them at these tokens.
    expect(tokens).not.toMatch(/^\s*--ck-chart-/m)
  })

  it('agrees with theme.ts and index.html about the key and the page colours', () => {
    expect(dark).toContain(`--ck-bg: ${themeColors.dark};`)
    expect(light).toContain(`--ck-bg: ${themeColors.light};`)
    expect(html).toContain(`<meta name="theme-color" content="${themeColors.dark}" />`)
    expect(html).toContain(`localStorage.getItem('${themeStorageKey}')`)
    // A saved choice wins; without one the system preference decides.
    expect(html).toContain(`saved === 'light' || (saved !== 'dark' && window.matchMedia('${lightSchemeQuery}').matches)`)
    expect(html).toContain(`'${themeColors.light}'`)
    expect(html).toContain('<title>Чекист</title>')
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg" />')
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />')
    const inline = html.slice(html.indexOf('<script>'), html.indexOf('</script>'))
    expect(inline).toContain('try {')
    expect(html.indexOf('<meta name="theme-color"')).toBeLessThan(html.indexOf('<script>'))
    expect(html.indexOf('<script>')).toBeLessThan(html.indexOf('<script type="module"'))
  })

  it('paints the installed app and the tab icon in the red/gold palette', () => {
    // The splash and the bar of an installed app take the dark page colour; the icon background is the red brand.
    const manifest = JSON.parse(read('../../public/manifest.json')) as { theme_color: string; background_color: string }
    expect(manifest.theme_color.toLowerCase()).toBe(themeColors.dark)
    expect(manifest.background_color.toLowerCase()).toBe(themeColors.dark)
    expect(read('../../public/favicon.svg')).toContain('fill="#B01212"')
    expect(read('../../brand/app-icon.svg')).toContain('<rect width="512" height="512" fill="#B01212"/>')
  })

  it('loads Manrope from Google Fonts with display=swap and no font file of its own', () => {
    // No Content-Security-Policy of the project forbids Google Fonts (deploy/Caddyfile, deploy/docker/Caddyfile).
    expect(html).toContain('<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />')
    expect(html).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Manrope:wght@400..800&amp;display=swap" />')
    expect(tokens).not.toContain('@font-face')
    expect(tokens).not.toMatch(/url\(/)
    expect(tokens).not.toContain('Oswald')
  })

  it('loads the fonts of figures the same way, with only the weights the design uses', () => {
    // JetBrains Mono 500–600 for sums, quantities and prices; Unbounded 600 for the one hero sum of a screen.
    expect(html).toContain('<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@500;600&amp;family=Unbounded:wght@600&amp;display=swap" />')
    expect(html.match(/fonts\.googleapis\.com\/css2/g)).toHaveLength(2)
    expect(dark).toContain('--ck-font-figures: "JetBrains Mono", ui-monospace, "SF Mono", Menlo, Consolas, monospace;')
    expect(dark).toContain('--ck-font-display-figures: "Unbounded", "Manrope", system-ui, -apple-system, "Segoe UI", sans-serif;')
  })

  it('defines the text scale of a phone: 13 / 15 / 16 / 18 / 22 / 40 px', () => {
    const scale = Object.fromEntries([...dark.matchAll(/--ck-text-(xs|sm|base|lg|xl|hero): ([\d.]+)rem;/g)].map((match) => [match[1], Number(match[2]) * 16]))
    expect(scale).toEqual({ xs: 13, sm: 15, base: 16, lg: 18, xl: 22, hero: 40 })
  })

  it('orders the layers: action bar, top bar, bottom navigation, menu, sheet, skip link', () => {
    const layer = (name: string) => Number(new RegExp(`--ck-z-${name}: (\\d+);`).exec(dark)?.[1])
    const order = ['action-bar', 'top-bar', 'bottom-nav', 'menu-sheet', 'sheet', 'skip-link'].map(layer)
    expect(order.every((value, index) => index === 0 || value > order[index - 1])).toBe(true)
  })

  it('defines the shared tokens of the family budget in both themes, the gold accent with dark text on it', () => {
    const contract = [
      ...Array.from({ length: 6 }, (_, index) => [`--ck-cat-${index + 1}`, `--ck-cat-${index + 1}-tint`]).flat(),
      '--ck-over-text', '--ck-over-bar', '--ck-track', '--ck-on-accent',
    ]
    for (const name of contract) {
      expect(names(dark), name).toContain(name)
      expect(names(light), name).toContain(name)
    }
    expect(tokens.match(/\/\* family-budget tokens \*\//g)).toHaveLength(2)
    // Red/gold palette (back 2026-10-12): the red brand under white text, the gold accent under dark text, in both themes.
    for (const theme of [dark, light]) {
      expect(theme).toContain('--ck-brand: #b01212;')
      expect(theme).toContain('--ck-on-brand: #ffffff;')
      expect(theme).toContain('--ck-accent: #f0c24b;')
      expect(theme).toContain('--ck-on-accent: #2a1b16;')
      // The header bar is dark in both themes, with the red line under it.
      expect(theme).toContain('--ck-header-bg: #1a0c0a;')
      expect(theme).toContain('--ck-header-border: #b01212;')
    }
    // No card shadow in the dark theme: the colour of the shadow is transparent there.
    expect(dark).toContain('--ck-panel-shadow: #00000000;')
  })

  it('styles the switch with tokens only', () => {
    const css = read('./ThemeToggle.css')
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(/i)
    expect(css).toContain('min-height: 44px')
    expect(css).not.toContain('transition')
    expect([...css.matchAll(/\.(ck-[a-z-]+)/g)].every((match) => match[1].startsWith('ck-theme-'))).toBe(true)
  })
})
