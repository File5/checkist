// The photo taken with «Снять чек» of the «＋» menu on any screen, waiting for the upload page that sends it by itself.
let pending: File | undefined
export const setQuickShot = (file: File) => { pending = file }
export const peekQuickShot = () => pending
export const clearQuickShot = () => { pending = undefined }
