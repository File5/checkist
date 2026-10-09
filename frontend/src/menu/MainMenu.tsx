import { useEffect, useLayoutEffect, useReducer, useRef } from 'react'
import type { FocusEvent, RefObject } from 'react'
import { Link } from '../navigation'
import type { Route } from '../navigation'
import type { Session } from '../session'
import { menuItems } from './menu-items'
import type { MenuItem } from './menu-items'
import { moreMenuReducer } from './more-menu'

const MORE_LIST_ID = 'main-more-list'

function item({ key, to, label, current, account }: MenuItem) {
  return <Link key={key} className={account ? 'account-link' : undefined} to={to} aria-label={account ? `Аккаунт: ${label}` : undefined}
    aria-current={current ? 'page' : undefined}>{label}</Link>
}

/** The main menu of the shell: one `nav` for every width. In the header it is a row of links; on a phone the
 * stylesheet pins it to the bottom of the window and keeps the links after the third one behind «Ещё».
 */
export default function MainMenu({ session, route, menuRef }: { session: Session; route: Route; menuRef: RefObject<HTMLElement | null> }) {
  const { primary, more } = menuItems(session, route)
  const [open, dispatch] = useReducer(moreMenuReducer, false)
  const toggle = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  const currentInMore = more.find((entry) => entry.current)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      dispatch('escape')
      toggle.current?.focus()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) dispatch('outside')
    }
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
    }
  }, [open])

  useLayoutEffect(() => {
    // A closed list is not drawn on a phone: the focus that stood inside it goes to the button instead of being lost.
    // After a transition the shell moves it further, to the heading of the page.
    if (!open && list.current?.contains(document.activeElement)) toggle.current?.focus()
  }, [open])

  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (open && !event.currentTarget.contains(event.relatedTarget)) dispatch('focus-left')
  }

  return (
    <nav className="main-navigation" aria-label="Основная навигация" ref={menuRef}>
      {primary.map(item)}
      {more.length > 0 && <div className="main-more" ref={wrapper} data-open={open ? '' : undefined} onBlur={onBlur}>
        {/* Hidden wherever the menu is a row of links. The current section is named: the mark alone is for the eye. */}
        <button type="button" className="main-more-toggle" ref={toggle} aria-expanded={open} aria-controls={MORE_LIST_ID}
          aria-label={currentInMore ? `Ещё, текущий раздел: ${currentInMore.label}` : undefined}
          data-current={currentInMore ? '' : undefined} onClick={() => dispatch('toggle')}>Ещё</button>
        <div className="main-more-list" id={MORE_LIST_ID} ref={list} onClick={(event) => {
          if (event.target instanceof Element && event.target.closest('a')) dispatch('navigate')
        }}>
          {more.map(item)}
        </div>
      </div>}
    </nav>
  )
}
