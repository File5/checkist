import { useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react'
import type { FocusEvent, MouseEvent, RefObject } from 'react'
import { Link } from '../navigation'
import type { Route } from '../navigation'
import type { Session } from '../session'
import { useQuickShot } from '../features/recognition/QuickShot'
import Sheet from '../components/Sheet'
import Icon from '../components/Icon'
import type { IconName } from '../components/Icon'
import { ThemeToggle } from '../theme'
import { menuItems, ADD_AFTER } from './menu-items'
import type { MenuItem } from './menu-items'
import { MORE_MENU_CLOSED, PRESS_END_EVENTS, moreMenuStep } from './more-menu'

const MORE_LIST_ID = 'main-more-list'
const ADD_SHEET_ID = 'main-add-sheet'

/** A link of the menu: the word, and a picture that only the bottom bar and the list behind «Ещё» of a phone show. */
function item({ key, to, label, current, account, icon }: MenuItem) {
  return <Link key={key} className={account ? 'account-link' : undefined} to={to} aria-label={account ? `Аккаунт: ${label}` : undefined}
    aria-current={current ? 'page' : undefined}><Icon name={icon} />{label}</Link>
}

/** A button and the list it opens: «Ещё» of the bottom bar of a phone.
 * Only the button opens the list; Esc, a press outside, an action of the list and the focus that leaves close it.
 */
function usePopup() {
  const [{ open }, dispatch] = useReducer(moreMenuStep, MORE_MENU_CLOSED)
  const toggle = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLDivElement>(null)
  const wrapper = useRef<HTMLDivElement>(null)

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
  const wrapperProps = {
    ref: wrapper,
    'data-open': open ? '' : undefined,
    onBlur: (event: FocusEvent<HTMLDivElement>) => {
      if (!event.currentTarget.contains(event.relatedTarget)) dispatch('focus-left')
    },
    onPointerDown: onPress,
    onMouseDown: onPress,
    onPointerCancel: () => dispatch('release'),
  }
  const onListClick = (event: MouseEvent<HTMLDivElement>) => {
    // A link or an action button of the list closes it; a press of its empty place only ends the press. The theme
    // switch keeps the list open: the person sees the new theme and may switch back.
    dispatch(event.target instanceof Element && event.target.closest('a, button:not(.ck-theme-toggle)') ? 'navigate' : 'release')
  }
  return { open, toggle, list, wrapperProps, onListClick, onToggle: () => dispatch('toggle') }
}

/** «＋» of the phone's bar: a raised round button and a sheet from the bottom (components/Sheet) with «Снять чек»,
 * «Из галереи» and «Добавить трату». «Снять чек» opens the camera and «Из галереи» the picker from the very press
 * (both fields stay mounted outside of the sheet); the chosen file goes to the upload page and is sent by itself.
 * The sheet is a modal dialog: Esc, the backdrop and its close button close it, the focus returns to «＋». */
function AddMenu() {
  const [open, setOpen] = useState(false)
  const shot = useQuickShot('camera')
  const gallery = useQuickShot('gallery')
  const close = () => setOpen(false)
  // The picker is opened inside the same press, before the sheet is gone: the browser keeps the user activation.
  const choose = (action: () => void) => () => { close(); action() }
  const body = (icon: IconName, title: string, note: string) => <>
    <span className="main-add-icon"><Icon name={icon} /></span>
    <span className="main-add-text"><span className="main-add-title">{title}</span><span className="main-add-note">{note}</span></span>
    <Icon name="forward" size={18} className="ck-icon main-add-chevron" />
  </>
  return (
    <div className="main-add">
      {/* Hidden wherever the menu is a row of links. */}
      <button type="button" className="main-add-toggle" aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? ADD_SHEET_ID : undefined}
        aria-label="Добавить: снять чек, выбрать из галереи, добавить трату или загрузить выписку" onClick={() => setOpen(true)}>
        <Icon name="plus" size={26} />
      </button>
      <Sheet open={open} onClose={close} title="Добавить" id={ADD_SHEET_ID}>
        <div className="main-add-list">
          <button type="button" className="main-add-action main-add-primary" onClick={choose(shot.open)}>{body('camera', 'Снять чек', 'Камера — чек распознается сам')}</button>
          <button type="button" className="main-add-action" onClick={choose(gallery.open)}>{body('image', 'Из галереи', 'Фото чека или PDF с телефона')}</button>
          <Link className="main-add-action" to="/receipts/new" onClick={close}>{body('pencil', 'Добавить трату', 'Вручную или словами, без чека')}</Link>
          <Link className="main-add-action" to="/statements/new" onClick={close}>{body('statement', 'Загрузить выписку', 'PDF Kaspi Gold или ForteBank')}</Link>
        </div>
      </Sheet>
      {shot.field}
      {gallery.field}
    </div>
  )
}

/** The main menu of the shell: one `nav` for every width. In the header it is a row of links; on a phone the
 * stylesheet pins it to the bottom of the window: «Главная · Траты · ＋ · Статистика · Ещё», the links after
 * the third one behind «Ещё».
 */
export default function MainMenu({ session, route, menuRef }: { session: Session; route: Route; menuRef: RefObject<HTMLElement | null> }) {
  const { primary, more, add } = menuItems(session, route)
  const { open, toggle, list, wrapperProps, onListClick, onToggle } = usePopup()
  const currentInMore = more.find((entry) => entry.current)

  return (
    <nav className="main-navigation" aria-label="Основная навигация" ref={menuRef}>
      {primary.slice(0, ADD_AFTER).map(item)}
      {add && <AddMenu />}
      {primary.slice(ADD_AFTER).map(item)}
      {more.length > 0 && <div className="main-more" {...wrapperProps}>
        {/* Hidden wherever the menu is a row of links. The current section is named: the mark alone is for the eye. */}
        <button type="button" className="main-more-toggle" ref={toggle} aria-expanded={open} aria-controls={MORE_LIST_ID}
          aria-label={currentInMore ? `Ещё, текущий раздел: ${currentInMore.label}` : undefined}
          data-current={currentInMore ? '' : undefined} onClick={onToggle}><Icon name="more" />Ещё</button>
        <div className="main-more-list" id={MORE_LIST_ID} ref={list} onClick={onListClick}>
          {more.map(item)}
          {/* The header of a phone is gone: its theme switch lives at the end of this list (hidden on wider screens). */}
          <div className="main-more-theme"><ThemeToggle placement="menu" /></div>
        </div>
      </div>}
    </nav>
  )
}
