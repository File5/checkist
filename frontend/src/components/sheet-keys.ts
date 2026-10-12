/** What a key pressed inside an open sheet does: Esc closes it, Tab and Shift+Tab go round its own controls. */
export type SheetKeyAction = { kind: 'close' } | { kind: 'focus'; index: number } | null

/** Everything a person can reach with Tab inside the sheet, in the order of the page. */
export const SHEET_FOCUSABLE = [
  'a[href]', 'button:not([disabled])', 'input:not([disabled]):not([type="hidden"])', 'select:not([disabled])',
  'textarea:not([disabled])', 'summary', '[tabindex]:not([tabindex="-1"])',
].join(', ')

/**
 * The focus trap of the sheet without a browser. `current` is the index of the focused control among `count`
 * reachable ones, -1 when the focus stands elsewhere (the sheet itself, the page behind it).
 * `null` leaves the key to the browser: Tab between two controls inside needs no help.
 */
export function sheetKeyAction(key: string, shift: boolean, current: number, count: number): SheetKeyAction {
  if (key === 'Escape') return { kind: 'close' }
  if (key !== 'Tab') return null
  if (count === 0) return { kind: 'focus', index: -1 }
  if (current < 0 || current >= count) return { kind: 'focus', index: shift ? count - 1 : 0 }
  if (shift && current === 0) return { kind: 'focus', index: count - 1 }
  if (!shift && current === count - 1) return { kind: 'focus', index: 0 }
  return null
}

/**
 * Where the focus goes when the sheet closes: back to the control that opened it, unless the person or the shell
 * has put it somewhere on purpose meanwhile (a link of the sheet led to another page and the shell focused its
 * heading). Only a focus that was inside the sheet or got lost (body, nothing) is given back.
 */
export function shouldReturnFocus(active: 'inside' | 'lost' | 'elsewhere', openerConnected: boolean): boolean {
  return openerConnected && active !== 'elsewhere'
}
