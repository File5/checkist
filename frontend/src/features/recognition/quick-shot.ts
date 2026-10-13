import { navigate } from '../../navigation'

// The file of «Снять чек» or «Из галереи» (the «＋» menu, «Главная») on any screen, waiting for the upload page that sends it by itself.
let pending: File | undefined
// The mounted upload page: a shot taken while it is open goes to it at once (navigating to it again would not remount it).
let listener: ((file: File) => void) | undefined

/** Keeps the shot for the upload page. True when a mounted upload page took it, so there is nowhere to navigate. */
export const setQuickShot = (file: File): boolean => {
  if (listener) { pending = undefined; listener(file); return true }
  pending = file
  return false
}
export const peekQuickShot = () => pending
export const clearQuickShot = () => { pending = undefined }
/** The upload page takes the shots that arrive while it is mounted; returns the unsubscribe. */
export const onQuickShot = (take: (file: File) => void) => {
  listener = take
  return () => { if (listener === take) listener = undefined }
}

/** «Из галереи» has no `capture`: iOS offers the photo library, the camera and Files, Android its picker.
 * A PDF bill is accepted too; the upload page checks the format against the server's list as for any file. */
export const galleryAccept = 'image/*,.heic,.heif,application/pdf'

/** The one hand-over of both sources: on the open upload page the file is taken there; otherwise the page opens
 * and sends it by itself, exactly like a shot of the camera. */
export function handOver(file: File) {
  if (!setQuickShot(file)) navigate('/receipts/upload')
}
