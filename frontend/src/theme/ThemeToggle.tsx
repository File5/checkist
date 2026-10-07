import { themeLabel, useTheme } from './theme'
import './ThemeToggle.css'

export type ThemeToggleProps = {
  /** `header` — on the dark header bar, which stays dark in both themes; `page` — on the page or a panel. */
  placement?: 'page' | 'header'
}

/** A plain button: its text names the current theme, a press switches it at once and keeps the focus. */
export function ThemeToggle({ placement = 'page' }: ThemeToggleProps) {
  const { theme, toggle } = useTheme()
  return (
    <button
      type="button"
      className={placement === 'header' ? 'ck-theme-toggle ck-theme-toggle-header' : 'ck-theme-toggle'}
      data-theme-current={theme}
      onClick={toggle}
    >
      <svg className="ck-theme-icon" viewBox="0 0 20 20" width="20" height="20" aria-hidden="true" focusable="false">
        {theme === 'dark'
          ? <path d="M14.5 13.2A7 7 0 0 1 7.6 3a7.5 7.5 0 1 0 9.6 9.4 7 7 0 0 1-2.7.8Z" />
          : <path d="M10 5.5a4.5 4.5 0 1 0 0 9 4.5 4.5 0 0 0 0-9ZM9.2 1h1.6v3H9.2Zm0 15h1.6v3H9.2ZM1 9.2h3v1.6H1Zm15 0h3v1.6h-3ZM3.1 4.2l1.1-1.1 2.1 2.1-1.1 1.1Zm10.6 10.6 1.1-1.1 2.1 2.1-1.1 1.1ZM3.1 15.8l2.1-2.1 1.1 1.1-2.1 2.1ZM13.7 5.2l2.1-2.1 1.1 1.1-2.1 2.1Z" />}
      </svg>
      <span className="ck-theme-label">{themeLabel(theme)}</span>
    </button>
  )
}

export default ThemeToggle
