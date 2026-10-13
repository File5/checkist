import Icon from './Icon'
import { listIconsLabel, setListIcons, useListIcons } from '../lib/list-icons'

/** A row of the list behind «Ещё» of a phone, beside the theme switch (and in its look, theme/ThemeToggle.css): its text
 * names what the squares of the spends show now, a press switches it at once and keeps the list open. */
export default function ListIconsToggle() {
  const mode = useListIcons()
  return <button type="button" className="ck-theme-toggle ck-theme-toggle-menu" data-list-icons={mode}
    onClick={() => setListIcons(mode === 'source' ? 'category' : 'source')}>
    <Icon name={mode === 'source' ? 'receipt' : 'tag'} />
    <span className="ck-theme-label">{listIconsLabel(mode)}</span>
  </button>
}
