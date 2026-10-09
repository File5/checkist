import { useEffect, useLayoutEffect, useReducer, useRef } from 'react'
import type { FocusEvent, MouseEvent, RefObject } from 'react'
import { Link } from '../navigation'
import type { Route } from '../navigation'
import type { Session } from '../session'
import { menuItems } from './menu-items'
import type { MenuItem } from './menu-items'
import { MORE_MENU_CLOSED, PRESS_END_EVENTS, moreMenuStep } from './more-menu'

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
  const [{ open }, dispatch] = useReducer(moreMenuStep, MORE_MENU_CLOSED)
  const toggle = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const wrapper = useRef<HTMLDivElement>(null)
  const currentInMore = more.find((entry) => entry.current)

  useEffect(() => {
    if (!open) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') {
        // The keyboard is in use again: a press that brought no click is over, Tab out of the list closes it.
        dispatch('release')
        return
      }
      dispatch('escape')
      toggle.current?.focus()
    }
    const onPointerDown = (event: PointerEvent) => {
      if (event.target instanceof Node && !wrapper.current?.contains(event.target)) dispatch('outside')
    }
    // The press ends where the pointer goes up, not only by a click inside: a finger that slid off the list
    // leaves no press behind, and the next leave of the focus closes the list.
    const onPressEnd = () => dispatch('release')
    document.addEventListener('keydown', onKeyDown)
    document.addEventListener('pointerdown', onPointerDown)
    for (const type of PRESS_END_EVENTS) document.addEventListener(type, onPressEnd, true)
    return () => {
      document.removeEventListener('keydown', onKeyDown)
      document.removeEventListener('pointerdown', onPointerDown)
      for (const type of PRESS_END_EVENTS) document.removeEventListener(type, onPressEnd, true)
    }
  }, [open])

  useLayoutEffect(() => {
    // A closed list is not drawn on a phone: the focus that stood inside it goes to the button instead of being lost.
    // After a transition the shell moves it further, to the heading of the page.
    if (!open && list.current?.contains(document.activeElement)) toggle.current?.focus()
  }, [open])

  // The press comes before the blur it causes, whoever gets the focus afterwards (in Safari no one does):
  // the reducer hears both in that order and leaves the list open for the click. A touch reports the press
  // as pointerdown long before the blur and as mousedown right before it; both are listened to.
  const onPress = () => dispatch('press')
  const onRelease = () => dispatch('release')
  const onBlur = (event: FocusEvent<HTMLDivElement>) => {
    if (!event.currentTarget.contains(event.relatedTarget)) dispatch('focus-left')
  }
  const onListClick = (event: MouseEvent<HTMLDivElement>) => {
    dispatch(event.target instanceof Element && event.target.closest('a') ? 'navigate' : 'release')
  }

  return (
    <nav className="main-navigation" aria-label="Основная навигация" ref={menuRef}>
      {primary.map(item)}
      {more.length > 0 && <div className="main-more" ref={wrapper} data-open={open ? '' : undefined} onBlur={onBlur}
        onPointerDown={onPress} onMouseDown={onPress} onPointerCancel={onRelease}>
        {/* Hidden wherever the menu is a row of links. The current section is named: the mark alone is for the eye. */}
        <button type="button" className="main-more-toggle" ref={toggle} aria-expanded={open} aria-controls={MORE_LIST_ID}
          aria-label={currentInMore ? `Ещё, текущий раздел: ${currentInMore.label}` : undefined}
          data-current={currentInMore ? '' : undefined} onClick={() => dispatch('toggle')}>Ещё</button>
        <div className="main-more-list" id={MORE_LIST_ID} ref={list} onClick={onListClick}>
          {more.map(item)}
        </div>
      </div>}
    </nav>
  )
}
