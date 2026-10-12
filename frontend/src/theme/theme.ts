import { useSyncExternalStore } from 'react'

export type Theme = 'dark' | 'light'

export const themeStorageKey = 'checkist.theme'
/** The theme without a choice of the person and without a system preference (a server render, no matchMedia). */
export const defaultTheme: Theme = 'dark'
/** The media query that tells the system preference; the inline script of index.html asks the same one. */
export const lightSchemeQuery = '(prefers-color-scheme: light)'
/** Page background of each theme for `<meta name="theme-color">`; the same values as `--ck-bg` in tokens.css. */
export const themeColors: Record<Theme, string> = { dark: '#0e1316', light: '#f3f5f7' }

/** A saved `light` or `dark` is the choice of the person; anything else (first visit, garbage, another type)
 * is no choice, and the theme of the system — `fallback` — applies. */
export function parseTheme(value: unknown, fallback: Theme = defaultTheme): Theme {
  return value === 'light' || value === 'dark' ? value : fallback
}

export function nextTheme(theme: Theme): Theme {
  return theme === 'dark' ? 'light' : 'dark'
}

export function themeLabel(theme: Theme) {
  return theme === 'dark' ? 'Тема: тёмная' : 'Тема: светлая'
}

export type ThemeEnvironment = {
  read: () => string | null
  write: (theme: Theme) => void
  /** Reflects the theme outside React: `data-theme` on `<html>` and the theme-color meta. */
  apply: (theme: Theme) => void
  /** The theme of the system (`prefers-color-scheme`); used while the person has not chosen. */
  system?: () => Theme
  /** Reports a change of the saved value made elsewhere (another tab) or of the system theme. */
  listen?: (listener: () => void) => () => void
}

export type ThemeStore = ReturnType<typeof createThemeStore>

/** Every environment call is guarded: blocked storage or a missing document must not break the page. */
export function createThemeStore(environment: ThemeEnvironment) {
  let theme: Theme | undefined
  const listeners = new Set<() => void>()
  let stopListening: (() => void) | undefined

  function system(): Theme {
    try {
      return environment.system?.() ?? defaultTheme
    } catch {
      return defaultTheme
    }
  }
  function read(): Theme {
    let saved: string | null = null
    try {
      saved = environment.read()
    } catch {
      // Blocked storage: the system theme still applies.
    }
    return parseTheme(saved, system())
  }
  function apply(value: Theme) {
    try {
      environment.apply(value)
    } catch {
      // The store keeps the theme even when the document cannot show it.
    }
  }
  function getSnapshot(): Theme {
    theme ??= read()
    return theme
  }
  function publish(value: Theme) {
    if (value === theme) return
    theme = value
    apply(value)
    for (const listener of listeners) listener()
  }
  function setTheme(value: Theme) {
    try {
      environment.write(value)
    } catch {
      // Without storage the choice lives until the page is closed.
    }
    publish(value)
  }

  return {
    getSnapshot,
    getServerSnapshot: (): Theme => defaultTheme,
    setTheme,
    toggle: () => setTheme(nextTheme(getSnapshot())),
    subscribe(listener: () => void) {
      if (listeners.size === 0) {
        // The inline script of index.html has set the attribute already; this covers a page served without it.
        apply(getSnapshot())
        try {
          stopListening = environment.listen?.(() => publish(read()))
        } catch {
          stopListening = undefined
        }
      }
      listeners.add(listener)
      return () => {
        listeners.delete(listener)
        if (listeners.size > 0) return
        stopListening?.()
        stopListening = undefined
      }
    },
  }
}

export function applyThemeToDocument(theme: Theme) {
  const root = document.documentElement
  if (theme === 'light') root.setAttribute('data-theme', 'light')
  else root.removeAttribute('data-theme')
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', themeColors[theme])
}

let store: ThemeStore | undefined

function browserTheme() {
  // Nothing here touches the browser until React subscribes or the user toggles: App is also rendered in Node.
  store ??= createThemeStore({
    read: () => window.localStorage.getItem(themeStorageKey),
    write: (theme) => window.localStorage.setItem(themeStorageKey, theme),
    apply: applyThemeToDocument,
    system: () => (window.matchMedia(lightSchemeQuery).matches ? 'light' : 'dark'),
    listen: (listener) => {
      const onStorage = (event: StorageEvent) => {
        if (event.key === themeStorageKey || event.key === null) listener()
      }
      window.addEventListener('storage', onStorage)
      // The system theme changes (the phone switches to night): followed while the person has not chosen.
      let scheme: MediaQueryList | undefined
      try {
        scheme = window.matchMedia(lightSchemeQuery)
        scheme.addEventListener('change', listener)
      } catch {
        scheme = undefined
      }
      return () => {
        window.removeEventListener('storage', onStorage)
        scheme?.removeEventListener('change', listener)
      }
    },
  })
  return store
}

/** Current theme and its switch: the saved choice, otherwise the system theme. A server render
 * (renderToStaticMarkup) always sees the dark theme. */
export function useTheme() {
  const current = browserTheme()
  const theme = useSyncExternalStore(current.subscribe, current.getSnapshot, current.getServerSnapshot)
  return { theme, setTheme: current.setTheme, toggle: current.toggle }
}
