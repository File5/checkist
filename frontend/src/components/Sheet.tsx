import { useEffect, useId, useLayoutEffect, useRef } from 'react'
import type { KeyboardEvent, ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { SHEET_FOCUSABLE, sheetKeyAction, shouldReturnFocus } from './sheet-keys'
import Icon from './Icon'
import './Sheet.css'

export interface SheetProps {
  open: boolean
  /** Esc, a tap on the backdrop and the close button ask for it; the owner sets `open` to false. */
  onClose: () => void
  /** The visible heading of the sheet and the name of the dialog. */
  title: string
  children: ReactNode
  /** The id of the dialog, for `aria-controls` of the button that opens it. */
  id?: string
  /** The name of the close button. */
  closeLabel?: string
}

const reachable = (node: HTMLElement | null) => node ? [...node.querySelectorAll<HTMLElement>(SHEET_FOCUSABLE)] : []

/**
 * A sheet that slides up from the bottom of the window: a modal dialog with its own heading and close button.
 * The focus goes to its first control, Tab stays inside, Esc and a tap on the backdrop close it, the focus
 * returns to the control that opened it. The page behind does not scroll while it is open. The handle at the
 * top is a picture only: the sheet is not dragged. A closed sheet renders nothing.
 *
 * In the browser it is rendered into `document.body`, above every layer of the page; a server render
 * (renderToStaticMarkup in the tests) draws it in place.
 */
export default function Sheet({ open, onClose, title, children, id, closeLabel = 'Закрыть' }: SheetProps) {
  const titleId = useId()
  const dialog = useRef<HTMLDivElement>(null)
  const close = useRef(onClose)
  useEffect(() => { close.current = onClose })

  useLayoutEffect(() => {
    if (!open) return
    const node = dialog.current
    const opener = document.activeElement instanceof HTMLElement && document.activeElement !== document.body ? document.activeElement : null
    const root = document.documentElement
    root.classList.add('ck-sheet-open')
    ;(reachable(node)[0] ?? node)?.focus()
    // A screen reader or a script may move the focus behind the sheet: it comes back to the first control.
    const onFocusIn = (event: FocusEvent) => {
      if (node && event.target instanceof Node && !node.contains(event.target)) (reachable(node)[0] ?? node).focus()
    }
    document.addEventListener('focusin', onFocusIn)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      root.classList.remove('ck-sheet-open')
      const active = document.activeElement
      const where = !active || active === document.body ? 'lost' : node?.contains(active) ? 'inside' : 'elsewhere'
      if (opener && shouldReturnFocus(where, opener.isConnected)) opener.focus()
    }
  }, [open])

  if (!open) return null

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const controls = reachable(dialog.current)
    const action = sheetKeyAction(event.key, event.shiftKey, controls.indexOf(document.activeElement as HTMLElement), controls.length)
    if (!action) return
    event.preventDefault()
    event.stopPropagation()
    if (action.kind === 'close') close.current()
    else controls[action.index]?.focus()
  }

  const layer = (
    <div className="ck-sheet-layer">
      <div className="ck-sheet-backdrop" aria-hidden="true" onClick={() => close.current()} />
      <div className="ck-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId} id={id} ref={dialog} tabIndex={-1} onKeyDown={onKeyDown}>
        <div className="ck-sheet-handle" aria-hidden="true" />
        <div className="ck-sheet-head">
          <h2 className="ck-sheet-title" id={titleId}>{title}</h2>
          <button type="button" className="ck-sheet-close" aria-label={closeLabel} onClick={() => close.current()}>
            <Icon name="close" size={20} />
          </button>
        </div>
        <div className="ck-sheet-body">{children}</div>
      </div>
    </div>
  )
  return typeof document === 'undefined' ? layer : createPortal(layer, document.body)
}
