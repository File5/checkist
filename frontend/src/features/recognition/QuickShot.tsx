import { useRef } from 'react'
import type { ReactNode } from 'react'
import { galleryAccept, handOver } from './quick-shot'
import './QuickShot.css'

/** `camera` — «Снять чек», the camera right away; `gallery` — «Из галереи», a photo or a PDF already on the device. */
export type QuickShotSource = 'camera' | 'gallery'

export type QuickShotControl = {
  /** Opens the camera or the picker. Call it from the click itself: iOS Safari would not open it from a later task or page. */
  open: () => void
  /** The hidden file field; render it where it stays mounted after the press (not inside a list that closes). */
  field: ReactNode
}

/** «Снять чек» and «Из галереи» from any screen: the file goes to the upload page and is sent there by itself.
 * The one mechanism of the app: the «＋» sheet of the main menu (src/menu/MainMenu.tsx) and the big buttons of
 * «Главная» (QuickShotButton.tsx) both use this hook; the two sources differ only in their field. */
export function useQuickShot(source: QuickShotSource = 'camera'): QuickShotControl {
  const input = useRef<HTMLInputElement>(null)
  const field = (
    <input ref={input} className="ck-quick-shot-input" type="file"
      accept={source === 'camera' ? 'image/*' : galleryAccept} capture={source === 'camera' ? 'environment' : undefined}
      tabIndex={-1} aria-hidden="true"
      onChange={(event) => {
        const file = event.target.files?.[0]
        event.target.value = ''
        if (file) handOver(file)
      }} />
  )
  return { open: () => input.current?.click(), field }
}
