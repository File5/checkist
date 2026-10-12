import { useRef } from 'react'
import type { ReactNode } from 'react'
import { navigate } from '../../navigation'
import { setQuickShot } from './quick-shot'
import './QuickShot.css'

export type QuickShotControl = {
  /** Opens the camera. Call it from the click itself: iOS Safari would not open it from a later task or page. */
  open: () => void
  /** The hidden camera field; render it where it stays mounted after the press (not inside a list that closes). */
  field: ReactNode
}

/** «Снять чек» from any screen: the shot goes to the upload page and is sent there by itself.
 * The one camera mechanism of the app: the «＋» sheet of the main menu (src/menu/MainMenu.tsx) and the big
 * button of «Главная» (QuickShotButton.tsx) both use this hook. */
export function useQuickShot(): QuickShotControl {
  const input = useRef<HTMLInputElement>(null)
  const field = (
    <input ref={input} className="ck-quick-shot-input" type="file" accept="image/*" capture="environment" tabIndex={-1} aria-hidden="true"
      onChange={(event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (!file) return
        // On the open upload page the shot is taken there; otherwise the page opens and sends it.
        if (!setQuickShot(file)) navigate('/receipts/upload')
      }} />
  )
  return { open: () => input.current?.click(), field }
}
