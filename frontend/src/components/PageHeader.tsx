import { useContext } from 'react'
import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { PageHeaderContext } from './page-header'

/**
 * Draws its children in the header row of the shell (page-header.ts), on every width: «‹» before the heading
 * (`side="start"`), «›» and the family after it (`side="end"`). Outside of the shell (a markup test renders a screen
 * alone) they stay in place, so the screen is still whole; inside it, nothing is drawn until the slot exists.
 */
export function HeaderSlot({ side, children }: { side: 'start' | 'end'; children: ReactNode }) {
  const slots = useContext(PageHeaderContext)
  if (!slots) return <>{children}</>
  const node = slots[side]
  return node ? createPortal(children, node) : null
}

export default HeaderSlot
