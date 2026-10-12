// The photo taken with «Снять чек» of the «＋» menu on any screen, waiting for the upload page that sends it by itself.
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
